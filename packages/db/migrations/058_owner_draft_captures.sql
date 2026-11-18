-- Capture-only owner evidence. No model, prediction or training registration.
CREATE TABLE owner_draft_captures (
 id UUID PRIMARY KEY,
 owner_user_id UUID NOT NULL REFERENCES app_users(id),
 scenario_id UUID NOT NULL,
 revision INTEGER NOT NULL,
 snapshot_text TEXT NOT NULL CHECK(octet_length(snapshot_text)<=33554432),
 snapshot_sha256 TEXT NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 decision_cutoff_at TIMESTAMPTZ NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(scenario_id,revision) REFERENCES scenario_input_snapshots(scenario_id,revision),
 UNIQUE(owner_user_id,scenario_id,revision)
);
CREATE FUNCTION guard_owner_draft_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s JSONB; p scenario_input_snapshots%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Draft captures are immutable' USING ERRCODE='55000'; END IF;
 NEW.recorded_at:=clock_timestamp();
 s:=NEW.snapshot_text::jsonb;
 SELECT * INTO p FROM scenario_input_snapshots WHERE scenario_id=NEW.scenario_id AND revision=NEW.revision;
 IF NOT EXISTS(SELECT 1 FROM scenarios sc JOIN app_users u ON u.id=sc.owner_user_id
   WHERE sc.id=NEW.scenario_id AND sc.owner_user_id=NEW.owner_user_id AND sc.revision=NEW.revision AND u.is_active AND u.account_role='owner')
   OR s->>'format' IS DISTINCT FROM 'owner-draft-capture-v1'
   OR s->>'scenarioId' IS DISTINCT FROM NEW.scenario_id::text
   OR s->>'revision' IS DISTINCT FROM NEW.revision::text
   OR s->>'scenarioHash' IS DISTINCT FROM p.input_hash
   OR s->'scenario' IS DISTINCT FROM p.input_snapshot
   OR (s->>'scenarioRecordedAt')::timestamptz IS DISTINCT FROM p.recorded_at
   OR (s->>'decisionCutoffAt')::timestamptz IS DISTINCT FROM NEW.decision_cutoff_at
   OR NEW.decision_cutoff_at<p.recorded_at OR NEW.decision_cutoff_at>NEW.recorded_at
   OR NEW.decision_cutoff_at<transaction_timestamp()
   OR s->>'primaryEligible' IS DISTINCT FROM 'false' OR s->>'deployable' IS DISTINCT FROM 'false'
   OR s->>'scoringPerformed' IS DISTINCT FROM 'false'
   OR encode(sha256(convert_to(NEW.snapshot_text,'UTF8')),'hex')<>NEW.snapshot_sha256
 THEN RAISE EXCEPTION 'draft_capture_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER owner_draft_capture_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_draft_captures
 FOR EACH ROW EXECUTE FUNCTION guard_owner_draft_capture();
