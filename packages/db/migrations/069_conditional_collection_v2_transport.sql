-- Local synthetic transport receipts only; original bytes remain in SQL067 blobs.
CREATE TABLE conditional_v2_transport_receipts (
 registration_id UUID NOT NULL, request_id UUID NOT NULL, reservation_operation_id UUID NOT NULL,
 receipt_text TEXT NOT NULL CHECK(octet_length(receipt_text)<=16384), receipt_sha256 TEXT NOT NULL DEFAULT '',
 saved_at TIMESTAMPTZ NOT NULL DEFAULT conditional_collection_clock(),
 PRIMARY KEY(registration_id,request_id), UNIQUE(registration_id,reservation_operation_id),
 FOREIGN KEY(registration_id,reservation_operation_id) REFERENCES conditional_collection_v2_events(registration_id,operation_id)
);
CREATE FUNCTION guard_conditional_v2_transport_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE a conditional_blob_archives%ROWTYPE;e conditional_collection_v2_events%ROWTYPE;last_event conditional_collection_v2_events%ROWTYPE;
 b conditional_blob_receipts%ROWTYPE;r JSONB;c JSONB;key TEXT;v TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'v2_transport_receipt_immutable'; END IF;
 a:=conditional_blob_archive_lock(NEW.registration_id);
 IF NOT a.synthetic_only THEN RAISE EXCEPTION 'v2_synthetic_transport_only'; END IF;
 IF NOT (NEW.receipt_text IS JSON OBJECT WITH UNIQUE KEYS) THEN RAISE EXCEPTION 'v2_transport_receipt_json'; END IF;
 r:=NEW.receipt_text::jsonb;c:=r->'command';NEW.saved_at:=conditional_collection_clock();
 SELECT * INTO e FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id AND operation_id=NEW.reservation_operation_id;
 SELECT * INTO last_event FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id ORDER BY sequence DESC LIMIT 1;
 IF (SELECT count(*) FROM jsonb_object_keys(r))<>23
  OR NOT (r ?& ARRAY['format','syntheticOnly','registrationId','requestId','reservationOperationId','reservationHeadSha256','endpoint',
   'sendInvokedAt','responseHeadersAt','bodyCompletedAt','finishedAt','observedAt','clockBasis','httpStatus','responseBytes',
   'bodySha256','bodyBytes','clientValidationCode','quotaClaimed','quotaObservationFailed','quotaPeriod','completionOperationId','command'])
  OR r->>'format' IS DISTINCT FROM 'conditional-local-transport-v2' OR r->'syntheticOnly' IS DISTINCT FROM 'true'::jsonb
  OR r->>'registrationId' IS DISTINCT FROM NEW.registration_id::text OR r->>'requestId' IS DISTINCT FROM NEW.request_id::text
  OR r->>'reservationOperationId' IS DISTINCT FROM NEW.reservation_operation_id::text
  OR e.event_text::jsonb->>'kind' IS DISTINCT FROM 'reserved' OR e.event_text::jsonb->>'requestId' IS DISTINCT FROM NEW.request_id::text
  OR r->>'reservationHeadSha256' IS DISTINCT FROM e.head_sha256 OR r->>'endpoint' IS DISTINCT FROM e.event_text::jsonb->>'endpoint'
  OR last_event.operation_id IS DISTINCT FROM e.operation_id
  OR r->>'clockBasis' IS DISTINCT FROM 'process_wall_and_postgres_observation'
  OR c->>'requestId' IS DISTINCT FROM NEW.request_id::text
  OR jsonb_typeof(r->'completionOperationId') IS DISTINCT FROM 'string'
  OR r->>'completionOperationId' IS DISTINCT FROM ((r->>'completionOperationId')::uuid)::text
  OR jsonb_typeof(r->'quotaClaimed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(r->'quotaObservationFailed') IS DISTINCT FROM 'boolean'
  OR NOT (r->'quotaPeriod'='null'::jsonb OR r->>'quotaPeriod' IN ('minute','day','month','cooldown'))
  OR (r->'quotaClaimed'='true'::jsonb AND r->'quotaPeriod'<>'null'::jsonb)
  OR NOT (r->'clientValidationCode'='null'::jsonb OR (jsonb_typeof(r->'clientValidationCode')='string' AND r->>'clientValidationCode' ~ '^[a-z][a-z0-9_]{0,63}$'))
  OR jsonb_typeof(r->'responseBytes') IS DISTINCT FROM 'number' OR (r->>'responseBytes') !~ '^(0|[1-9][0-9]*)$'
  OR (r->>'responseBytes')::numeric>9007199254740991
 THEN RAISE EXCEPTION 'v2_transport_receipt_binding'; END IF;
 FOREACH key IN ARRAY ARRAY['sendInvokedAt','responseHeadersAt','bodyCompletedAt','finishedAt','observedAt'] LOOP
  IF r->key='null'::jsonb AND key IN ('sendInvokedAt','responseHeadersAt','bodyCompletedAt') THEN CONTINUE; END IF;
  v:=r->>key;
  IF jsonb_typeof(r->key) IS DISTINCT FROM 'string' OR v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
   OR to_char(v::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM v THEN RAISE EXCEPTION 'v2_transport_receipt_clock'; END IF;
 END LOOP;
 IF (r->>'observedAt')::timestamptz<e.recorded_at OR (r->>'observedAt')::timestamptz>NEW.saved_at
  OR (r->>'sendInvokedAt')::timestamptz>(r->>'finishedAt')::timestamptz
  OR (r->>'responseHeadersAt')::timestamptz>(r->>'finishedAt')::timestamptz
  OR (r->>'bodyCompletedAt')::timestamptz>(r->>'finishedAt')::timestamptz
  OR (r->>'responseHeadersAt')::timestamptz<(r->>'sendInvokedAt')::timestamptz
  OR (r->>'bodyCompletedAt')::timestamptz<(r->>'responseHeadersAt')::timestamptz
 THEN RAISE EXCEPTION 'v2_transport_receipt_clock'; END IF;
 IF NOT (r->'httpStatus'='null'::jsonb OR (jsonb_typeof(r->'httpStatus')='number' AND r->>'httpStatus' ~ '^[1-5][0-9]{2}$'))
  OR (r->'responseHeadersAt'='null'::jsonb) IS DISTINCT FROM (r->'httpStatus'='null'::jsonb)
  OR (r->'sendInvokedAt'<>'null'::jsonb AND r->'quotaClaimed'<>'true'::jsonb)
  OR (r->'responseHeadersAt'<>'null'::jsonb AND r->'sendInvokedAt'='null'::jsonb)
 THEN RAISE EXCEPTION 'v2_transport_receipt_observation'; END IF;
 SELECT * INTO b FROM conditional_blob_receipts WHERE registration_id=NEW.registration_id AND request_id=NEW.request_id;
 IF r->'bodySha256'<>'null'::jsonb THEN
  IF jsonb_typeof(r->'bodySha256') IS DISTINCT FROM 'string' OR r->>'bodySha256' !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(r->'bodyBytes') IS DISTINCT FROM 'number' OR r->>'bodyBytes' !~ '^(0|[1-9][0-9]*)$'
   OR (r->>'bodyBytes')::numeric>8388608 OR r->'bodyBytes' IS DISTINCT FROM r->'responseBytes'
   OR r->'bodyCompletedAt'='null'::jsonb OR r->'responseHeadersAt'='null'::jsonb
   OR (r->>'httpStatus')::integer NOT BETWEEN 200 AND 299 OR b.request_id IS NULL
   OR b.capture_operation_id IS DISTINCT FROM NEW.reservation_operation_id OR b.body_sha256 IS DISTINCT FROM r->>'bodySha256'
   OR b.metadata_text::jsonb->'responseBytes' IS DISTINCT FROM r->'bodyBytes'
   OR b.metadata_text::jsonb->>'receivedAt' IS DISTINCT FROM r->>'observedAt'
   OR b.metadata_text::jsonb->'clientValidationCode' IS DISTINCT FROM r->'clientValidationCode'
   OR c IS DISTINCT FROM jsonb_build_object('kind','complete','requestId',NEW.request_id)
  THEN RAISE EXCEPTION 'v2_transport_archive_binding'; END IF;
 ELSE
  IF r->'bodyBytes' IS DISTINCT FROM 'null'::jsonb OR r->'bodyCompletedAt' IS DISTINCT FROM 'null'::jsonb OR b.request_id IS NOT NULL
   OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>5
   OR c->>'kind' IS DISTINCT FROM 'fail' OR NOT (c ?& ARRAY['kind','requestId','httpStatus','code','retryAfterAt'])
   OR (c->>'code') IS NULL OR (c->>'code') NOT IN ('http_error','timeout','connection_error','body_limit','incomplete_body','cancelled')
   OR NOT (c->'httpStatus'='null'::jsonb OR (jsonb_typeof(c->'httpStatus')='number' AND c->>'httpStatus' ~ '^[45][0-9]{2}$'))
   OR (c->'httpStatus'='null'::jsonb) IS DISTINCT FROM (c->>'code'<>'http_error')
   OR (c->'httpStatus'<>'null'::jsonb AND c->'httpStatus' IS DISTINCT FROM r->'httpStatus')
   OR NOT (c->'retryAfterAt'='null'::jsonb OR (jsonb_typeof(c->'retryAfterAt')='string' AND c->>'retryAfterAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'))
  THEN RAISE EXCEPTION 'v2_transport_failure_binding'; END IF;
  IF c->'httpStatus' IS DISTINCT FROM (CASE WHEN (r->>'httpStatus')::integer BETWEEN 400 AND 599 THEN r->'httpStatus' ELSE 'null'::jsonb END)
   OR c->>'code' IS DISTINCT FROM (CASE
    WHEN (r->>'httpStatus')::integer BETWEEN 400 AND 599 THEN 'http_error'
    WHEN r->>'clientValidationCode'='source_timeout' THEN 'timeout'
    WHEN r->>'clientValidationCode'='source_response_too_large' THEN 'body_limit'
    WHEN r->>'clientValidationCode'='source_incomplete_body' THEN 'incomplete_body'
    WHEN r->>'clientValidationCode' IN ('transport_cancelled','request_budget_exhausted','source_rate_limited','quota_claim_failed',
     'transport_guard_failed','stale_dispatch_reservation','reservation_no_longer_pending','collection_window_closed') THEN 'cancelled'
    ELSE 'connection_error' END)
   THEN RAISE EXCEPTION 'v2_transport_failure_normalization'; END IF;
  IF c->'retryAfterAt'<>'null'::jsonb AND to_char((c->>'retryAfterAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM c->>'retryAfterAt'
   THEN RAISE EXCEPTION 'v2_transport_retry_after'; END IF;
 END IF;
 NEW.receipt_sha256:=encode(sha256(convert_to(NEW.receipt_text,'UTF8')),'hex');RETURN NEW;
END; $$;
CREATE TRIGGER conditional_v2_transport_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_v2_transport_receipts FOR EACH ROW EXECUTE FUNCTION guard_conditional_v2_transport_receipt();
CREATE TRIGGER conditional_v2_transport_receipt_no_truncate BEFORE TRUNCATE ON conditional_v2_transport_receipts FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_v2_transport_receipt();
-- Persisted transport outcomes must not be replaced by manual failure/recovery.
CREATE FUNCTION bind_conditional_v2_transport_completion() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r conditional_v2_transport_receipts%ROWTYPE;c JSONB;
BEGIN
 IF NEW.command_text::jsonb->>'kind'='reserve' THEN RETURN NEW; END IF;
 SELECT * INTO r FROM conditional_v2_transport_receipts WHERE registration_id=NEW.registration_id AND request_id=(NEW.command_text::jsonb->>'requestId')::uuid;
 IF r.request_id IS NOT NULL THEN
  c:=r.receipt_text::jsonb;
  IF r.receipt_sha256 IS DISTINCT FROM encode(sha256(convert_to(r.receipt_text,'UTF8')),'hex')
   OR c->>'completionOperationId' IS DISTINCT FROM NEW.operation_id::text OR c->'command' IS DISTINCT FROM NEW.command_text::jsonb
   OR c->>'reservationHeadSha256' IS DISTINCT FROM NEW.parent_sha256
  THEN RAISE EXCEPTION 'v2_transport_completion_binding'; END IF;
 END IF;RETURN NEW;
END; $$;
CREATE TRIGGER conditional_v2_transport_completion_guard BEFORE INSERT ON conditional_collection_v2_events FOR EACH ROW EXECUTE FUNCTION bind_conditional_v2_transport_completion();
