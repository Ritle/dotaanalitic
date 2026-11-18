-- Separate real-plan journal; SQL062 and its synthetic readers remain unchanged.
-- No collection, assessment or model-activation permission is created by these records.
CREATE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS $$
 SELECT date_trunc('milliseconds',clock_timestamp());
$$;
CREATE TABLE conditional_real_registrations (
 id UUID PRIMARY KEY,
 owner_user_id UUID NOT NULL REFERENCES app_users(id),
 policy_sha256 TEXT NOT NULL UNIQUE CHECK(policy_sha256='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f'),
 package_text TEXT NOT NULL CHECK(octet_length(package_text)<=33554432),
 package_sha256 TEXT NOT NULL UNIQUE CHECK(package_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT conditional_real_registration_clock(),
 writer_txid TEXT NOT NULL
);
CREATE TABLE conditional_real_registration_receipts (
 registration_id UUID PRIMARY KEY REFERENCES conditional_real_registrations(id),
 package_sha256 TEXT NOT NULL,
 observed_committed_at TIMESTAMPTZ NOT NULL DEFAULT conditional_real_registration_clock(),
 observer_txid TEXT NOT NULL
);
CREATE FUNCTION check_conditional_real_exposure(p JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE base JSONB;x JSONB;maps JSONB;series_keys JSONB;
BEGIN
 -- Prevent imports from changing the known local inventory between this check and commit.
 LOCK TABLE matches,series IN SHARE MODE;
 IF encode(sha256(convert_to(p->>'exposureBaseText','UTF8')),'hex') IS DISTINCT FROM '556378e083780d2ef388996a17c09a04bde2f61481d07c6640a9e832e0417b04'
 THEN RAISE EXCEPTION 'conditional_real_exposure_base_changed' USING ERRCODE='23514'; END IF;
 base:=(p->>'exposureBaseText')::jsonb;x:=(p->>'exposureText')::jsonb;
 SELECT jsonb_agg(id ORDER BY id) INTO maps FROM
  (SELECT value AS id FROM jsonb_array_elements_text(base->'mapIds') UNION SELECT id::text FROM matches) a;
 SELECT jsonb_agg(id ORDER BY id) INTO series_keys FROM
  (SELECT value AS id FROM jsonb_array_elements_text(base->'canonicalSeriesKeys') UNION
   SELECT format('["opendota","%s"]',s.provider_series_id) FROM matches m JOIN series s ON s.id=m.series_id
    WHERE s.provider='opendota' AND s.provider_series_id ~ '^[1-9][0-9]{0,18}$') a;
 IF jsonb_typeof(x->'mapIds') IS DISTINCT FROM 'array' OR jsonb_typeof(x->'canonicalSeriesKeys') IS DISTINCT FROM 'array'
   OR NOT coalesce((x->'mapIds') @> maps AND maps @> (x->'mapIds'),false)
   OR NOT coalesce((x->'canonicalSeriesKeys') @> series_keys AND series_keys @> (x->'canonicalSeriesKeys'),false)
   OR jsonb_array_length(x->'mapIds')<>jsonb_array_length(maps)
   OR jsonb_array_length(x->'canonicalSeriesKeys')<>jsonb_array_length(series_keys)
   OR jsonb_array_length(x->'mapIds')>100000 OR jsonb_array_length(x->'canonicalSeriesKeys')>100000
 THEN RAISE EXCEPTION 'conditional_real_exposure_inventory_changed' USING ERRCODE='23514'; END IF;
END;
$$;
CREATE FUNCTION guard_conditional_real_registration() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p JSONB; policy JSONB; b JSONB; e JSONB; evidence JSONB; native JSONB; review_at TIMESTAMPTZ;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'conditional_real_registration_immutable' USING ERRCODE='55000'; END IF;
 NEW.recorded_at:=conditional_real_registration_clock(); NEW.writer_txid:=txid_current()::text;
 p:=NEW.package_text::jsonb; policy:=(p->>'policyText')::jsonb;review_at:=(p->'review'->>'reviewedAt')::timestamptz;
 IF NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active AND account_role='owner')
   OR encode(sha256(convert_to(NEW.package_text,'UTF8')),'hex') IS DISTINCT FROM NEW.package_sha256
   OR p->>'format' IS DISTINCT FROM 'conditional-real-registration-package-v1'
   OR encode(sha256(convert_to(p->>'policyText','UTF8')),'hex') IS DISTINCT FROM NEW.policy_sha256
   OR encode(sha256(convert_to(p->>'candidateText','UTF8')),'hex') IS DISTINCT FROM '9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b'
   OR p->>'exposureParentSha256' IS DISTINCT FROM 'ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3'
   OR encode(sha256(convert_to(p->>'exposureBaseText','UTF8')),'hex') IS DISTINCT FROM '556378e083780d2ef388996a17c09a04bde2f61481d07c6640a9e832e0417b04'
   OR p->'review'->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id::text
   OR review_at IS NULL OR review_at>NEW.recorded_at
   OR length(coalesce(p->'review'->>'reason',''))<20
   OR NEW.recorded_at>=(policy->'proposedRegistration'->>'decisionDeadline')::timestamptz
   OR NEW.recorded_at>=(policy->'proposedRegistration'->>'from')::timestamptz
   OR jsonb_typeof(p->'review'->'bindings') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'review'->'bindings')<>2
   OR (SELECT count(DISTINCT x->>'leagueId') FROM jsonb_array_elements(p->'review'->'bindings') x)<>2
   OR (SELECT count(DISTINCT x->>'editionKey') FROM jsonb_array_elements(p->'review'->'bindings') x)<>2
   OR (p->'executable'->>'capturedAt')::timestamptz IS NULL OR (p->'executable'->>'capturedAt')::timestamptz>review_at
   OR encode(sha256(convert_to(p->'executable'->>'environmentText','UTF8')),'hex') IS DISTINCT FROM p->'executable'->>'environmentSha256'
   OR NOT coalesce(p->'executable'->'code' ?& ARRAY['tools/research/conditional-real-registration.mjs','tools/research/conditional-real-registration-store.mjs',
    'packages/db/migrations/063_conditional_real_registration.sql','tools/research/conditional-registration.mjs','tools/research/conditional-registration-storage.mjs',
    'tools/research/conditional-enrollment.mjs','tools/research/conditional-evaluation.mjs','tools/research/conditional-future-source-binding.mjs',
    'tools/research/conditional-future-holdout.mts','tools/research/conditional_future_evaluate.py','tools/research/conditional-evaluator.mjs',
    'tools/research/player-hero-inference.mts','pnpm-lock.yaml'],false)
   OR p->'collection'->>'discovery' IS DISTINCT FROM 'registered_league_and_global_cursor_reconciliation'
   OR p->'collection'->>'enrollment' IS DISTINCT FROM 'reviewed-native-event-register-v1'
   OR p->'collection'->>'assessmentMode' IS DISTINCT FROM 'one_terminal_assessment_after_window_and_grace'
   OR p->'collection'->'maxTargetMaps' IS DISTINCT FROM policy->'budget'->'maxTargetMaps'
   OR p->'collection'->'maxHttpAttempts' IS DISTINCT FROM policy->'budget'->'maxHttpAttemptsIncludingRetries'
   OR p->'collection'->'maxDailyAttempts' IS DISTINCT FROM policy->'budget'->'maxHttpAttemptsPerUtcDay'
   OR p->'collection'->'maxConcurrentRequests' IS DISTINCT FROM '1'::jsonb
 THEN RAISE EXCEPTION 'conditional_real_package_invalid' USING ERRCODE='23514'; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(p->'review'->'bindings') LOOP
  SELECT value INTO e FROM jsonb_array_elements(policy->'proposedRegistration'->'events') WHERE value->>'name'=b->>'editionKey';
  IF e IS NULL OR b->>'stage' IS DISTINCT FROM 'main_event' OR coalesce(b->>'leagueId','') !~ '^[1-9][0-9]{0,18}$'
    OR (b->>'leagueId')::numeric>9223372036854775807
    OR b->'calendar'->>'url' IS DISTINCT FROM e->>'source'
    OR b->'startBound'->>'basis' IS DISTINCT FROM 'owner_reviewed_lower_bound'
    OR (b->'startBound'->>'at')::timestamptz IS NULL OR (b->'startBound'->>'at')::timestamptz<=NEW.recorded_at
    OR (b->'startBound'->>'at')::timestamptz>((e->>'fromDate')::date::timestamp AT TIME ZONE 'UTC')
    OR length(coalesce(b->'startBound'->>'explanation',''))<20 OR length(coalesce(b->>'reviewNote',''))<20
  THEN RAISE EXCEPTION 'conditional_real_scope_invalid' USING ERRCODE='23514'; END IF;
  FOR evidence IN SELECT value FROM jsonb_array_elements(jsonb_build_array(b->'calendar',b->'nativeReference')) LOOP
   IF encode(sha256(convert_to(evidence->>'bodyText','UTF8')),'hex') IS DISTINCT FROM evidence->>'sha256'
     OR (evidence->>'observedAt')::timestamptz IS NULL OR (evidence->>'observedAt')::timestamptz>review_at
     OR coalesce(evidence->>'url','') !~ '^https://(blast\.tv|pro\.eslgaming\.com|api\.opendota\.com|api\.stratz\.com|stratz\.com|api\.pandascore\.co)(/|$)'
   THEN RAISE EXCEPTION 'conditional_real_source_invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  native:=(b->'nativeReference'->>'bodyText')::jsonb;
  IF coalesce(b->'nativeReference'->>'nativeIdPointer','') !~ '^(/[A-Za-z0-9_-]+)+$'
    OR coalesce(b->'nativeReference'->>'organizerUrlPointer','') !~ '^(/[A-Za-z0-9_-]+)+$'
    OR (native #>> string_to_array(substr(b->'nativeReference'->>'nativeIdPointer',2),'/')) IS DISTINCT FROM b->>'leagueId'
    OR (native #>> string_to_array(substr(b->'nativeReference'->>'organizerUrlPointer',2),'/')) IS DISTINCT FROM b->'calendar'->>'url'
  THEN RAISE EXCEPTION 'conditional_real_numeric_reference_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM check_conditional_real_exposure(p);
 RETURN NEW;
END;
$$;
CREATE FUNCTION guard_conditional_real_registration_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r conditional_real_registrations%ROWTYPE;p JSONB;policy JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'conditional_real_receipt_immutable' USING ERRCODE='55000'; END IF;
 NEW.observed_committed_at:=conditional_real_registration_clock();NEW.observer_txid:=txid_current()::text;
 SELECT * INTO r FROM conditional_real_registrations WHERE id=NEW.registration_id;
 p:=r.package_text::jsonb;policy:=(p->>'policyText')::jsonb;
 IF r.id IS NULL OR r.writer_txid=NEW.observer_txid OR r.package_sha256 IS DISTINCT FROM NEW.package_sha256
   OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=r.owner_user_id AND is_active AND account_role='owner')
   OR NEW.observed_committed_at<r.recorded_at
   OR NEW.observed_committed_at>=(policy->'proposedRegistration'->>'decisionDeadline')::timestamptz
   OR NEW.observed_committed_at>=(policy->'proposedRegistration'->>'from')::timestamptz
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'review'->'bindings') b WHERE (b->'startBound'->>'at')::timestamptz<=NEW.observed_committed_at)
 THEN RAISE EXCEPTION 'conditional_real_commit_not_observed_in_time' USING ERRCODE='23514'; END IF;
 PERFORM check_conditional_real_exposure(p);
 RETURN NEW;
END;
$$;
CREATE TRIGGER conditional_real_registration_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_real_registrations
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_real_registration();
CREATE TRIGGER conditional_real_registration_no_truncate BEFORE TRUNCATE ON conditional_real_registrations
 FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_real_registration();
CREATE TRIGGER conditional_real_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_real_registration_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_real_registration_receipt();
CREATE TRIGGER conditional_real_receipt_no_truncate BEFORE TRUNCATE ON conditional_real_registration_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_real_registration_receipt();
