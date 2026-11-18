-- Internal raw evidence archive. Does NOT authorize dispatch, evaluation or activation.
CREATE TABLE conditional_blob_archives (
 registration_id UUID PRIMARY KEY REFERENCES conditional_real_registrations(id),
 owner_user_id UUID NOT NULL REFERENCES app_users(id),
 registration_sha256 TEXT NOT NULL,
 synthetic_only BOOLEAN NOT NULL,
 max_bytes BIGINT NOT NULL CHECK(max_bytes BETWEEN 1 AND 536870912),
 max_responses INTEGER NOT NULL CHECK(max_responses BETWEEN 1 AND 1000),
 header_text TEXT NOT NULL DEFAULT '', header_sha256 TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE conditional_raw_blobs (
 registration_id UUID NOT NULL REFERENCES conditional_blob_archives(registration_id),
 body_sha256 TEXT NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 body BYTEA NOT NULL CHECK(octet_length(body)<=8388608),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 8388608),
 PRIMARY KEY(registration_id,body_sha256)
);
CREATE TABLE conditional_blob_receipts (
 registration_id UUID NOT NULL,
 request_id UUID NOT NULL,
 capture_operation_id UUID NOT NULL,
 body_sha256 TEXT NOT NULL,
 metadata_text TEXT NOT NULL CHECK(octet_length(metadata_text)<=16384),
 receipt_sha256 TEXT NOT NULL DEFAULT '',
 saved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(registration_id,request_id), UNIQUE(registration_id,capture_operation_id),
 FOREIGN KEY(registration_id,body_sha256) REFERENCES conditional_raw_blobs(registration_id,body_sha256)
);
CREATE TABLE conditional_blob_entries (
 registration_id UUID NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 999),
 request_id UUID NOT NULL,
 receipt_sha256 TEXT NOT NULL, body_sha256 TEXT NOT NULL, response_bytes INTEGER NOT NULL,
 parent_sha256 TEXT NOT NULL,
 entry_text TEXT NOT NULL DEFAULT '' CHECK(octet_length(entry_text)<=4096),
 head_sha256 TEXT NOT NULL DEFAULT '', saved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(registration_id,sequence), UNIQUE(registration_id,request_id),
 FOREIGN KEY(registration_id,request_id) REFERENCES conditional_blob_receipts(registration_id,request_id)
);
CREATE FUNCTION conditional_blob_archive_lock(reg UUID) RETURNS conditional_blob_archives LANGUAGE plpgsql AS $$
DECLARE h conditional_blob_archives%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'archive_read_committed_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('conditional-blob-global-capacity-v1',0));
 SELECT * INTO h FROM conditional_blob_archives WHERE registration_id=reg FOR UPDATE;
 IF h.registration_id IS NULL THEN RAISE EXCEPTION 'archive_not_found'; END IF;
 PERFORM id FROM app_users WHERE id=h.owner_user_id AND is_active AND account_role='owner' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'archive_active_owner_required'; END IF;
 RETURN h;
END; $$;
CREATE FUNCTION guard_conditional_blob_header() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r conditional_real_registrations%ROWTYPE; p JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'archive_immutable' USING ERRCODE='55000'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'archive_read_committed_required'; END IF;
 SELECT * INTO r FROM conditional_real_registrations WHERE id=NEW.registration_id;
 p:=r.package_text::jsonb;
 PERFORM id FROM app_users WHERE id=NEW.owner_user_id AND is_active AND account_role='owner' FOR SHARE;
 IF NOT FOUND OR r.owner_user_id IS DISTINCT FROM NEW.owner_user_id
  OR p->>'format' IS DISTINCT FROM 'conditional-real-registration-package-v2'
  OR r.package_sha256 IS DISTINCT FROM NEW.registration_sha256
  OR NOT EXISTS(SELECT 1 FROM conditional_real_registration_receipts WHERE registration_id=r.id AND package_sha256=r.package_sha256)
  OR NEW.max_responses > (p->'collection'->>'maxHttpAttempts')::integer
  OR NOT (p->'executable'->'code' ?& ARRAY['tools/research/conditional-blob-archive.mjs','packages/db/migrations/067_conditional_blob_archive.sql'])
 THEN RAISE EXCEPTION 'archive_registration_binding'; END IF;
 NEW.created_at:=date_trunc('milliseconds',conditional_real_registration_clock());
 IF NEW.created_at < (SELECT observed_committed_at FROM conditional_real_registration_receipts WHERE registration_id=r.id)
 THEN RAISE EXCEPTION 'archive_clock_regression'; END IF;
 NEW.header_text:=jsonb_build_object('format','conditional-blob-archive-v1','registrationId',NEW.registration_id,
  'ownerUserId',NEW.owner_user_id,'registrationSha256',NEW.registration_sha256,'syntheticOnly',NEW.synthetic_only,
  'maxBytes',NEW.max_bytes,'maxResponses',NEW.max_responses,'createdAt',to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
 NEW.header_sha256:=encode(sha256(convert_to(NEW.header_text,'UTF8')),'hex');RETURN NEW;
END; $$;
CREATE FUNCTION guard_conditional_raw_blob() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h conditional_blob_archives%ROWTYPE; used_local BIGINT; used_global BIGINT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'archive_immutable' USING ERRCODE='55000'; END IF;
 h:=conditional_blob_archive_lock(NEW.registration_id);
 IF NEW.body_sha256 IS DISTINCT FROM encode(sha256(NEW.body),'hex') OR NEW.byte_length IS DISTINCT FROM octet_length(NEW.body)
 THEN RAISE EXCEPTION 'archive_body_integrity'; END IF;
 SELECT coalesce(sum(byte_length),0),coalesce(sum(byte_length) FILTER(WHERE registration_id=NEW.registration_id),0)
 INTO used_global,used_local FROM conditional_raw_blobs;
 IF used_local+NEW.byte_length>h.max_bytes OR used_global+NEW.byte_length>536870912 THEN RAISE EXCEPTION 'archive_capacity_exceeded'; END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION check_conditional_blob_referenced() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM conditional_blob_receipts WHERE registration_id=NEW.registration_id AND body_sha256=NEW.body_sha256)
 THEN RAISE EXCEPTION 'archive_orphan_blob'; END IF;RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER conditional_blob_referenced AFTER INSERT ON conditional_raw_blobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_conditional_blob_referenced();
CREATE FUNCTION guard_conditional_blob_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h conditional_blob_archives%ROWTYPE; m JSONB; b conditional_raw_blobs%ROWTYPE; endpoint_id TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'archive_immutable' USING ERRCODE='55000'; END IF;
 h:=conditional_blob_archive_lock(NEW.registration_id);
 IF NOT (NEW.metadata_text IS JSON OBJECT WITH UNIQUE KEYS) THEN RAISE EXCEPTION 'archive_metadata_json'; END IF;
 m:=NEW.metadata_text::jsonb;
 SELECT * INTO b FROM conditional_raw_blobs WHERE registration_id=NEW.registration_id AND body_sha256=NEW.body_sha256;
 NEW.saved_at:=date_trunc('milliseconds',conditional_real_registration_clock());
 IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(m))<>13
  OR m->>'format' IS DISTINCT FROM 'conditional-blob-response-v1'
  OR m->>'registrationId' IS DISTINCT FROM NEW.registration_id::text OR m->>'requestId' IS DISTINCT FROM NEW.request_id::text
  OR m->>'provider' IS DISTINCT FROM 'opendota' OR m->>'bodySha256' IS DISTINCT FROM NEW.body_sha256
  OR m->'responseBytes' IS DISTINCT FROM to_jsonb(b.byte_length)
  OR m->'syntheticOnly' IS DISTINCT FROM to_jsonb(h.synthetic_only)
  OR m->'knownAt' IS DISTINCT FROM 'null'::jsonb
  OR m->>'clockBasis' IS DISTINCT FROM 'caller_observation_not_historical_known_at'
  OR jsonb_typeof(m->'httpStatus') IS DISTINCT FROM 'number' OR NOT ((m->>'httpStatus')::integer BETWEEN 200 AND 299)
  OR m->'httpStatus' IS DISTINCT FROM to_jsonb((m->>'httpStatus')::integer)
  OR m->>'receivedAt' IS NULL OR (m->>'receivedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  OR (m->>'receivedAt')::timestamptz<h.created_at OR (m->>'receivedAt')::timestamptz>NEW.saved_at
  OR NOT (m ? 'clientValidationCode') OR NOT (m->'clientValidationCode'='null'::jsonb OR (jsonb_typeof(m->'clientValidationCode')='string' AND m->>'clientValidationCode' ~ '^[a-z][a-z0-9_]{0,63}$'))
  OR m->>'endpoint' IS NULL OR (m->>'endpoint') !~ '^(/matches/[1-9][0-9]{0,18}|/leagues/[1-9][0-9]{0,18}/matches|/proMatches(\?less_than_match_id=[1-9][0-9]{0,18})?)$'
 THEN RAISE EXCEPTION 'archive_metadata_invalid'; END IF;
 endpoint_id:=substring(m->>'endpoint' from '[0-9]+');
 IF endpoint_id IS NOT NULL AND endpoint_id::numeric>9223372036854775807 THEN RAISE EXCEPTION 'archive_endpoint_id'; END IF;
 IF (SELECT count(*) FROM conditional_blob_receipts WHERE registration_id=NEW.registration_id)>=h.max_responses
 THEN RAISE EXCEPTION 'archive_response_limit'; END IF;
 NEW.receipt_sha256:=encode(sha256(convert_to(NEW.metadata_text,'UTF8')),'hex');RETURN NEW;
END; $$;
CREATE FUNCTION guard_conditional_blob_entry() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h conditional_blob_archives%ROWTYPE; r conditional_blob_receipts%ROWTYPE; seq INTEGER; parent TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'archive_immutable' USING ERRCODE='55000'; END IF;
 h:=conditional_blob_archive_lock(NEW.registration_id);
 SELECT count(*) INTO seq FROM conditional_blob_entries WHERE registration_id=NEW.registration_id;
 SELECT head_sha256 INTO parent FROM conditional_blob_entries WHERE registration_id=NEW.registration_id ORDER BY sequence DESC LIMIT 1;
 parent:=coalesce(parent,h.header_sha256);
 SELECT * INTO r FROM conditional_blob_receipts WHERE registration_id=NEW.registration_id AND request_id=NEW.request_id;
 IF NEW.sequence IS DISTINCT FROM seq OR NEW.parent_sha256 IS DISTINCT FROM parent
  OR NEW.receipt_sha256 IS DISTINCT FROM r.receipt_sha256 OR NEW.body_sha256 IS DISTINCT FROM r.body_sha256
  OR NEW.response_bytes IS DISTINCT FROM (r.metadata_text::jsonb->>'responseBytes')::integer OR r.request_id IS NULL
 THEN RAISE EXCEPTION 'archive_entry_binding'; END IF;
 NEW.saved_at:=date_trunc('milliseconds',conditional_real_registration_clock());
 IF NEW.saved_at<r.saved_at OR NEW.saved_at<coalesce((SELECT max(saved_at) FROM conditional_blob_entries WHERE registration_id=NEW.registration_id),h.created_at)
 THEN RAISE EXCEPTION 'archive_clock_regression'; END IF;
 NEW.entry_text:=jsonb_build_object('format','conditional-blob-entry-v1','registrationId',NEW.registration_id,'sequence',NEW.sequence,
 'requestId',NEW.request_id,'receiptSha256',NEW.receipt_sha256,'bodySha256',NEW.body_sha256,'responseBytes',NEW.response_bytes,
 'at',to_char(NEW.saved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
 NEW.head_sha256:=encode(sha256(convert_to(NEW.parent_sha256||':'||NEW.entry_text,'UTF8')),'hex');RETURN NEW;
END; $$;
CREATE TRIGGER conditional_blob_header_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_blob_archives FOR EACH ROW EXECUTE FUNCTION guard_conditional_blob_header();
CREATE TRIGGER conditional_blob_header_truncate BEFORE TRUNCATE ON conditional_blob_archives FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_blob_header();
CREATE TRIGGER conditional_raw_blob_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_raw_blobs FOR EACH ROW EXECUTE FUNCTION guard_conditional_raw_blob();
CREATE TRIGGER conditional_raw_blob_truncate BEFORE TRUNCATE ON conditional_raw_blobs FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_raw_blob();
CREATE TRIGGER conditional_blob_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_blob_receipts FOR EACH ROW EXECUTE FUNCTION guard_conditional_blob_receipt();
CREATE TRIGGER conditional_blob_receipt_truncate BEFORE TRUNCATE ON conditional_blob_receipts FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_blob_receipt();
CREATE TRIGGER conditional_blob_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_blob_entries FOR EACH ROW EXECUTE FUNCTION guard_conditional_blob_entry();
CREATE TRIGGER conditional_blob_entry_truncate BEFORE TRUNCATE ON conditional_blob_entries FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_blob_entry();
