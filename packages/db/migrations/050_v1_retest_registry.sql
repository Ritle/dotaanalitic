-- Retrospective retest evidence has its own version. Do not relabel it as a prospective release.
CREATE TABLE v1_retest_model_artifacts (
  model_id uuid PRIMARY KEY REFERENCES prediction_model_versions(id),
  protocol_fingerprint char(64) NOT NULL UNIQUE CHECK (protocol_fingerprint ~ '^[a-f0-9]{64}$'),
  freeze_fingerprint char(64) NOT NULL UNIQUE CHECK (freeze_fingerprint ~ '^[a-f0-9]{64}$'),
  report_fingerprint char(64) NOT NULL UNIQUE CHECK (report_fingerprint ~ '^[a-f0-9]{64}$'),
  capsule_text text NOT NULL CHECK (octet_length(capsule_text) BETWEEN 2 AND 268435456),
  freeze_text text NOT NULL CHECK (octet_length(freeze_text) BETWEEN 2 AND 4194304),
  started_text text NOT NULL CHECK (octet_length(started_text) BETWEEN 2 AND 65536),
  report_text text NOT NULL CHECK (octet_length(report_text) BETWEEN 2 AND 134217728),
  binding_text text NOT NULL CHECK (octet_length(binding_text) BETWEEN 2 AND 4194304),
  capsule_sha256 char(64) NOT NULL CHECK (capsule_sha256 = encode(sha256(convert_to(capsule_text,'UTF8')),'hex')),
  freeze_sha256 char(64) NOT NULL UNIQUE CHECK (freeze_sha256 = encode(sha256(convert_to(freeze_text,'UTF8')),'hex')),
  started_sha256 char(64) NOT NULL CHECK (started_sha256 = encode(sha256(convert_to(started_text,'UTF8')),'hex')),
  report_sha256 char(64) NOT NULL UNIQUE CHECK (report_sha256 = encode(sha256(convert_to(report_text,'UTF8')),'hex')),
  binding_sha256 char(64) NOT NULL CHECK (binding_sha256 = encode(sha256(convert_to(binding_text,'UTF8')),'hex')),
  metadata jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (coalesce(capsule_text::jsonb->>'format','') = 'v1-retest-execution-input-v2'),
  CHECK (coalesce(freeze_text::jsonb->>'format','') = 'v1-retest-executable-freeze-v2'),
  CHECK (coalesce(started_text::jsonb->>'format','') = 'v1-retest-first-scoring-v2'),
  CHECK (coalesce(report_text::jsonb->>'format','') = 'v1-retest-evaluation-v2'),
  CHECK (coalesce(binding_text::jsonb->>'format','') = 'v1-retest-registry-binding-v2'),
  CHECK (coalesce(freeze_text::jsonb->>'syntheticOnly','') = 'false'),
  CHECK (coalesce(report_text::jsonb->>'syntheticOnly','') = 'false'),
  CHECK (coalesce(report_text::jsonb->>'qualityDecision','') = 'passed'),
  CHECK (coalesce(report_text::jsonb->>'releaseGatePassed','') = 'true'),
  CHECK (coalesce(binding_text::jsonb->>'eligibleForActivation','') = 'true'),
  CHECK (coalesce(metadata->>'stage','') = 'pre_match'),
  CHECK (coalesce(metadata->>'evaluationBasis','') = 'conditional_retrospective_unexposed_series'),
  CHECK (coalesce(metadata->>'syntheticOnly','') = 'false'),
  CHECK (coalesce(metadata->>'isActive','') = 'false'),
  CHECK (coalesce(metadata->>'deployable','') = 'false'),
  CHECK (coalesce(metadata->>'qualityDecision','') = 'passed'),
  CHECK (coalesce(metadata->>'protocolFingerprint','') = protocol_fingerprint),
  CHECK (coalesce(metadata->>'freezeFingerprint','') = freeze_fingerprint),
  CHECK (coalesce(metadata->>'reportFingerprint','') = report_fingerprint),
  CHECK (coalesce(freeze_text::jsonb->>'fingerprint','') = freeze_fingerprint),
  CHECK (coalesce(report_text::jsonb->>'fingerprint','') = report_fingerprint),
  CHECK (coalesce(freeze_text::jsonb->>'capsuleSha256','') = capsule_sha256),
  CHECK (coalesce(report_text::jsonb->>'freezeSha256','') = freeze_sha256),
  CHECK (coalesce(binding_text::jsonb->>'evaluationFingerprint','') = report_fingerprint),
  CHECK (coalesce(report_text::jsonb->'firstScoring','{}'::jsonb) = started_text::jsonb),
  CHECK (coalesce((metadata->>'registeredAt')::timestamptz <= (metadata->>'firstScoringAt')::timestamptz,false)),
  CHECK (coalesce((metadata->>'firstScoringAt')::timestamptz <= registered_at,false))
);
CREATE TRIGGER trg_retest_artifacts_immutable BEFORE UPDATE OR DELETE ON v1_retest_model_artifacts
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_retest_artifacts_no_truncate BEFORE TRUNCATE ON v1_retest_model_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE FUNCTION validate_retest_artifact_model() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m prediction_model_versions%ROWTYPE;
BEGIN
  SELECT * INTO m FROM prediction_model_versions WHERE id=NEW.model_id FOR UPDATE;
  IF m.stage IS DISTINCT FROM 'pre_match' OR m.algorithm IS DISTINCT FROM 'fixed_player_mean_elo'
    OR m.is_active OR m.artifact_sha256 IS DISTINCT FROM NEW.freeze_sha256 OR m.training_run_id IS NOT NULL
    OR m.artifact_uri IS DISTINCT FROM ('v1-retest-registry:' || NEW.model_id)
    OR m.dataset_fingerprint IS DISTINCT FROM NEW.metadata->>'datasetFingerprint'
    OR m.test_games IS DISTINCT FROM (NEW.metadata->>'scoredMaps')::integer THEN
    RAISE EXCEPTION 'retest_registry_model_binding';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_retest_artifact_model BEFORE INSERT ON v1_retest_model_artifacts
  FOR EACH ROW EXECUTE FUNCTION validate_retest_artifact_model();
-- This slice registers inactive candidates only. Existing activation paths cannot bypass that boundary.
CREATE FUNCTION guard_retest_model_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM v1_retest_model_artifacts WHERE model_id=OLD.id) THEN
    RAISE EXCEPTION 'retest_registry_model_immutable_activation_pending';
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER trg_retest_model_changes BEFORE UPDATE OR DELETE ON prediction_model_versions
  FOR EACH ROW EXECUTE FUNCTION guard_retest_model_changes();
CREATE FUNCTION guard_retest_activation_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM v1_retest_model_artifacts WHERE model_id IN (NEW.activated_model_id,NEW.previous_model_id)) THEN
    RAISE EXCEPTION 'retest_registry_activation_pending';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_aaa_retest_activation_pending BEFORE INSERT ON model_activation_events
  FOR EACH ROW EXECUTE FUNCTION guard_retest_activation_pending();
