-- Request accounting only. No remote transport or model permission.
CREATE TABLE conditional_collection_v2_journals (
 registration_id UUID PRIMARY KEY REFERENCES conditional_blob_archives(registration_id),
 owner_user_id UUID NOT NULL REFERENCES app_users(id), registration_sha256 TEXT NOT NULL,
 archive_header_sha256 TEXT NOT NULL, synthetic_only BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT conditional_collection_clock(),
 header_text TEXT NOT NULL DEFAULT '', header_sha256 TEXT NOT NULL DEFAULT ''
);
CREATE TABLE conditional_collection_v2_events (
 registration_id UUID NOT NULL REFERENCES conditional_collection_v2_journals(registration_id),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 1999), operation_id UUID NOT NULL,
 command_text TEXT NOT NULL CHECK(octet_length(command_text)<=8192), command_sha256 TEXT NOT NULL,
 parent_sha256 TEXT NOT NULL, event_text TEXT NOT NULL DEFAULT '' CHECK(octet_length(event_text)<=8192),
 head_sha256 TEXT NOT NULL DEFAULT '', recorded_at TIMESTAMPTZ NOT NULL DEFAULT conditional_collection_clock(),
 PRIMARY KEY(registration_id,sequence), UNIQUE(registration_id,operation_id)
);
CREATE UNIQUE INDEX conditional_v2_request_once ON conditional_collection_v2_events(registration_id,((event_text::jsonb)->>'requestId'))
 WHERE event_text::jsonb->>'kind'='reserved';
CREATE UNIQUE INDEX conditional_v2_completion_once ON conditional_collection_v2_events(registration_id,((event_text::jsonb)->>'requestId'))
 WHERE event_text::jsonb->>'kind' IN ('archived','failed','recovered_unknown');
CREATE FUNCTION guard_conditional_collection_v2_header() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE a conditional_blob_archives%ROWTYPE;p JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'collection_v2_immutable'; END IF;
 a:=conditional_blob_archive_lock(NEW.registration_id);
 SELECT package_text::jsonb INTO p FROM conditional_real_registrations WHERE id=NEW.registration_id;
 IF NEW.owner_user_id IS DISTINCT FROM a.owner_user_id OR NEW.registration_sha256 IS DISTINCT FROM a.registration_sha256
  OR NEW.archive_header_sha256 IS DISTINCT FROM a.header_sha256 OR NEW.synthetic_only IS DISTINCT FROM a.synthetic_only
  OR NOT (p->'executable'->'code' ?& ARRAY['tools/research/conditional-collection-v2-journal.mjs','packages/db/migrations/068_conditional_collection_v2_journal.sql'])
  OR EXISTS(SELECT 1 FROM conditional_blob_receipts WHERE registration_id=NEW.registration_id)
  OR EXISTS(SELECT 1 FROM conditional_raw_blobs WHERE registration_id=NEW.registration_id)
 THEN RAISE EXCEPTION 'collection_v2_empty_bound_archive_required'; END IF;
 NEW.created_at:=conditional_collection_clock();
 IF NEW.created_at<a.created_at THEN RAISE EXCEPTION 'collection_v2_clock_regression'; END IF;
 NEW.header_text:=jsonb_build_object('format','conditional-collection-v2-journal','registrationId',NEW.registration_id,
 'ownerUserId',NEW.owner_user_id,'registrationSha256',NEW.registration_sha256,'archiveHeaderSha256',NEW.archive_header_sha256,
 'syntheticOnly',NEW.synthetic_only,'createdAt',to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
 NEW.header_sha256:=encode(sha256(convert_to(NEW.header_text,'UTF8')),'hex');RETURN NEW;
END; $$;
-- Standalone SQL067 archives keep their old semantics. Once enrolled in v2,
-- a receipt must belong to the one pending reservation and follow its clock.
CREATE FUNCTION bind_conditional_v2_archive_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE last_event conditional_collection_v2_events%ROWTYPE;m JSONB;
BEGIN
 IF EXISTS(SELECT 1 FROM conditional_collection_v2_journals WHERE registration_id=NEW.registration_id) THEN
  PERFORM conditional_blob_archive_lock(NEW.registration_id);
  SELECT * INTO last_event FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id ORDER BY sequence DESC LIMIT 1;
  m:=NEW.metadata_text::jsonb;
  IF last_event.event_text::jsonb->>'kind' IS DISTINCT FROM 'reserved'
   OR last_event.event_text::jsonb->>'requestId' IS DISTINCT FROM NEW.request_id::text
   OR last_event.event_text::jsonb->>'endpoint' IS DISTINCT FROM m->>'endpoint'
   OR (m->>'receivedAt')::timestamptz<last_event.recorded_at
  THEN RAISE EXCEPTION 'collection_v2_receipt_reservation_binding'; END IF;
 END IF;RETURN NEW;
END; $$;
CREATE TRIGGER conditional_v2_receipt_binding BEFORE INSERT ON conditional_blob_receipts FOR EACH ROW EXECUTE FUNCTION bind_conditional_v2_archive_receipt();
CREATE FUNCTION guard_conditional_collection_v2_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h conditional_collection_v2_journals%ROWTYPE;a conditional_blob_archives%ROWTYPE;
 last_event conditional_collection_v2_events%ROWTYPE;r conditional_blob_receipts%ROWTYPE;b conditional_raw_blobs%ROWTYPE;ae conditional_blob_entries%ROWTYPE;
 p JSONB;c JSONB;e JSONB;m JSONB;kind TEXT;at_text TEXT;endpoint TEXT;endpoint_id TEXT;cooldown TIMESTAMPTZ;
 n INTEGER;local_bytes BIGINT;global_bytes BIGINT;archive_parent TEXT;archive_sequence INTEGER;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'collection_v2_immutable'; END IF;
 a:=conditional_blob_archive_lock(NEW.registration_id);
 SELECT * INTO h FROM conditional_collection_v2_journals WHERE registration_id=NEW.registration_id FOR UPDATE;
 IF h.registration_id IS NULL THEN RAISE EXCEPTION 'collection_v2_journal_required'; END IF;
 SELECT package_text::jsonb INTO p FROM conditional_real_registrations WHERE id=NEW.registration_id;
 SELECT * INTO last_event FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.sequence IS DISTINCT FROM coalesce(last_event.sequence+1,0) OR NEW.parent_sha256 IS DISTINCT FROM coalesce(last_event.head_sha256,h.header_sha256)
 THEN RAISE EXCEPTION 'collection_v2_head_conflict'; END IF;
 IF NOT (NEW.command_text IS JSON OBJECT WITH UNIQUE KEYS) OR NEW.command_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.command_text,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'collection_v2_command_hash_or_json'; END IF;
 c:=NEW.command_text::jsonb;kind:=c->>'kind';NEW.recorded_at:=conditional_collection_clock();
 IF NEW.recorded_at<coalesce(last_event.recorded_at,h.created_at) THEN RAISE EXCEPTION 'collection_v2_clock_regression'; END IF;
 IF jsonb_typeof(c->'requestId') IS DISTINCT FROM 'string' OR c->>'requestId' IS DISTINCT FROM ((c->>'requestId')::uuid)::text
 THEN RAISE EXCEPTION 'collection_v2_request_id'; END IF;
 at_text:=to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 IF kind='reserve' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR jsonb_typeof(c->'endpoint') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'collection_v2_command_fields'; END IF;
  IF last_event.event_text::jsonb->>'kind'='reserved' THEN RAISE EXCEPTION 'collection_v2_request_in_flight'; END IF;
  IF NEW.recorded_at<((p->>'policyText')::jsonb->'proposedRegistration'->>'from')::timestamptz
   OR NEW.recorded_at>=((p->>'policyText')::jsonb->'proposedRegistration'->>'assessmentAt')::timestamptz THEN RAISE EXCEPTION 'collection_v2_window_closed'; END IF;
  SELECT count(*) INTO n FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id AND event_text::jsonb->>'kind'='reserved';
  IF n>=(p->'collection'->>'maxHttpAttempts')::integer THEN RAISE EXCEPTION 'collection_v2_total_budget_exhausted'; END IF;
  SELECT count(*) INTO n FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id AND event_text::jsonb->>'kind'='reserved'
   AND (recorded_at AT TIME ZONE 'UTC')::date=(NEW.recorded_at AT TIME ZONE 'UTC')::date;
  IF n>=(p->'collection'->>'maxDailyAttempts')::integer THEN RAISE EXCEPTION 'collection_v2_daily_budget_exhausted'; END IF;
  SELECT max(greatest(recorded_at+interval '5 seconds',(event_text::jsonb->>'retryAfterAt')::timestamptz)) INTO cooldown
   FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id AND event_text::jsonb->>'kind' IN ('failed','recovered_unknown');
  IF NEW.recorded_at<cooldown THEN RAISE EXCEPTION 'collection_v2_retry_after_active'; END IF;
  IF EXISTS(SELECT 1 FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id AND event_text::jsonb->>'httpStatus' IN ('401','403'))
   THEN RAISE EXCEPTION 'collection_v2_provider_auth_failed'; END IF;
  endpoint:=c->>'endpoint';
  IF endpoint !~ '^(/matches/[1-9][0-9]{0,18}|/leagues/[1-9][0-9]{0,18}/matches|/proMatches(\?less_than_match_id=[1-9][0-9]{0,18})?)$' THEN RAISE EXCEPTION 'collection_v2_endpoint'; END IF;
  endpoint_id:=substring(endpoint from '[0-9]+');
  IF endpoint_id IS NOT NULL AND endpoint_id::numeric>9223372036854775807 THEN RAISE EXCEPTION 'collection_v2_endpoint_id'; END IF;
  IF endpoint LIKE '/leagues/%' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'review'->'bindings') x WHERE x->>'leagueId'=endpoint_id)
   THEN RAISE EXCEPTION 'collection_v2_unregistered_league'; END IF;
  SELECT coalesce(sum(byte_length),0),coalesce(sum(byte_length) FILTER(WHERE registration_id=NEW.registration_id),0) INTO global_bytes,local_bytes FROM conditional_raw_blobs;
  IF global_bytes+8388608>536870912 OR local_bytes+8388608>a.max_bytes
   OR (SELECT count(*) FROM conditional_blob_receipts WHERE registration_id=NEW.registration_id)>=a.max_responses
   THEN RAISE EXCEPTION 'collection_v2_archive_capacity'; END IF;
  e:=jsonb_build_object('kind','reserved','requestId',c->>'requestId','endpoint',endpoint);
 ELSIF kind IN ('complete','fail','recover') THEN
  IF last_event.event_text::jsonb->>'kind' IS DISTINCT FROM 'reserved' OR last_event.event_text::jsonb->>'requestId' IS DISTINCT FROM c->>'requestId'
   THEN RAISE EXCEPTION 'collection_v2_no_matching_request'; END IF;
  SELECT * INTO r FROM conditional_blob_receipts WHERE registration_id=NEW.registration_id AND request_id=(c->>'requestId')::uuid;
  IF kind='complete' THEN
   IF (SELECT count(*) FROM jsonb_object_keys(c))<>2 THEN RAISE EXCEPTION 'collection_v2_command_fields'; END IF;
   IF r.request_id IS NULL THEN RAISE EXCEPTION 'collection_v2_receipt_missing'; END IF;
   SELECT * INTO b FROM conditional_raw_blobs WHERE registration_id=NEW.registration_id AND body_sha256=r.body_sha256;
   m:=r.metadata_text::jsonb;
   IF encode(sha256(convert_to(r.metadata_text,'UTF8')),'hex') IS DISTINCT FROM r.receipt_sha256 OR b.body_sha256 IS NULL
    OR encode(sha256(b.body),'hex') IS DISTINCT FROM r.body_sha256 OR octet_length(b.body) IS DISTINCT FROM b.byte_length
    OR m->>'bodySha256' IS DISTINCT FROM b.body_sha256 OR (m->>'responseBytes')::integer IS DISTINCT FROM b.byte_length
    OR m->>'endpoint' IS DISTINCT FROM last_event.event_text::jsonb->>'endpoint'
    OR (m->>'receivedAt')::timestamptz<last_event.recorded_at OR NEW.recorded_at<r.saved_at
    THEN RAISE EXCEPTION 'collection_v2_receipt_integrity'; END IF;
   SELECT * INTO ae FROM conditional_blob_entries WHERE registration_id=NEW.registration_id AND request_id=r.request_id;
   IF ae.request_id IS NULL THEN
    SELECT sequence+1,head_sha256 INTO archive_sequence,archive_parent FROM conditional_blob_entries WHERE registration_id=NEW.registration_id ORDER BY sequence DESC LIMIT 1;
    INSERT INTO conditional_blob_entries(registration_id,sequence,request_id,receipt_sha256,body_sha256,response_bytes,parent_sha256)
     VALUES(NEW.registration_id,coalesce(archive_sequence,0),r.request_id,r.receipt_sha256,r.body_sha256,b.byte_length,coalesce(archive_parent,a.header_sha256)) RETURNING * INTO ae;
   END IF;
   NEW.recorded_at:=conditional_collection_clock();
   IF ae.receipt_sha256 IS DISTINCT FROM r.receipt_sha256 OR ae.body_sha256 IS DISTINCT FROM r.body_sha256 OR ae.response_bytes IS DISTINCT FROM b.byte_length
    OR ae.head_sha256 IS DISTINCT FROM encode(sha256(convert_to(ae.parent_sha256||':'||ae.entry_text,'UTF8')),'hex') OR ae.saved_at>NEW.recorded_at
    THEN RAISE EXCEPTION 'collection_v2_archive_entry_integrity'; END IF;
   e:=jsonb_build_object('kind','archived','requestId',c->>'requestId','receiptSha256',r.receipt_sha256,'bodySha256',r.body_sha256,
    'archiveEntryHeadSha256',ae.head_sha256,'receivedAt',m->>'receivedAt');
  ELSE
   IF r.request_id IS NOT NULL THEN RAISE EXCEPTION 'collection_v2_saved_receipt_requires_completion'; END IF;
   IF kind='recover' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR jsonb_typeof(c->'reason') IS DISTINCT FROM 'string' OR length(btrim(c->>'reason')) NOT BETWEEN 20 AND 500
     THEN RAISE EXCEPTION 'collection_v2_recovery_reason'; END IF;
    IF NEW.recorded_at<last_event.recorded_at+interval '120 seconds' THEN RAISE EXCEPTION 'collection_v2_recovery_not_expired'; END IF;
    e:=jsonb_build_object('kind','recovered_unknown','requestId',c->>'requestId');
   ELSE
    IF (SELECT count(*) FROM jsonb_object_keys(c))<>5 OR NOT (c ?& ARRAY['httpStatus','code','retryAfterAt'])
     OR NOT (c->'httpStatus'='null'::jsonb OR (jsonb_typeof(c->'httpStatus')='number' AND (c->>'httpStatus')::integer BETWEEN 400 AND 599 AND c->'httpStatus'=to_jsonb((c->>'httpStatus')::integer)))
     OR (c->>'code') IS NULL OR (c->>'code') NOT IN ('http_error','timeout','connection_error','body_limit','incomplete_body','cancelled')
     OR (c->'httpStatus'='null'::jsonb) IS DISTINCT FROM (c->>'code'<>'http_error')
     OR NOT (c->'retryAfterAt'='null'::jsonb OR (jsonb_typeof(c->'retryAfterAt')='string' AND c->>'retryAfterAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'))
     THEN RAISE EXCEPTION 'collection_v2_failure_invalid'; END IF;
    -- Reject invalid calendar dates and PostgreSQL-normalized leap seconds,
    -- instead of committing a timestamp that the independent JS replay rejects.
    IF c->'retryAfterAt'<>'null'::jsonb AND to_char((c->>'retryAfterAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM c->>'retryAfterAt'
     THEN RAISE EXCEPTION 'collection_v2_retry_after_invalid'; END IF;
    e:=jsonb_build_object('kind','failed','requestId',c->>'requestId','httpStatus',c->'httpStatus','code',c->'code','retryAfterAt',c->'retryAfterAt');
   END IF;
  END IF;
 ELSE RAISE EXCEPTION 'collection_v2_unknown_command'; END IF;
 at_text:=to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 NEW.event_text:=(e||jsonb_build_object('sequence',NEW.sequence,'at',at_text))::text;
 NEW.head_sha256:=encode(sha256(convert_to(NEW.parent_sha256||':'||NEW.operation_id::text||':'||NEW.command_sha256||':'||NEW.event_text,'UTF8')),'hex');RETURN NEW;
END; $$;
CREATE TRIGGER conditional_v2_header_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_collection_v2_journals FOR EACH ROW EXECUTE FUNCTION guard_conditional_collection_v2_header();
CREATE TRIGGER conditional_v2_header_no_truncate BEFORE TRUNCATE ON conditional_collection_v2_journals FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_collection_v2_header();
CREATE TRIGGER conditional_v2_event_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_collection_v2_events FOR EACH ROW EXECUTE FUNCTION guard_conditional_collection_v2_event();
CREATE TRIGGER conditional_v2_event_no_truncate BEFORE TRUNCATE ON conditional_collection_v2_events FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_collection_v2_event();
