-- Collection bookkeeping only; these records grant no HTTP, scoring or activation permission.
CREATE FUNCTION conditional_collection_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS $$
 SELECT date_trunc('milliseconds',clock_timestamp());
$$;
CREATE TABLE conditional_collection_journals (
 registration_id UUID PRIMARY KEY REFERENCES conditional_real_registrations(id),
 owner_user_id UUID NOT NULL REFERENCES app_users(id),
 registration_sha256 TEXT NOT NULL,
 synthetic_only BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT conditional_collection_clock(),
 header_text TEXT NOT NULL DEFAULT '',
 header_sha256 TEXT NOT NULL DEFAULT ''
);
CREATE TABLE conditional_collection_events (
 registration_id UUID NOT NULL REFERENCES conditional_collection_journals(registration_id),
 sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<3000),
 operation_id UUID NOT NULL,
 command_text TEXT NOT NULL CHECK(octet_length(command_text)<=9000000),
 command_sha256 TEXT NOT NULL,
 parent_sha256 TEXT NOT NULL,
 event_text TEXT NOT NULL DEFAULT '',
 head_sha256 TEXT NOT NULL DEFAULT '',
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT conditional_collection_clock(),
 writer_txid TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(registration_id,sequence),UNIQUE(registration_id,operation_id)
);
CREATE FUNCTION guard_conditional_collection_header() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r conditional_real_registrations%ROWTYPE;c conditional_real_registration_receipts%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'collection_journal_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO r FROM conditional_real_registrations WHERE id=NEW.registration_id;
 SELECT * INTO c FROM conditional_real_registration_receipts WHERE registration_id=NEW.registration_id;
 IF r.id IS NULL OR c.registration_id IS NULL OR r.owner_user_id<>NEW.owner_user_id OR r.package_sha256<>NEW.registration_sha256
  OR c.package_sha256<>r.package_sha256 OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active AND account_role='owner')
 THEN RAISE EXCEPTION 'collection_registration_required' USING ERRCODE='23514'; END IF;
 NEW.created_at:=conditional_collection_clock();
 IF NEW.created_at<c.observed_committed_at THEN RAISE EXCEPTION 'collection_clock_regression' USING ERRCODE='23514'; END IF;
 NEW.header_text:=jsonb_build_object('format','conditional-collection-journal-v1','registrationId',NEW.registration_id::text,
  'registrationSha256',NEW.registration_sha256,'ownerUserId',NEW.owner_user_id::text,'syntheticOnly',NEW.synthetic_only,
  'createdAt',to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
 NEW.header_sha256:=encode(sha256(convert_to(NEW.header_text,'UTF8')),'hex');RETURN NEW;
END;
$$;
CREATE FUNCTION guard_conditional_collection_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h conditional_collection_journals%ROWTYPE;last_event conditional_collection_events%ROWTYPE;pending conditional_collection_events%ROWTYPE;
 p JSONB;c JSONB;e JSONB;kind TEXT;event_at TEXT;cooldown TIMESTAMPTZ;n INTEGER;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'collection_event_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO h FROM conditional_collection_journals WHERE registration_id=NEW.registration_id FOR UPDATE;
 IF h.registration_id IS NULL OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=h.owner_user_id AND is_active AND account_role='owner')
 THEN RAISE EXCEPTION 'collection_active_owner_required' USING ERRCODE='23514'; END IF;
 SELECT r.package_text::jsonb INTO p FROM conditional_real_registrations r JOIN conditional_real_registration_receipts x ON x.registration_id=r.id
  WHERE r.id=h.registration_id AND r.package_sha256=h.registration_sha256 AND x.package_sha256=r.package_sha256;
 IF p IS NULL THEN RAISE EXCEPTION 'collection_registration_required' USING ERRCODE='23514'; END IF;
 SELECT * INTO last_event FROM conditional_collection_events WHERE registration_id=h.registration_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.sequence<>coalesce(last_event.sequence+1,0) OR NEW.parent_sha256 IS DISTINCT FROM coalesce(last_event.head_sha256,h.header_sha256)
 THEN RAISE EXCEPTION 'collection_head_conflict' USING ERRCODE='23514'; END IF;
 IF encode(sha256(convert_to(NEW.command_text,'UTF8')),'hex') IS DISTINCT FROM NEW.command_sha256
 THEN RAISE EXCEPTION 'collection_command_hash' USING ERRCODE='23514'; END IF;
 c:=NEW.command_text::jsonb;kind:=c->>'kind';NEW.recorded_at:=conditional_collection_clock();NEW.writer_txid:=txid_current()::text;
 IF NEW.recorded_at<coalesce(last_event.recorded_at,h.created_at) THEN RAISE EXCEPTION 'collection_clock_regression' USING ERRCODE='23514'; END IF;
 event_at:=to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 -- Only one request may be in flight; scan/finish cannot leave an older request pending.
 IF last_event.event_text::jsonb->>'kind'='request_started' THEN pending:=last_event; END IF;
 IF kind='scan' THEN
  IF pending.registration_id IS NOT NULL THEN RAISE EXCEPTION 'collection_request_in_flight' USING ERRCODE='23514'; END IF;
  PERFORM (c->>'scanId')::uuid;e:=jsonb_build_object('kind','scan_started','scanId',c->>'scanId');
 ELSIF kind='reserve' THEN
  IF pending.registration_id IS NOT NULL THEN RAISE EXCEPTION 'collection_request_in_flight' USING ERRCODE='23514'; END IF;
  -- Policy text is a pinned JSON string in the package, not a caller clock/config.
  IF NEW.recorded_at<((p->>'policyText')::jsonb->'proposedRegistration'->>'from')::timestamptz
   OR NEW.recorded_at>=((p->>'policyText')::jsonb->'proposedRegistration'->>'assessmentAt')::timestamptz
  THEN RAISE EXCEPTION 'collection_window_closed' USING ERRCODE='23514'; END IF;
  SELECT count(*)::int INTO n FROM conditional_collection_events WHERE registration_id=h.registration_id AND event_text::jsonb->>'kind'='request_started';
  IF n>=(p->'collection'->>'maxHttpAttempts')::int THEN RAISE EXCEPTION 'collection_total_budget_exhausted' USING ERRCODE='23514'; END IF;
  SELECT count(*)::int INTO n FROM conditional_collection_events WHERE registration_id=h.registration_id AND event_text::jsonb->>'kind'='request_started'
   AND (recorded_at AT TIME ZONE 'UTC')::date=(NEW.recorded_at AT TIME ZONE 'UTC')::date;
  IF n>=(p->'collection'->>'maxDailyAttempts')::int THEN RAISE EXCEPTION 'collection_daily_budget_exhausted' USING ERRCODE='23514'; END IF;
  SELECT max(greatest(recorded_at+interval '5 seconds',(event_text::jsonb->'result'->>'retryAfterAt')::timestamptz)) INTO cooldown
   FROM conditional_collection_events WHERE registration_id=h.registration_id AND event_text::jsonb->'result'->>'status'='failed';
  IF NEW.recorded_at<cooldown THEN RAISE EXCEPTION 'collection_retry_after_active' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM conditional_collection_events WHERE registration_id=h.registration_id AND event_text::jsonb->'result'->>'httpStatus' IN ('401','403'))
  THEN RAISE EXCEPTION 'collection_provider_auth_failed' USING ERRCODE='23514'; END IF;
  PERFORM (c->>'requestId')::uuid;e:=jsonb_build_object('kind','request_started','requestId',c->>'requestId','endpoint',c->>'endpoint');
 ELSIF kind IN ('complete','recover') THEN
  IF pending.registration_id IS NULL OR pending.event_text::jsonb->>'requestId' IS DISTINCT FROM c->>'requestId'
  THEN RAISE EXCEPTION 'collection_no_matching_inflight_request' USING ERRCODE='23514'; END IF;
  IF kind='recover' THEN
   IF NEW.recorded_at<pending.recorded_at+interval '120 seconds' THEN RAISE EXCEPTION 'collection_recovery_not_expired' USING ERRCODE='23514'; END IF;
   IF length(coalesce(c->>'reason',''))<20 THEN RAISE EXCEPTION 'collection_recovery_reason_required' USING ERRCODE='23514'; END IF;
   e:=jsonb_build_object('kind','request_finished','requestId',c->>'requestId','result',jsonb_build_object('status','failed','httpStatus',NULL,'code','recovery_outcome_unknown','retryAfterAt',NULL));
  ELSE
   e:=jsonb_build_object('kind','request_finished','requestId',c->>'requestId','result',c->'result');
  END IF;
 ELSE RAISE EXCEPTION 'collection_unknown_command' USING ERRCODE='23514';
 END IF;
 e:=e||jsonb_build_object('sequence',NEW.sequence,'at',event_at);NEW.event_text:=e::text;
 NEW.head_sha256:=encode(sha256(convert_to(NEW.parent_sha256||':'||NEW.operation_id::text||':'||NEW.command_sha256||':'||NEW.event_text,'UTF8')),'hex');
 RETURN NEW;
END;
$$;
CREATE TRIGGER conditional_collection_header_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_collection_journals FOR EACH ROW EXECUTE FUNCTION guard_conditional_collection_header();
CREATE TRIGGER conditional_collection_header_no_truncate BEFORE TRUNCATE ON conditional_collection_journals FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_collection_header();
CREATE TRIGGER conditional_collection_event_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_collection_events FOR EACH ROW EXECUTE FUNCTION guard_conditional_collection_event();
CREATE TRIGGER conditional_collection_event_no_truncate BEFORE TRUNCATE ON conditional_collection_events FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_collection_event();
CREATE UNIQUE INDEX conditional_collection_request_once ON conditional_collection_events(registration_id,((event_text::jsonb)->>'requestId')) WHERE (event_text::jsonb)->>'kind'='request_started';
CREATE UNIQUE INDEX conditional_collection_completion_once ON conditional_collection_events(registration_id,((event_text::jsonb)->>'requestId')) WHERE (event_text::jsonb)->>'kind'='request_finished';
