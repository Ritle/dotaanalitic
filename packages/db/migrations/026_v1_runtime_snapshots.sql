-- Full precision is needed for favourites/metrics; do not round a value around 0.5.
ALTER TABLE prediction_runs ALTER COLUMN team_a_win_probability TYPE NUMERIC;
ALTER TABLE prediction_runs ADD COLUMN v1_request_id UUID, ADD COLUMN issued_at TIMESTAMPTZ;
CREATE TABLE v1_runtime_snapshots (
  prediction_id UUID PRIMARY KEY REFERENCES prediction_runs(id),
  owner_user_id UUID NOT NULL REFERENCES app_users(id),
  request_id UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_text TEXT NOT NULL CHECK (octet_length(snapshot_text) BETWEEN 1 AND 67108864),
  snapshot_sha256 CHAR(64) NOT NULL CHECK (snapshot_sha256=encode(sha256(convert_to(snapshot_text,'UTF8')),'hex')),
  UNIQUE(owner_user_id,request_id)
);
CREATE FUNCTION validate_v1_runtime_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p prediction_runs%ROWTYPE; s jsonb := NEW.snapshot_text::jsonb;
BEGIN
  SELECT * INTO p FROM prediction_runs WHERE id=NEW.prediction_id FOR SHARE;
  IF p.v1_request_id IS DISTINCT FROM NEW.request_id OR p.stage IS DISTINCT FROM 'pre_match'
    OR p.status NOT IN ('done','unavailable') OR p.status IS DISTINCT FROM s->>'status'
    OR s->>'format' IS DISTINCT FROM 'v1-runtime-snapshot-v1'
    OR s#>>'{request,purpose}' IS DISTINCT FROM 'what_if_single_map'
    OR s#>>'{request,requestId}' IS DISTINCT FROM NEW.request_id::text
    OR s#>>'{scenario,id}' IS DISTINCT FROM p.scenario_id::text
    OR s#>>'{scenario,revision}' IS DISTINCT FROM p.scenario_revision::text
    OR s#>>'{scenario,inputHash}' IS DISTINCT FROM btrim(p.input_hash)
    OR s#>'{scenario,input}' IS DISTINCT FROM p.input_snapshot
    OR (s->>'teamAWinProbability')::numeric IS DISTINCT FROM p.team_a_win_probability
    OR (s->>'issuedAt')::timestamptz IS DISTINCT FROM p.issued_at
    OR (s->>'createdAt')::timestamptz IS DISTINCT FROM p.created_at
    OR p.created_at>clock_timestamp() OR p.issued_at>clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM scenarios WHERE id=p.scenario_id AND owner_user_id=NEW.owner_user_id)
    OR NOT EXISTS (SELECT 1 FROM scenario_input_snapshots WHERE scenario_id=p.scenario_id
      AND revision=p.scenario_revision AND input_hash=p.input_hash AND input_snapshot=p.input_snapshot) THEN
    RAISE EXCEPTION 'runtime_snapshot_binding';
  END IF;
  IF p.status='done' AND (p.issued_at IS NULL OR p.issued_at<p.created_at OR
    (s#>>'{scenario,input,scheduledAt}')::timestamptz IS NULL OR
    p.issued_at>=(s#>>'{scenario,input,scheduledAt}')::timestamptz OR
    clock_timestamp()>=(s#>>'{scenario,input,scheduledAt}')::timestamptz OR
    s#>>'{gate,status}' IS DISTINCT FROM 'model_eligible' OR
    s#>>'{gate,modelId}' IS DISTINCT FROM p.model_version_id::text OR
    NOT EXISTS (SELECT 1 FROM prediction_model_versions m JOIN v1_model_artifacts a ON a.model_id=m.id
      WHERE m.id=p.model_version_id AND m.is_active AND a.candidate_sha256=s#>>'{gate,candidateSha256}'
        AND a.freeze_sha256=s#>>'{gate,freezeSha256}')) THEN
    RAISE EXCEPTION 'runtime_model_gate_required';
  END IF;
  IF p.status='done' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0));
    PERFORM pg_advisory_xact_lock(hashtextextended('v1-release-evaluation:'||(s#>>'{gate,planFingerprint}'),0));
    IF NOT EXISTS (SELECT 1 FROM model_activation_events e
      JOIN prediction_model_versions m ON m.id=e.activated_model_id
      JOIN v1_model_artifacts a ON a.model_id=m.id
      JOIN v1_release_evaluation_journal j ON j.plan_fingerprint=a.plan_fingerprint
      WHERE e.id::text=s#>>'{gate,activationEventId}' AND m.id=p.model_version_id AND m.is_active
        AND e.v1_request_id IS NOT NULL AND j.revision::text=s#>>'{gate,releaseRevision}'
        AND j.report_sha256=s#>>'{gate,reportSha256}' AND a.plan_fingerprint=s#>>'{gate,planFingerprint}'
        AND j.revision=(SELECT max(revision) FROM v1_release_evaluation_journal WHERE plan_fingerprint=a.plan_fingerprint)
        AND j.report_text::jsonb#>>'{report,releaseGatePassed}'='true'
        AND j.report_text::jsonb#>>'{report,evaluation,syntheticOnly}'='false') THEN
      RAISE EXCEPTION 'runtime_release_gate_required';
    END IF;
  END IF;
  IF p.status='unavailable' AND (p.issued_at IS NOT NULL OR p.team_a_win_probability IS NOT NULL) THEN
    RAISE EXCEPTION 'runtime_unavailable_probability';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_v1_runtime_validate BEFORE INSERT ON v1_runtime_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_v1_runtime_snapshot();
CREATE TRIGGER trg_v1_runtime_immutable BEFORE UPDATE OR DELETE ON v1_runtime_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_v1_runtime_no_truncate BEFORE TRUNCATE ON v1_runtime_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
-- The FK blocks deletion of a saved V1 prediction, including scenario cascades.
-- Existing terminal-update guard protects prediction_runs; FK blocks TRUNCATE without CASCADE,
-- and CASCADE reaches the immutable snapshot trigger.
