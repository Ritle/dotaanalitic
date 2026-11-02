-- Fixed-policy Elo has no fitted training run. Preserve its exact preregistered artifacts.
CREATE TABLE v1_model_artifacts (
  model_id uuid PRIMARY KEY REFERENCES prediction_model_versions(id),
  plan_fingerprint char(64) NOT NULL CHECK (plan_fingerprint ~ '^[a-f0-9]{64}$'),
  candidate_fingerprint char(64) NOT NULL CHECK (candidate_fingerprint ~ '^[a-f0-9]{64}$'),
  freeze_fingerprint char(64) NOT NULL UNIQUE CHECK (freeze_fingerprint ~ '^[a-f0-9]{64}$'),
  plan_text text NOT NULL CHECK (octet_length(plan_text) BETWEEN 1 AND 4194304),
  candidate_text text NOT NULL CHECK (octet_length(candidate_text) BETWEEN 1 AND 4194304),
  freeze_text text NOT NULL CHECK (octet_length(freeze_text) BETWEEN 1 AND 4194304),
  plan_sha256 char(64) NOT NULL CHECK (plan_sha256 = encode(sha256(convert_to(plan_text,'UTF8')),'hex')),
  candidate_sha256 char(64) NOT NULL CHECK (candidate_sha256 = encode(sha256(convert_to(candidate_text,'UTF8')),'hex')),
  freeze_sha256 char(64) NOT NULL UNIQUE CHECK (freeze_sha256 = encode(sha256(convert_to(freeze_text,'UTF8')),'hex')),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (coalesce(plan_text::jsonb->>'fingerprint','') = plan_fingerprint),
  CHECK (coalesce(candidate_text::jsonb->>'fingerprint','') = candidate_fingerprint),
  CHECK (coalesce(freeze_text::jsonb->>'fingerprint','') = freeze_fingerprint),
  CHECK (coalesce(plan_text::jsonb->>'format','') = 'v1-release-plan-v1'),
  CHECK (coalesce(candidate_text::jsonb->>'format','') = 'v1-fixed-elo-candidate-v1'),
  CHECK (coalesce(freeze_text::jsonb->>'format','') = 'v1-release-executable-freeze-v1'),
  CHECK (coalesce(plan_text::jsonb->>'syntheticOnly','') = 'false'),
  CHECK (coalesce(candidate_text::jsonb->'registration'->>'syntheticOnly','') = 'false'),
  CHECK (coalesce(freeze_text::jsonb->>'planSha256','') = plan_sha256),
  CHECK (coalesce(freeze_text::jsonb->>'candidateSha256','') = candidate_sha256),
  CHECK (coalesce((freeze_text::jsonb->>'complete')::boolean,false)),
  CHECK (coalesce((freeze_text::jsonb->>'syntheticOnly')::boolean,true) = false)
);
CREATE TRIGGER trg_v1_artifacts_immutable BEFORE UPDATE OR DELETE ON v1_model_artifacts
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_v1_artifacts_no_truncate BEFORE TRUNCATE ON v1_model_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();

CREATE FUNCTION validate_v1_artifact_model() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m prediction_model_versions%ROWTYPE;
BEGIN
  SELECT * INTO m FROM prediction_model_versions WHERE id=NEW.model_id FOR UPDATE;
  IF m.stage IS DISTINCT FROM 'pre_match' OR m.algorithm IS DISTINCT FROM 'fixed_player_mean_elo'
    OR m.is_active OR m.artifact_sha256 IS DISTINCT FROM NEW.candidate_sha256 OR m.training_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'registry_model_binding';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_v1_artifact_model BEFORE INSERT ON v1_model_artifacts
  FOR EACH ROW EXECUTE FUNCTION validate_v1_artifact_model();

ALTER TABLE model_activation_events
  ADD COLUMN registry_sequence bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN v1_request_id uuid UNIQUE,
  ADD COLUMN v1_request_hash char(64),
  ADD COLUMN v1_plan_fingerprint char(64),
  ADD COLUMN v1_release_revision integer,
  ADD COLUMN v1_report_sha256 char(64),
  ADD FOREIGN KEY (v1_plan_fingerprint,v1_release_revision,v1_report_sha256)
    REFERENCES v1_release_evaluation_journal(plan_fingerprint,revision,report_sha256);
ALTER TABLE model_activation_events DROP CONSTRAINT model_activation_events_check;
ALTER TABLE model_activation_events ADD CONSTRAINT model_activation_promotion_evidence CHECK (
  event_type <> 'promote' OR (activated_model_id IS NOT NULL AND
    (supporting_evaluation_id IS NOT NULL OR v1_plan_fingerprint IS NOT NULL)));
ALTER TABLE model_activation_events ADD CONSTRAINT v1_transition_fields CHECK (
  (v1_request_id IS NULL AND v1_request_hash IS NULL AND v1_plan_fingerprint IS NULL AND v1_release_revision IS NULL AND v1_report_sha256 IS NULL)
  OR (v1_request_id IS NOT NULL AND v1_request_hash IS NOT NULL AND v1_request_hash ~ '^[a-f0-9]{64}$'
    AND supporting_evaluation_id IS NULL AND stage='pre_match' AND actor='owner' AND length(btrim(reason)) BETWEEN 10 AND 1000
    AND ((event_type='deactivate' AND previous_model_id IS NOT NULL AND activated_model_id IS NULL
      AND v1_plan_fingerprint IS NULL AND v1_release_revision IS NULL AND v1_report_sha256 IS NULL)
    OR (event_type IN ('promote','rollback') AND activated_model_id IS NOT NULL AND v1_plan_fingerprint IS NOT NULL
      AND v1_release_revision IS NOT NULL AND v1_report_sha256 IS NOT NULL))));
CREATE TRIGGER trg_activation_no_truncate BEFORE TRUNCATE ON model_activation_events
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();

-- Extend the existing trigger; preserve the original fitted-model branch.
CREATE OR REPLACE FUNCTION validate_model_activation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE model_stage text; artifact_hash char(64); candidate_eval uuid; eval_status text; previous_stage text;
  current_id uuid; a v1_model_artifacts%ROWTYPE; j v1_release_evaluation_journal%ROWTYPE; report jsonb; capture jsonb;
BEGIN
  IF NEW.v1_request_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0));
    SELECT id INTO current_id FROM prediction_model_versions WHERE stage='pre_match' AND is_active FOR UPDATE;
    IF current_id IS DISTINCT FROM NEW.previous_model_id THEN RAISE EXCEPTION 'registry_current_changed'; END IF;
    IF NEW.event_type <> 'deactivate' THEN
      SELECT * INTO a FROM v1_model_artifacts WHERE model_id=NEW.activated_model_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'registry_model_missing'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('v1-release-evaluation:' || NEW.v1_plan_fingerprint,0));
      SELECT * INTO j FROM v1_release_evaluation_journal WHERE plan_fingerprint=NEW.v1_plan_fingerprint ORDER BY revision DESC LIMIT 1;
      report := j.report_text::jsonb->'report'; capture := j.capture_text::jsonb;
      IF j.revision IS DISTINCT FROM NEW.v1_release_revision OR j.report_sha256 IS DISTINCT FROM NEW.v1_report_sha256
        OR j.plan_fingerprint IS DISTINCT FROM a.plan_fingerprint OR j.plan_sha256 IS DISTINCT FROM a.plan_sha256
        OR report->>'format' IS DISTINCT FROM 'v1-release-evaluation-v2'
        OR report->>'candidateFingerprint' IS DISTINCT FROM a.candidate_fingerprint
        OR report->>'freezeFingerprint' IS DISTINCT FROM a.freeze_fingerprint
        OR report->>'freezeSha256' IS DISTINCT FROM a.freeze_sha256
        OR report->>'releaseGatePassed' IS DISTINCT FROM 'true'
        OR report->'evaluation'->>'status' IS DISTINCT FROM 'evaluation_complete'
        OR report->'evaluation'->>'qualityDecision' IS DISTINCT FROM 'passed'
        OR report->'evaluation'->>'syntheticOnly' IS DISTINCT FROM 'false'
        OR capture->'inventory'->'source'->>'syntheticOnly' IS DISTINCT FROM 'false'
        OR capture->'executableFreeze' IS DISTINCT FROM a.freeze_text::jsonb
        OR report->'scorerCode' IS DISTINCT FROM a.freeze_text::jsonb->'code'
        OR clock_timestamp() < (a.freeze_text::jsonb->>'evaluateNotBefore')::timestamptz
        OR j.recorded_at < (a.freeze_text::jsonb->>'evaluateNotBefore')::timestamptz OR j.recorded_at > clock_timestamp()
      THEN RAISE EXCEPTION 'registry_release_not_eligible'; END IF;
      IF NEW.event_type='rollback' AND NOT EXISTS (SELECT 1 FROM model_activation_events WHERE activated_model_id=NEW.activated_model_id)
        THEN RAISE EXCEPTION 'registry_rollback_target'; END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM v1_model_artifacts WHERE model_id=NEW.previous_model_id) THEN
      RAISE EXCEPTION 'registry_model_missing';
    END IF;
    -- Transition and audit insert share one transaction; any later failure restores the champion.
    UPDATE prediction_model_versions SET is_active=false WHERE id=current_id;
    UPDATE prediction_model_versions SET is_active=true WHERE id=NEW.activated_model_id;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM v1_model_artifacts WHERE model_id IN (NEW.activated_model_id,NEW.previous_model_id)) THEN
    RAISE EXCEPTION 'registry_v1_evidence_required';
  END IF;
  IF NEW.previous_model_id IS NOT NULL THEN
    SELECT stage INTO previous_stage FROM prediction_model_versions WHERE id=NEW.previous_model_id;
    IF previous_stage IS DISTINCT FROM NEW.stage THEN RAISE EXCEPTION 'Previous model stage differs from activation event stage' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.activated_model_id IS NOT NULL THEN
    SELECT stage,artifact_sha256 INTO model_stage,artifact_hash FROM prediction_model_versions WHERE id=NEW.activated_model_id;
    IF model_stage IS DISTINCT FROM NEW.stage OR artifact_hash IS NULL THEN RAISE EXCEPTION 'Activation model must match stage and include artifact SHA256' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.event_type='deactivate' AND NEW.activated_model_id IS NOT NULL THEN RAISE EXCEPTION 'Deactivation cannot specify a newly active model' USING ERRCODE='23514'; END IF;
  IF NEW.event_type='rollback' AND (NEW.activated_model_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM model_activation_events WHERE activated_model_id=NEW.activated_model_id AND event_type IN ('promote','rollback')))
    THEN RAISE EXCEPTION 'Rollback must select a previously activated model' USING ERRCODE='23514'; END IF;
  IF NEW.event_type='promote' THEN
    SELECT candidate_model_id,status INTO candidate_eval,eval_status FROM model_evaluation_runs WHERE id=NEW.supporting_evaluation_id;
    IF candidate_eval IS DISTINCT FROM NEW.activated_model_id OR eval_status IS DISTINCT FROM 'passed'
      THEN RAISE EXCEPTION 'Promoted model requires its own passed evaluation' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_v1_model_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM v1_model_artifacts WHERE model_id=OLD.id) AND
    (TG_OP='DELETE' OR (to_jsonb(OLD)-'is_active') IS DISTINCT FROM (to_jsonb(NEW)-'is_active')) THEN
    RAISE EXCEPTION 'registry_model_immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER trg_v1_model_metadata BEFORE UPDATE OR DELETE ON prediction_model_versions
  FOR EACH ROW EXECUTE FUNCTION guard_v1_model_metadata();
CREATE FUNCTION validate_v1_active_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest_id uuid; active boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM v1_model_artifacts WHERE model_id=NEW.id) THEN
    SELECT activated_model_id INTO latest_id FROM model_activation_events WHERE stage='pre_match' ORDER BY registry_sequence DESC LIMIT 1;
    SELECT is_active INTO active FROM prediction_model_versions WHERE id=NEW.id;
    IF active IS DISTINCT FROM (latest_id IS NOT DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'registry_active_audit_required'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_v1_active_audit AFTER INSERT OR UPDATE ON prediction_model_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_v1_active_audit();
