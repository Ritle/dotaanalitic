-- P0 architecture for verified labels, frozen training datasets and auditable model lifecycle.
-- Actual collectors/trainers/schedulers are implemented in subsequent Codex tasks.
-- Earlier migrations 001..004 are immutable; this file is additive.

CREATE TABLE training_dataset_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stage TEXT NOT NULL CHECK (stage IN ('pre_match','post_draft')),
    status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','frozen','rejected')),
    feature_schema_version TEXT NOT NULL,
    label_policy_version TEXT NOT NULL,
    cutoff_policy_version TEXT NOT NULL,
    patch_registry_revision TEXT NOT NULL,
    data_revision TEXT NOT NULL,
    code_revision TEXT NOT NULL,
    split_policy JSONB NOT NULL,
    source_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    dataset_fingerprint CHAR(64),
    frozen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status <> 'frozen' OR (frozen_at IS NOT NULL AND dataset_fingerprint IS NOT NULL))
);
CREATE UNIQUE INDEX uq_frozen_training_dataset_fingerprint
    ON training_dataset_versions(stage,dataset_fingerprint)
    WHERE status = 'frozen';

-- Exactly one verified canonical pro map per dataset version; user predictions are NOT training labels.
-- dataset_version.stage separates pre-match from post-draft examples.
CREATE TABLE training_dataset_maps (
    dataset_version_id UUID NOT NULL REFERENCES training_dataset_versions(id),
    match_id BIGINT NOT NULL REFERENCES matches(id),
    split TEXT NOT NULL CHECK (split IN ('train','calibration','validation','test')),
    team_a_id BIGINT NOT NULL REFERENCES teams(id),
    team_b_id BIGINT NOT NULL REFERENCES teams(id),
    cutoff_at TIMESTAMPTZ NOT NULL,
    input_features JSONB NOT NULL,
    input_hash CHAR(64) NOT NULL,
    team_a_won BOOLEAN NOT NULL,
    label_source TEXT NOT NULL,
    label_verified_at TIMESTAMPTZ NOT NULL,
    source_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (dataset_version_id,match_id),
    CHECK (team_a_id <> team_b_id)
);
CREATE INDEX idx_training_maps_match ON training_dataset_maps(match_id);
CREATE INDEX idx_training_maps_dataset_split ON training_dataset_maps(dataset_version_id,split);

-- Frozen datasets cannot be edited, removed, or silently corrected even after a provider backfill.
CREATE FUNCTION guard_training_dataset_version_frozen()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('frozen','rejected') THEN
        RAISE EXCEPTION 'Frozen training dataset % is immutable', OLD.id USING ERRCODE = '55000';
    END IF;
    RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER trg_training_dataset_version_frozen
    BEFORE UPDATE OR DELETE ON training_dataset_versions
    FOR EACH ROW EXECUTE FUNCTION guard_training_dataset_version_frozen();

CREATE FUNCTION validate_and_guard_training_dataset_map()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    parent_status TEXT;
    map_record matches%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT status INTO parent_status FROM training_dataset_versions
          WHERE id = OLD.dataset_version_id FOR SHARE;
        IF parent_status = 'frozen' THEN
            RAISE EXCEPTION 'Cannot delete a map from frozen training dataset' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    -- No moving example rows to another dataset (even if the target is still building).
    IF TG_OP = 'UPDATE' AND OLD.dataset_version_id IS DISTINCT FROM NEW.dataset_version_id THEN
        RAISE EXCEPTION 'Cannot reassign a training example to another dataset' USING ERRCODE = '55000';
    END IF;
    SELECT status INTO parent_status FROM training_dataset_versions
      WHERE id = NEW.dataset_version_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'building' THEN
        RAISE EXCEPTION 'Only building datasets accept example changes' USING ERRCODE = '55000';
    END IF;

    -- Excludes unverified/non-pro maps and any ambiguity in Team A/B vs Radiant/Dire.
    SELECT * INTO map_record FROM matches WHERE id = NEW.match_id;
    IF map_record.id IS NULL OR map_record.is_pro IS DISTINCT FROM TRUE
       OR map_record.duration_seconds IS NULL OR map_record.duration_seconds <= 0
       OR map_record.radiant_win IS NULL
       OR map_record.radiant_team_id IS NULL OR map_record.dire_team_id IS NULL
       OR NEW.cutoff_at IS DISTINCT FROM map_record.started_at
       OR NEW.label_verified_at <= map_record.started_at THEN
        RAISE EXCEPTION 'Dataset training target is not a verified pro map at cutoff' USING ERRCODE = '23514';
    END IF;
    IF NOT (
      (NEW.team_a_id = map_record.radiant_team_id AND NEW.team_b_id = map_record.dire_team_id
       AND NEW.team_a_won = map_record.radiant_win)
      OR
      (NEW.team_a_id = map_record.dire_team_id AND NEW.team_b_id = map_record.radiant_team_id
       AND NEW.team_a_won <> map_record.radiant_win)
    ) THEN
        RAISE EXCEPTION 'Wrong team-side orientation or outcome label' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_training_dataset_maps_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON training_dataset_maps
    FOR EACH ROW EXECUTE FUNCTION validate_and_guard_training_dataset_map();

CREATE TABLE model_training_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stage TEXT NOT NULL CHECK (stage IN ('pre_match','post_draft')),
    dataset_version_id UUID NOT NULL REFERENCES training_dataset_versions(id),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    algorithm TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    config_hash CHAR(64) NOT NULL,
    code_revision TEXT NOT NULL,
    random_seed INTEGER NOT NULL,
    idempotency_key TEXT UNIQUE,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX idx_training_runs_dataset ON model_training_runs(dataset_version_id,created_at DESC);
ALTER TABLE prediction_model_versions
    ADD COLUMN training_run_id UUID REFERENCES model_training_runs(id),
    ADD COLUMN artifact_sha256 CHAR(64);

-- Model evaluation is independent of training; a quality-gate pass is not implied by train success.
CREATE TABLE model_evaluation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_model_id UUID NOT NULL REFERENCES prediction_model_versions(id),
    evaluation_dataset_id UUID NOT NULL REFERENCES training_dataset_versions(id),
    status TEXT NOT NULL CHECK (status IN ('running','passed','failed','invalid')),
    evaluation_kind TEXT NOT NULL CHECK (evaluation_kind IN ('temporal_holdout','prospective_shadow')),
    gate_policy_version TEXT NOT NULL,
    compared_model_id UUID REFERENCES prediction_model_versions(id),
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    baseline_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    quality_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    evaluated_maps INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_maps >= 0),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status = 'running' OR completed_at IS NOT NULL)
);
CREATE INDEX idx_model_evaluations_candidate ON model_evaluation_runs(candidate_model_id,created_at DESC);

-- Promotion must be transactional: validate stage, artifact checksum, gate policy, expected current ID.
-- Default behaviour is manual approval; unattended autopro-mote is NOT enabled by migration.
CREATE TABLE model_activation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stage TEXT NOT NULL CHECK (stage IN ('pre_match','post_draft')),
    event_type TEXT NOT NULL CHECK (event_type IN ('promote','rollback','deactivate')),
    previous_model_id UUID REFERENCES prediction_model_versions(id),
    activated_model_id UUID REFERENCES prediction_model_versions(id),
    supporting_evaluation_id UUID REFERENCES model_evaluation_runs(id),
    actor TEXT NOT NULL CHECK (actor IN ('owner','verified_automation','system_recovery')),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (event_type <> 'promote' OR (activated_model_id IS NOT NULL AND supporting_evaluation_id IS NOT NULL)),
    CHECK (previous_model_id IS DISTINCT FROM activated_model_id)
);
CREATE INDEX idx_model_activation_stage ON model_activation_events(stage,created_at DESC);

-- Audit history must be append-only, and terminal evaluation evidence must be immutable.
CREATE FUNCTION guard_model_activation_event_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Model activation events are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_model_activation_event_immutable
    BEFORE UPDATE OR DELETE ON model_activation_events
    FOR EACH ROW EXECUTE FUNCTION guard_model_activation_event_immutable();

CREATE FUNCTION guard_terminal_model_evaluation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('passed','failed','invalid') THEN
        RAISE EXCEPTION 'Terminal model evaluation is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER trg_terminal_model_evaluation
    BEFORE UPDATE OR DELETE ON model_evaluation_runs
    FOR EACH ROW EXECUTE FUNCTION guard_terminal_model_evaluation();

-- Cross-table stage/readiness checks at the durable boundary (not just application DTO).
CREATE FUNCTION validate_model_training_stage()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE ds_stage TEXT; ds_status TEXT;
BEGIN
    SELECT stage,status INTO ds_stage,ds_status
      FROM training_dataset_versions WHERE id = NEW.dataset_version_id;
    IF ds_stage IS DISTINCT FROM NEW.stage OR ds_status IS DISTINCT FROM 'frozen' THEN
        RAISE EXCEPTION 'Training run requires a frozen dataset of matching stage'
          USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_model_training_stage
    BEFORE INSERT OR UPDATE OF dataset_version_id,stage ON model_training_runs
    FOR EACH ROW EXECUTE FUNCTION validate_model_training_stage();

CREATE FUNCTION validate_model_evaluation_stage()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE candidate_stage TEXT; ds_stage TEXT; ds_status TEXT;
BEGIN
    SELECT stage INTO candidate_stage FROM prediction_model_versions
      WHERE id = NEW.candidate_model_id;
    SELECT stage,status INTO ds_stage,ds_status FROM training_dataset_versions
      WHERE id = NEW.evaluation_dataset_id;
    IF candidate_stage IS DISTINCT FROM ds_stage OR ds_status IS DISTINCT FROM 'frozen' THEN
        RAISE EXCEPTION 'Evaluation requires matching model/dataset stage and frozen dataset'
          USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_model_evaluation_stage
    BEFORE INSERT OR UPDATE OF candidate_model_id,evaluation_dataset_id ON model_evaluation_runs
    FOR EACH ROW EXECUTE FUNCTION validate_model_evaluation_stage();

CREATE FUNCTION validate_model_activation_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE model_stage TEXT; artifact_hash CHAR(64);
        candidate_eval UUID; eval_status TEXT;
        previous_stage TEXT;
BEGIN
    IF NEW.previous_model_id IS NOT NULL THEN
        SELECT stage INTO previous_stage FROM prediction_model_versions
          WHERE id = NEW.previous_model_id;
        IF previous_stage IS DISTINCT FROM NEW.stage THEN
            RAISE EXCEPTION 'Previous model stage differs from activation event stage'
              USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.activated_model_id IS NOT NULL THEN
        SELECT stage,artifact_sha256 INTO model_stage,artifact_hash
          FROM prediction_model_versions WHERE id = NEW.activated_model_id;
        IF model_stage IS DISTINCT FROM NEW.stage OR artifact_hash IS NULL THEN
            RAISE EXCEPTION 'Activation model must match stage and include artifact SHA256'
              USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.event_type = 'deactivate' AND NEW.activated_model_id IS NOT NULL THEN
        RAISE EXCEPTION 'Deactivation cannot specify a newly active model'
          USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'rollback' THEN
        IF NEW.activated_model_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM model_activation_events ae
            WHERE ae.activated_model_id = NEW.activated_model_id
              AND ae.event_type IN ('promote','rollback')
        ) THEN
            RAISE EXCEPTION 'Rollback must select a previously activated model'
              USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.event_type = 'promote' THEN
        SELECT candidate_model_id,status INTO candidate_eval,eval_status
          FROM model_evaluation_runs WHERE id = NEW.supporting_evaluation_id;
        IF candidate_eval IS DISTINCT FROM NEW.activated_model_id OR eval_status IS DISTINCT FROM 'passed' THEN
            RAISE EXCEPTION 'Promoted model requires its own passed evaluation'
              USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_model_activation_evidence
    BEFORE INSERT ON model_activation_events
    FOR EACH ROW EXECUTE FUNCTION validate_model_activation_evidence();
