-- Owner convenience catalogue. This does not activate models or alter release/test scope.
CREATE TABLE owner_tier1_scopes (
 owner_user_id UUID NOT NULL REFERENCES app_users(id),scope_id UUID NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 request_id UUID NOT NULL,request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),enabled BOOLEAN NOT NULL,
 record_text TEXT NOT NULL CHECK(octet_length(record_text) BETWEEN 1 AND 32768),
 record_sha256 CHAR(64) NOT NULL CHECK(record_sha256=encode(sha256(convert_to(record_text,'UTF8')),'hex')),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_user_id,scope_id,revision),UNIQUE(owner_user_id,request_id)
);
CREATE FUNCTION validate_owner_tier1_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p owner_tier1_scopes%ROWTYPE; r jsonb:=NEW.record_text::jsonb; q jsonb:=r->'request'; s jsonb:=q->'scope';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('owner-tier1-scopes:'||NEW.owner_user_id::text,0));
 SELECT * INTO p FROM owner_tier1_scopes WHERE owner_user_id=NEW.owner_user_id AND scope_id=NEW.scope_id ORDER BY revision DESC LIMIT 1;
 IF r->>'format' IS DISTINCT FROM 'owner-tier1-scope-v1' OR q->>'scopeId' IS DISTINCT FROM NEW.scope_id::text
  OR q->>'requestId' IS DISTINCT FROM NEW.request_id::text OR r->>'revision' IS DISTINCT FROM NEW.revision::text
  OR NEW.revision<>coalesce(p.revision,0)+1 OR q->>'expectedRevision' IS DISTINCT FROM (NEW.revision-1)::text
  OR r->>'previousSha256' IS DISTINCT FROM p.record_sha256::text OR (q->>'enabled')::boolean IS DISTINCT FROM NEW.enabled
  OR s->>'provider' IS DISTINCT FROM 'opendota' OR s->>'tier' IS DISTINCT FROM '1' OR s->>'stage' IS DISTINCT FROM 'main_event'
  OR coalesce(s->>'leagueId','') !~ '^[1-9][0-9]{0,18}$' OR (s->>'leagueId')::numeric>9223372036854775807
  OR coalesce(length(trim(s->>'eventName')),0) NOT BETWEEN 1 AND 512
  OR coalesce(length(trim(s->>'rationale')),0) NOT BETWEEN 20 AND 2000 OR coalesce(s->>'sourceUrl','') !~ '^https://'
  OR s->>'fromAt' IS NULL OR s->>'until' IS NULL OR (s->>'fromAt')::timestamptz>=(s->>'until')::timestamptz
  OR (p.revision IS NOT NULL AND p.record_text::jsonb#>>'{request,scope,leagueId}' IS DISTINCT FROM s->>'leagueId')
  OR r->>'recordedAt' IS NULL OR (r->>'recordedAt')::timestamptz<transaction_timestamp()
  OR (r->>'recordedAt')::timestamptz>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active)
  THEN RAISE EXCEPTION 'tier1_scope_record_binding'; END IF;
 NEW.recorded_at=(r->>'recordedAt')::timestamptz;RETURN NEW;
END;
$$;
CREATE TRIGGER trg_owner_tier1_scope_validate BEFORE INSERT ON owner_tier1_scopes FOR EACH ROW EXECUTE FUNCTION validate_owner_tier1_scope();
CREATE TRIGGER trg_owner_tier1_scope_immutable BEFORE UPDATE OR DELETE ON owner_tier1_scopes FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_owner_tier1_scope_no_truncate BEFORE TRUNCATE ON owner_tier1_scopes FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
