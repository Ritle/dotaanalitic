-- Same immutable journal and UNIQUE(policy_sha256) for both formats. Old functions remain intact.
CREATE FUNCTION conditional_v2_literal_anchor(section TEXT, href TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE tag TEXT[];a TEXT[];attrs TEXT;names TEXT[];links TEXT[];valid BOOLEAN;name TEXT;
BEGIN
 FOR tag IN SELECT regexp_matches(section,'(<a\M([^"''<>]|"[^"]*"|''[^'']*'')*>)','gi') LOOP
  attrs:=substr(tag[1],3,length(tag[1])-3);names:=ARRAY[]::text[];links:=ARRAY[]::text[];valid:=true;
  WHILE btrim(attrs)<>'' AND btrim(attrs)<>'/' LOOP
   a:=regexp_match(attrs,'^([[:space:]]+([[:alpha:]][[:alnum:]_:-]*)([[:space:]]*=[[:space:]]*("([^"]*)"|''([^'']*)''|([^[:space:]"''=<>`]+)))?)');
   IF a IS NULL THEN valid:=false;EXIT;END IF;
   name:=lower(a[2]);IF name=ANY(names) THEN valid:=false;EXIT;END IF;names:=array_append(names,name);
   IF name='href' THEN links:=array_append(links,coalesce(a[5],a[6],a[7]));END IF;
   attrs:=substr(attrs,length(a[1])+1);
  END LOOP;
  IF valid AND cardinality(links)=1 AND links[1]=href THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END;
$$;
CREATE FUNCTION check_conditional_registration_v2(p JSONB, owner_id UUID, at_time TIMESTAMPTZ) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE policy JSONB;review JSONB;s JSONB;b JSONB;e JSONB;c JSONB;n JSONB;l JSONB;rows JSONB;r JSONB;
 review_at TIMESTAMPTZ;bound_at TIMESTAMPTZ;expected_host TEXT;edition TEXT;section TEXT;
BEGIN
 -- Exposure must include imports committed before the inventory lock, not an earlier transaction snapshot.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'conditional_v2_read_committed_required' USING ERRCODE='23514';
 END IF;
 policy:=(p->>'policyText')::jsonb;review:=p->'review';review_at:=(review->>'reviewedAt')::timestamptz;
 PERFORM id FROM app_users WHERE id=owner_id AND is_active AND account_role='owner' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'v2_active_owner_required' USING ERRCODE='23514';END IF;
 IF p->>'format' IS DISTINCT FROM 'conditional-real-registration-package-v2'
  OR p-ARRAY['format','policyText','candidateText','exposureText','exposureBaseText','exposureParentSha256','review','executable','collection']<>'{}'::jsonb
  OR encode(sha256(convert_to(p->>'policyText','UTF8')),'hex') IS DISTINCT FROM '77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f'
  OR encode(sha256(convert_to(p->>'candidateText','UTF8')),'hex') IS DISTINCT FROM '9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b'
  OR p->>'exposureParentSha256' IS DISTINCT FROM 'ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3'
  OR encode(sha256(convert_to(p->>'exposureBaseText','UTF8')),'hex') IS DISTINCT FROM '556378e083780d2ef388996a17c09a04bde2f61481d07c6640a9e832e0417b04'
  OR review->>'format' IS DISTINCT FROM 'conditional-tournament-binding-review-v2'
  OR review->>'policySha256' IS DISTINCT FROM '77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f'
  OR review->'syntheticOnly' IS DISTINCT FROM 'false'::jsonb OR review->>'reviewerUserId' IS DISTINCT FROM owner_id::text
  OR review-ARRAY['format','policySha256','syntheticOnly','reviewedAt','reviewerUserId','sources','bindings']<>'{}'::jsonb
  OR review_at IS NULL OR review_at>at_time OR at_time>=(policy->'proposedRegistration'->>'decisionDeadline')::timestamptz
  OR at_time>=(policy->'proposedRegistration'->>'from')::timestamptz
  OR (p->'executable'->>'capturedAt')::timestamptz IS NULL OR (p->'executable'->>'capturedAt')::timestamptz>review_at
  OR jsonb_typeof(p->'executable'->'environmentText') IS DISTINCT FROM 'string'
  OR coalesce(p->'executable'->>'environmentSha256','') !~ '^[a-f0-9]{64}$'
  OR NOT (p->'executable'->>'environmentText' IS JSON)
  OR encode(sha256(convert_to(p->'executable'->>'environmentText','UTF8')),'hex') IS DISTINCT FROM p->'executable'->>'environmentSha256'
  OR jsonb_typeof(p->'executable'->'code') IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_each(p->'executable'->'code'))>500
  OR EXISTS(SELECT 1 FROM jsonb_each_text(p->'executable'->'code') entry WHERE coalesce(entry.value,'') !~ '^[a-f0-9]{64}$'
    OR entry.key !~ '^(tools/|packages/|apps/|ml/|\.tools/s304-[a-z-]+-runtime/|pnpm-lock\.yaml$)' OR entry.key ~ '(\\|:|(^|/)\.\.(/|$))')
  OR NOT coalesce(p->'executable'->'code' ?& ARRAY['tools/research/conditional-real-registration-v2.mjs','tools/research/conditional-real-registration-v2-store.mjs',
   'tools/research/conditional-tournament-binding-v2.mjs','packages/db/migrations/066_conditional_registration_v2.sql',
   'tools/research/conditional-real-registration.mjs','tools/research/conditional-real-registration-store.mjs',
   'packages/db/migrations/063_conditional_real_registration.sql','tools/research/conditional_future_evaluate.py','pnpm-lock.yaml'],false)
  OR p->'collection'->>'discovery' IS DISTINCT FROM 'registered_league_and_global_cursor_reconciliation'
  OR p->'collection'->>'enrollment' IS DISTINCT FROM 'reviewed-native-event-register-v2'
  OR p->'collection'->>'assessmentMode' IS DISTINCT FROM 'one_terminal_assessment_after_window_and_grace'
  OR p->'collection'->'maxTargetMaps' IS DISTINCT FROM policy->'budget'->'maxTargetMaps'
  OR p->'collection'->'maxHttpAttempts' IS DISTINCT FROM policy->'budget'->'maxHttpAttemptsIncludingRetries'
  OR p->'collection'->'maxDailyAttempts' IS DISTINCT FROM policy->'budget'->'maxHttpAttemptsPerUtcDay'
  OR p->'collection'->'maxConcurrentRequests' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(review->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(review->'sources')>12
  OR jsonb_typeof(review->'bindings') IS DISTINCT FROM 'array' OR jsonb_array_length(review->'bindings')<>2
  OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(review->'sources') x)<>jsonb_array_length(review->'sources')
  OR (SELECT count(DISTINCT x->>'leagueId') FROM jsonb_array_elements(review->'bindings') x)<>2
  OR (SELECT count(DISTINCT x->>'editionKey') FROM jsonb_array_elements(review->'bindings') x)<>2
 THEN RAISE EXCEPTION 'conditional_v2_package_invalid' USING ERRCODE='23514';END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(review->'sources') LOOP
  IF jsonb_typeof(s->'bodyText') IS DISTINCT FROM 'string' OR coalesce(s->>'sha256','') !~ '^[a-f0-9]{64}$'
   OR s-ARRAY['id','url','bodyText','sha256','fetchedAt','knownAt','httpStatus','representation']<>'{}'::jsonb
   OR encode(sha256(convert_to(s->>'bodyText','UTF8')),'hex') IS DISTINCT FROM s->>'sha256'
   OR octet_length(s->>'bodyText') NOT BETWEEN 1 AND 16777216
   OR s->'knownAt' IS DISTINCT FROM 'null'::jsonb OR s->'httpStatus' IS DISTINCT FROM '200'::jsonb
   OR s->>'representation' IS DISTINCT FROM 'retained_http_utf8'
   OR (s->>'fetchedAt')::timestamptz IS NULL OR (s->>'fetchedAt')::timestamptz>review_at
   OR coalesce(s->>'url','') !~ '^https://(blast\.tv|pro\.eslgaming\.com|api\.opendota\.com|www\.opendota\.com|opendota\.com)(/|$)'
   OR s->>'url' ~ '[?#]' OR coalesce(s->>'id','') !~ '^[a-z][a-z0-9-]{0,63}$'
  THEN RAISE EXCEPTION 'conditional_v2_source_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR b IN SELECT value FROM jsonb_array_elements(review->'bindings') LOOP
  SELECT value INTO e FROM jsonb_array_elements(policy->'proposedRegistration'->'events') WHERE value->>'name'=b->>'editionKey';
  SELECT value INTO c FROM jsonb_array_elements(review->'sources') WHERE value->>'id'=b->'calendar'->>'sourceId';
  SELECT value INTO n FROM jsonb_array_elements(review->'sources') WHERE value->>'id'=b->'native'->>'sourceId';
  SELECT value INTO l FROM jsonb_array_elements(review->'sources') WHERE value->>'id'=b->'link'->>'sourceId';
  bound_at:=(b->'calendar'->'startBound'->>'at')::timestamptz;
  IF e IS NULL OR c IS NULL OR n IS NULL OR l IS NULL
   OR coalesce(b->>'leagueId','') !~ '^[1-9][0-9]{0,18}$' OR (b->>'leagueId')::numeric>9223372036854775807
   OR c->>'url' IS DISTINCT FROM e->>'source'
   OR lower(btrim(regexp_replace(b->'calendar'->>'editionExcerpt','\s+',' ','g'))) IS DISTINCT FROM lower(e->>'name')
   OR position(coalesce(b->'calendar'->>'editionExcerpt','') in c->>'bodyText')=0
   OR length(coalesce(b->'calendar'->>'periodExcerpt',''))=0 OR position(b->'calendar'->>'periodExcerpt' in c->>'bodyText')=0
   OR b->'calendar'->>'fromDate' IS DISTINCT FROM e->>'fromDate' OR b->'calendar'->>'throughDate' IS DISTINCT FROM e->>'throughDate'
   OR b->'calendar'->'startBound'->>'basis' IS DISTINCT FROM 'owner_reviewed_lower_bound'
   OR bound_at IS NULL OR bound_at<=at_time OR bound_at>((e->>'fromDate')::date::timestamp AT TIME ZONE 'UTC')
   OR length(coalesce(b->'calendar'->'startBound'->>'explanation',''))<20
   OR length(coalesce(b->'calendar'->>'reviewNote',''))<20 OR length(coalesce(b->'link'->>'reviewNote',''))<20
   OR n->>'url' IS DISTINCT FROM 'https://api.opendota.com/api/leagues'
  THEN RAISE EXCEPTION 'conditional_v2_binding_invalid' USING ERRCODE='23514';END IF;
  IF NOT (n->>'bodyText' IS JSON ARRAY WITH UNIQUE KEYS) THEN RAISE EXCEPTION 'conditional_v2_native_json_invalid' USING ERRCODE='23514';END IF;
  rows:=(n->>'bodyText')::jsonb;
  IF jsonb_array_length(rows)>30000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rows) x WHERE
    coalesce(x->>'leagueid','') !~ '^[1-9][0-9]{0,18}$' OR (x->>'leagueid')::numeric>9223372036854775807
    OR jsonb_typeof(x->'leagueid') NOT IN ('string','number') OR (jsonb_typeof(x->'leagueid')='number' AND (x->>'leagueid')::numeric>9007199254740991)
    OR jsonb_typeof(x->'name') IS DISTINCT FROM 'string')
   OR (SELECT count(DISTINCT x->>'leagueid') FROM jsonb_array_elements(rows) x)<>jsonb_array_length(rows)
  THEN RAISE EXCEPTION 'conditional_v2_native_id_invalid' USING ERRCODE='23514';END IF;
  SELECT value INTO r FROM jsonb_array_elements(rows) WHERE value->>'leagueid'=b->>'leagueId';
  edition:=lower(e->>'name');
  IF r IS NULL OR lower(btrim(regexp_replace(r->>'name','\s+',' ','g'))) IS DISTINCT FROM edition
   OR coalesce(r->>'tier','') NOT IN ('professional','premium')
   OR (SELECT count(*) FROM jsonb_array_elements(rows) x WHERE lower(btrim(regexp_replace(x->>'name','\s+',' ','g')))=edition)<>1
  THEN RAISE EXCEPTION 'conditional_v2_native_scope_invalid' USING ERRCODE='23514';END IF;
  section:=b->'link'->>'section';expected_host:=substring(e->>'source' from '^https://([^/]+)');
  IF substring(l->>'url' from '^https://([^/]+)') IS DISTINCT FROM expected_host
   OR length(coalesce(section,'')) NOT BETWEEN 1 AND 8000 OR position(section in l->>'bodyText')=0
   OR lower(regexp_replace(section,'\s+',' ','g')) !~ ('(^|[^[:alnum:]])'||edition||'([^[:alnum:]]|$)')
   OR section !~ ('(^|[^[:alnum:]])'||left(e->>'fromDate',4)||'([^[:alnum:]]|$)')
   OR section ~* 'qualif|division[[:space:]]*(2|ii)([^[:alnum:]]|$)'
   OR coalesce(b->'link'->>'href','') !~ ('^https://(www\.)?opendota\.com/leagues/'||(b->>'leagueId')||'/?$')
   OR NOT coalesce(conditional_v2_literal_anchor(section,b->'link'->>'href'),false)
  THEN RAISE EXCEPTION 'conditional_v2_organizer_link_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM check_conditional_real_exposure(p);
END;
$$;
CREATE FUNCTION guard_conditional_registration_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 NEW.recorded_at:=conditional_real_registration_clock();NEW.writer_txid:=txid_current()::text;
 IF NOT (NEW.package_text IS JSON OBJECT WITH UNIQUE KEYS)
  OR encode(sha256(convert_to(NEW.package_text,'UTF8')),'hex') IS DISTINCT FROM NEW.package_sha256
 THEN RAISE EXCEPTION 'conditional_v2_package_hash_or_json' USING ERRCODE='23514';END IF;
 PERFORM check_conditional_registration_v2(NEW.package_text::jsonb,NEW.owner_user_id,NEW.recorded_at);RETURN NEW;
END;
$$;
CREATE FUNCTION conditional_registration_is_v2(registration UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT package_text::jsonb->>'format'='conditional-real-registration-package-v2' FROM conditional_real_registrations WHERE id=registration),false);
$$;
CREATE FUNCTION guard_conditional_receipt_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r conditional_real_registrations%ROWTYPE;
BEGIN
 NEW.observed_committed_at:=conditional_real_registration_clock();NEW.observer_txid:=txid_current()::text;
 SELECT * INTO r FROM conditional_real_registrations WHERE id=NEW.registration_id;
 IF r.id IS NULL OR r.writer_txid=NEW.observer_txid OR r.package_sha256 IS DISTINCT FROM NEW.package_sha256
  OR NEW.observed_committed_at<r.recorded_at
 THEN RAISE EXCEPTION 'conditional_v2_commit_not_observed' USING ERRCODE='23514';END IF;
 PERFORM check_conditional_registration_v2(r.package_text::jsonb,r.owner_user_id,NEW.observed_committed_at);RETURN NEW;
END;
$$;
-- Route only INSERT by version; all mutation/truncate guards keep their v1 implementation.
DROP TRIGGER conditional_real_registration_guard ON conditional_real_registrations;
CREATE TRIGGER conditional_real_registration_guard BEFORE UPDATE OR DELETE ON conditional_real_registrations
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_real_registration();
CREATE TRIGGER conditional_real_registration_insert_v1 BEFORE INSERT ON conditional_real_registrations
 FOR EACH ROW WHEN (NEW.package_text::jsonb->>'format' IS DISTINCT FROM 'conditional-real-registration-package-v2') EXECUTE FUNCTION guard_conditional_real_registration();
CREATE TRIGGER conditional_real_registration_insert_v2 BEFORE INSERT ON conditional_real_registrations
 FOR EACH ROW WHEN (NEW.package_text::jsonb->>'format'='conditional-real-registration-package-v2') EXECUTE FUNCTION guard_conditional_registration_v2();
DROP TRIGGER conditional_real_receipt_guard ON conditional_real_registration_receipts;
CREATE TRIGGER conditional_real_receipt_guard BEFORE UPDATE OR DELETE ON conditional_real_registration_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_real_registration_receipt();
CREATE TRIGGER conditional_real_receipt_insert_v1 BEFORE INSERT ON conditional_real_registration_receipts
 FOR EACH ROW WHEN (NOT conditional_registration_is_v2(NEW.registration_id)) EXECUTE FUNCTION guard_conditional_real_registration_receipt();
CREATE TRIGGER conditional_real_receipt_insert_v2 BEFORE INSERT ON conditional_real_registration_receipts
 FOR EACH ROW WHEN (conditional_registration_is_v2(NEW.registration_id)) EXECUTE FUNCTION guard_conditional_receipt_v2();
CREATE FUNCTION guard_conditional_v2_collection_closed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF conditional_registration_is_v2(NEW.registration_id) THEN RAISE EXCEPTION 'conditional_v2_collection_not_implemented' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER conditional_v2_collection_closed BEFORE INSERT ON conditional_collection_journals
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_v2_collection_closed();
