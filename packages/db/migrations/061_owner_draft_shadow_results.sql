-- Private research calculation and a separate, post-commit visibility receipt.
CREATE TABLE owner_draft_shadow_runs (
 id UUID PRIMARY KEY,
 capture_id UUID NOT NULL UNIQUE REFERENCES owner_draft_captures(id),
 owner_user_id UUID NOT NULL REFERENCES app_users(id),
 result_text TEXT NOT NULL CHECK(octet_length(result_text)<=16777216),
 result_sha256 TEXT NOT NULL CHECK(result_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 writer_txid TEXT NOT NULL
);
CREATE FUNCTION guard_owner_draft_shadow_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r JSONB; c owner_draft_captures%ROWTYPE; o owner_draft_history_observations%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Draft shadow results are immutable' USING ERRCODE='55000'; END IF;
 NEW.recorded_at:=clock_timestamp();NEW.writer_txid:=txid_current()::text;r:=NEW.result_text::jsonb;
 SELECT * INTO c FROM owner_draft_captures WHERE id=NEW.capture_id;
 SELECT h.* INTO o FROM owner_draft_history_links l JOIN owner_draft_history_observations h ON h.id=l.observation_id WHERE l.capture_id=c.id;
 IF c.id IS NULL OR c.owner_user_id<>NEW.owner_user_id OR c.recorded_at>=transaction_timestamp()
   OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active AND account_role='owner')
   OR r->>'format' IS DISTINCT FROM 'owner-draft-shadow-result-v1'
   OR r->'capture'->>'id' IS DISTINCT FROM c.id::text OR r->'capture'->>'sha256' IS DISTINCT FROM c.snapshot_sha256
   OR (o.id IS NULL AND r->'observation' IS DISTINCT FROM 'null'::jsonb)
   OR (o.id IS NOT NULL AND (r->'observation'->>'id' IS DISTINCT FROM o.id::text OR r->'observation'->>'sha256' IS DISTINCT FROM o.evidence_sha256))
   OR r->>'featurePolicy' IS DISTINCT FROM 'selected-ten-and-known-series-exclusion-v1'
   OR coalesce(r->>'implementationSha256','') !~ '^[a-f0-9]{64}$'
   OR coalesce(r->>'calculatedAt','')='' OR (r->>'calculatedAt')::timestamptz<transaction_timestamp()
   OR (r->>'calculatedAt')::timestamptz>NEW.recorded_at
   OR r->>'primaryEligible' IS DISTINCT FROM 'false' OR r->>'deployable' IS DISTINCT FROM 'false'
   OR r->>'trainingPerformed' IS DISTINCT FROM 'false' OR r->>'forecastStatus' IS DISTINCT FROM 'unavailable'
   OR r->'teamAWinProbability' IS DISTINCT FROM 'null'::jsonb
   OR coalesce(r->>'syntheticOnly','') NOT IN ('true','false')
   OR coalesce(r->>'status','') NOT IN ('computed_shadow_only','unavailable')
   OR (r->>'status'='computed_shadow_only' AND (jsonb_typeof(r->'researchScores') IS DISTINCT FROM 'object'
     OR jsonb_typeof(r->'features'->'inputs') IS DISTINCT FROM 'object' OR jsonb_typeof(r->'candidate') IS DISTINCT FROM 'object'
     OR r->'reasons' IS DISTINCT FROM '[]'::jsonb))
   OR (r->>'status'='unavailable' AND (r->'researchScores' IS DISTINCT FROM 'null'::jsonb OR jsonb_array_length(r->'reasons')<1))
   OR (r->'candidate' IS DISTINCT FROM 'null'::jsonb AND
     encode(sha256(convert_to(r->'candidate'->>'artifactText','UTF8')),'hex') IS DISTINCT FROM r->'candidate'->>'sha256')
   OR encode(sha256(convert_to(NEW.result_text,'UTF8')),'hex')<>NEW.result_sha256
 THEN RAISE EXCEPTION 'draft_shadow_result_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER owner_draft_shadow_run_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_draft_shadow_runs
 FOR EACH ROW EXECUTE FUNCTION guard_owner_draft_shadow_run();
CREATE TRIGGER owner_draft_shadow_run_no_truncate BEFORE TRUNCATE ON owner_draft_shadow_runs
 FOR EACH STATEMENT EXECUTE FUNCTION guard_owner_draft_shadow_run();

CREATE TABLE owner_draft_shadow_receipts (
 run_id UUID PRIMARY KEY REFERENCES owner_draft_shadow_runs(id),
 result_sha256 TEXT NOT NULL,
 observed_committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 observer_txid TEXT NOT NULL
);
CREATE FUNCTION guard_owner_draft_shadow_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r owner_draft_shadow_runs%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Draft shadow receipts are immutable' USING ERRCODE='55000'; END IF;
 NEW.observed_committed_at:=clock_timestamp();NEW.observer_txid:=txid_current()::text;
 SELECT * INTO r FROM owner_draft_shadow_runs WHERE id=NEW.run_id;
 -- MVCC visibility plus a different top-level transaction proves the result was committed.
 -- txid_current() also covers subtransactions/savepoints; xmin alone does not.
 IF r.id IS NULL OR r.writer_txid=NEW.observer_txid OR r.result_sha256 IS DISTINCT FROM NEW.result_sha256
   OR NEW.observed_committed_at<r.recorded_at
 THEN RAISE EXCEPTION 'draft_shadow_commit_not_observed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER owner_draft_shadow_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_draft_shadow_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_owner_draft_shadow_receipt();
CREATE TRIGGER owner_draft_shadow_receipt_no_truncate BEFORE TRUNCATE ON owner_draft_shadow_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION guard_owner_draft_shadow_receipt();
