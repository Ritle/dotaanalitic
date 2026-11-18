-- Append-only retrospective verification, independent of the original capture and model gates.
CREATE TABLE owner_draft_native_bindings (
 id UUID PRIMARY KEY,
 owner_user_id UUID NOT NULL REFERENCES app_users(id),
 capture_id UUID NOT NULL REFERENCES owner_draft_captures(id),
 requested_match_id BIGINT NOT NULL CHECK(requested_match_id>0),
 status TEXT NOT NULL CHECK(status IN ('verified','unavailable')),
 evidence_text TEXT NOT NULL CHECK(octet_length(evidence_text)<=2097152),
 evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 inspected_at TIMESTAMPTZ NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX owner_draft_native_one_verified ON owner_draft_native_bindings(capture_id) WHERE status='verified';
CREATE INDEX owner_draft_native_attempts ON owner_draft_native_bindings(owner_user_id,capture_id,recorded_at DESC,id);
CREATE FUNCTION guard_owner_draft_native_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE e JSONB; r JSONB; c owner_draft_captures%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Draft native bindings are immutable' USING ERRCODE='55000'; END IF;
 NEW.recorded_at:=clock_timestamp();
 e:=NEW.evidence_text::jsonb; r:=e->'result';
 SELECT * INTO c FROM owner_draft_captures WHERE id=NEW.capture_id;
 IF c.id IS NULL OR c.owner_user_id IS DISTINCT FROM NEW.owner_user_id
   OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active AND account_role='owner')
   OR e->>'format' IS DISTINCT FROM 'owner-draft-native-evidence-v1'
   OR r->>'format' IS DISTINCT FROM 'owner-draft-native-binding-v1'
   OR r->>'captureId' IS DISTINCT FROM c.id::text OR r->>'captureSha256' IS DISTINCT FROM c.snapshot_sha256
   OR r->>'matchId' IS DISTINCT FROM NEW.requested_match_id::text OR r->>'status' IS DISTINCT FROM NEW.status
   OR (r->>'inspectedAt')::timestamptz IS DISTINCT FROM NEW.inspected_at
   OR NEW.inspected_at<c.recorded_at OR NEW.inspected_at<transaction_timestamp() OR NEW.inspected_at>NEW.recorded_at
   OR r->>'selectionSource' IS DISTINCT FROM 'owner_native_map_id'
   OR r->>'scheduleMappingVerified' IS DISTINCT FROM 'false' OR r->>'mapOrdinalVerified' IS DISTINCT FROM 'false'
   OR r->>'prestartVerified' IS DISTINCT FROM 'false' OR r->>'primaryEligible' IS DISTINCT FROM 'false' OR r->>'deployable' IS DISTINCT FROM 'false'
   OR (NEW.status='verified' AND (e->'candidate'->>'matchId' IS DISTINCT FROM NEW.requested_match_id::text OR r->'reasons' IS DISTINCT FROM '[]'::jsonb))
   OR encode(sha256(convert_to(NEW.evidence_text,'UTF8')),'hex')<>NEW.evidence_sha256
 THEN RAISE EXCEPTION 'draft_native_binding_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER owner_draft_native_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_draft_native_bindings
 FOR EACH ROW EXECUTE FUNCTION guard_owner_draft_native_binding();
