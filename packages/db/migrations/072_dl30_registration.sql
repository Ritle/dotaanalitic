-- One immutable December plan, isolated from the historical v1/v2 collectors.
CREATE TABLE dl30_registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 proposal_sha256 text NOT NULL DEFAULT '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045'
   CHECK (proposal_sha256='9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045'),
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 package_text text NOT NULL CHECK (octet_length(package_text) BETWEEN 1 AND 33554432),
 package_sha256 text NOT NULL UNIQUE CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL, writer_txid bigint NOT NULL
);
CREATE TABLE dl30_registration_receipts (
 registration_id uuid PRIMARY KEY REFERENCES dl30_registrations(id),
 package_sha256 text NOT NULL, observed_at timestamptz NOT NULL, observer_txid bigint NOT NULL
);
-- The table covers a single frozen proposal. At most one attempt can acquire a receipt.
CREATE UNIQUE INDEX dl30_one_confirmed_plan ON dl30_registration_receipts ((true));

CREATE FUNCTION dl30_inventory_current(ids jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS (
   (SELECT id::text FROM matches UNION SELECT provider_match_id FROM provider_ingest_receipts WHERE provider='opendota')
   EXCEPT SELECT value FROM jsonb_array_elements_text(ids->'mapIds')
 ) AND NOT EXISTS (
   (SELECT format('["opendota","%s"]',provider_series_id) FROM series WHERE provider='opendota'
    UNION SELECT format('["opendota","%s"]',source_payload->>'series_id') FROM provider_ingest_receipts
      WHERE provider='opendota' AND source_payload->>'series_id' ~ '^[1-9][0-9]*$')
   EXCEPT SELECT value FROM jsonb_array_elements_text(ids->'canonicalSeriesKeys')
 );
$$;
CREATE FUNCTION check_dl30_exclusions(floor_ids jsonb, ids jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(ids) IS DISTINCT FROM 'object' OR ids - ARRAY['mapIds','canonicalSeriesKeys'] <> '{}'::jsonb THEN
   RAISE EXCEPTION 'dl30_exclusions_invalid';
 END IF;
 FOREACH k IN ARRAY ARRAY['mapIds','canonicalSeriesKeys'] LOOP
   IF jsonb_typeof(ids->k) IS DISTINCT FROM 'array' OR jsonb_array_length(ids->k)>100000
     OR EXISTS (SELECT value FROM jsonb_array_elements(floor_ids->k) EXCEPT SELECT value FROM jsonb_array_elements(ids->k))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(ids->k) x GROUP BY x.value HAVING count(*)>1)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(ids->k) x WHERE jsonb_typeof(x.value)<>'string')
   THEN RAISE EXCEPTION 'dl30_exclusions_invalid'; END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(ids->'mapIds') x(id)
   WHERE id !~ '^[1-9][0-9]{0,18}$' OR id::numeric>9223372036854775807)
   OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ids->'canonicalSeriesKeys') x(id)
     WHERE id !~ '^\["opendota","[1-9][0-9]{0,18}"\]$' OR substring(id from '"([0-9]+)"\]$')::numeric>9223372036854775807)
 THEN RAISE EXCEPTION 'dl30_exclusions_invalid'; END IF;
 IF NOT dl30_inventory_current(ids) THEN RAISE EXCEPTION 'dl30_inventory_changed'; END IF;
END;
$$;

CREATE FUNCTION check_dl30_registration(p jsonb, owner_id uuid, at_time timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; review jsonb:=p->'review'; review_at timestamptz:=(review->>'reviewedAt')::timestamptz;
 s jsonb; b jsonb; e jsonb; c jsonb; n jsonb; l jsonb; rows jsonb; r jsonb;
 bound_at timestamptz; expected_host text; edition text; section text;
BEGIN
 IF p->>'format' IS DISTINCT FROM 'dl30-registration-v1'
   OR p - ARRAY['format','preparedText','floorText','exclusions','review','registrarSha256','migrationSha256'] <> '{}'::jsonb
   OR encode(sha256(convert_to(p->>'preparedText','UTF8')),'hex') IS DISTINCT FROM 'b0853f7a23dce9d111322a2b8bc436aaa8a00592d8527e4f74215d76144f5ac3'
   OR encode(sha256(convert_to(p->>'floorText','UTF8')),'hex') IS DISTINCT FROM 'd59ce0535a1a522b7ba517d62bd85a6fa7059b6d6a465359892718ba7c46b8d7'
   OR p->>'registrarSha256' IS DISTINCT FROM '69d8f2366808158a9089ef77b853d3cc391ce2c4480feea085eec8274d527b61'
   OR NOT EXISTS(SELECT 1 FROM schema_migrations WHERE filename='072_dl30_registration.sql' AND checksum=p->>'migrationSha256')
 THEN RAISE EXCEPTION 'dl30_package_changed'; END IF;
 scope:=(p->>'preparedText')::jsonb->'scope';
 IF at_time >= (scope->>'decisionDeadline')::timestamptz THEN RAISE EXCEPTION 'dl30_deadline'; END IF;
 IF review->>'format' IS DISTINCT FROM 'dl30-tournament-review-v1'
   OR review->>'policySha256' IS DISTINCT FROM '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045'
   OR review->'syntheticOnly' IS DISTINCT FROM 'false'::jsonb OR review->>'reviewerUserId' IS DISTINCT FROM owner_id::text
   OR NOT coalesce(isfinite(review_at),false) OR review_at>at_time
   OR jsonb_typeof(review->'bindings') IS DISTINCT FROM 'array' OR jsonb_array_length(review->'bindings')<>1
   OR jsonb_typeof(review->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(review->'sources')>12
   OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(review->'sources') x)<>jsonb_array_length(review->'sources')
 THEN RAISE EXCEPTION 'dl30_review_invalid'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(review->'sources') LOOP
  IF jsonb_typeof(s->'bodyText') IS DISTINCT FROM 'string' OR coalesce(s->>'sha256','') !~ '^[a-f0-9]{64}$'
   OR s-ARRAY['id','url','bodyText','sha256','fetchedAt','knownAt','httpStatus','representation']<>'{}'::jsonb
   OR encode(sha256(convert_to(s->>'bodyText','UTF8')),'hex') IS DISTINCT FROM s->>'sha256'
   OR octet_length(s->>'bodyText') NOT BETWEEN 1 AND 16777216
   OR s->'knownAt' IS DISTINCT FROM 'null'::jsonb OR s->'httpStatus' IS DISTINCT FROM '200'::jsonb
   OR s->>'representation' IS DISTINCT FROM 'retained_http_utf8'
   OR NOT coalesce(isfinite((s->>'fetchedAt')::timestamptz),false) OR (s->>'fetchedAt')::timestamptz>review_at
   OR coalesce(s->>'url','') !~ '^https://(blast\.tv|pro\.eslgaming\.com|api\.opendota\.com|www\.opendota\.com|opendota\.com)(/|$)'
   OR s->>'url' ~ '[?#]' OR coalesce(s->>'id','') !~ '^[a-z][a-z0-9-]{0,63}$'
  THEN RAISE EXCEPTION 'dl30_source_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR b IN SELECT value FROM jsonb_array_elements(review->'bindings') LOOP
  SELECT value INTO e FROM jsonb_array_elements(scope->'events') WHERE value->>'name'=b->>'editionKey';
  SELECT value INTO c FROM jsonb_array_elements(review->'sources') WHERE value->>'id'=b->'calendar'->>'sourceId';
  SELECT value INTO n FROM jsonb_array_elements(review->'sources') WHERE value->>'id'=b->'native'->>'sourceId';
  SELECT value INTO l FROM jsonb_array_elements(review->'sources') WHERE value->>'id'=b->'link'->>'sourceId';
  bound_at:=(b->'calendar'->'startBound'->>'at')::timestamptz;
  IF e IS NULL OR c IS NULL OR n IS NULL OR l IS NULL
   OR (e->'excludedOpenDotaQualifierIds') ? (b->>'leagueId')
   OR coalesce(b->>'leagueId','') !~ '^[1-9][0-9]{0,18}$' OR (b->>'leagueId')::numeric>9223372036854775807
   OR c->>'url' IS DISTINCT FROM e->>'calendar'
   OR lower(btrim(regexp_replace(b->'calendar'->>'editionExcerpt','\s+',' ','g'))) IS DISTINCT FROM lower(e->>'name')
   OR position(coalesce(b->'calendar'->>'editionExcerpt','') in c->>'bodyText')=0
   OR length(coalesce(b->'calendar'->>'periodExcerpt',''))=0 OR position(b->'calendar'->>'periodExcerpt' in c->>'bodyText')=0
   OR b->'calendar'->>'fromDate' IS DISTINCT FROM e->>'fromDate' OR b->'calendar'->>'throughDate' IS DISTINCT FROM e->>'throughDate'
   OR b->'calendar'->'startBound'->>'basis' IS DISTINCT FROM 'owner_reviewed_lower_bound'
   OR bound_at IS NULL OR bound_at<=at_time OR bound_at>((e->>'fromDate')::date::timestamp AT TIME ZONE 'UTC')
   OR length(coalesce(b->'calendar'->'startBound'->>'explanation',''))<20
   OR length(coalesce(b->'calendar'->>'reviewNote',''))<20 OR length(coalesce(b->'link'->>'reviewNote',''))<20
   OR n->>'url' IS DISTINCT FROM 'https://api.opendota.com/api/leagues'
  THEN RAISE EXCEPTION 'dl30_binding_invalid' USING ERRCODE='23514';END IF;
  IF NOT (n->>'bodyText' IS JSON ARRAY WITH UNIQUE KEYS) THEN RAISE EXCEPTION 'dl30_native_json_invalid' USING ERRCODE='23514';END IF;
  rows:=(n->>'bodyText')::jsonb;
  IF jsonb_array_length(rows)>30000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rows) x WHERE
    coalesce(x->>'leagueid','') !~ '^[1-9][0-9]{0,18}$' OR (x->>'leagueid')::numeric>9223372036854775807
    OR jsonb_typeof(x->'leagueid') NOT IN ('string','number') OR (jsonb_typeof(x->'leagueid')='number' AND (x->>'leagueid')::numeric>9007199254740991)
    OR jsonb_typeof(x->'name') IS DISTINCT FROM 'string')
   OR (SELECT count(DISTINCT x->>'leagueid') FROM jsonb_array_elements(rows) x)<>jsonb_array_length(rows)
  THEN RAISE EXCEPTION 'dl30_native_id_invalid' USING ERRCODE='23514';END IF;
  SELECT value INTO r FROM jsonb_array_elements(rows) WHERE value->>'leagueid'=b->>'leagueId';
  edition:=lower(e->>'name');
  IF r IS NULL OR lower(btrim(regexp_replace(r->>'name','\s+',' ','g'))) IS DISTINCT FROM edition
   OR coalesce(r->>'tier','') NOT IN ('professional','premium')
   OR (SELECT count(*) FROM jsonb_array_elements(rows) x WHERE lower(btrim(regexp_replace(x->>'name','\s+',' ','g')))=edition)<>1
  THEN RAISE EXCEPTION 'dl30_native_scope_invalid' USING ERRCODE='23514';END IF;
  section:=b->'link'->>'section';expected_host:=substring(e->>'calendar' from '^https://([^/]+)');
  IF substring(l->>'url' from '^https://([^/]+)') IS DISTINCT FROM expected_host
   OR length(coalesce(section,'')) NOT BETWEEN 1 AND 8000 OR position(section in l->>'bodyText')=0
   OR lower(regexp_replace(section,'\s+',' ','g')) !~ ('(^|[^[:alnum:]])'||edition||'([^[:alnum:]]|$)')
   OR section !~ ('(^|[^[:alnum:]])'||left(e->>'fromDate',4)||'([^[:alnum:]]|$)')
   OR section ~* 'qualif|division[[:space:]]*(2|ii)([^[:alnum:]]|$)'
   OR coalesce(b->'link'->>'href','') !~ ('^https://(www\.)?opendota\.com/leagues/'||(b->>'leagueId')||'/?$')
   OR NOT coalesce(conditional_v2_literal_anchor(section,b->'link'->>'href'),false)
  THEN RAISE EXCEPTION 'dl30_organizer_link_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM check_dl30_exclusions((p->>'floorText')::jsonb,p->'exclusions');
END;
$$;

CREATE FUNCTION guard_dl30_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved dl30_registrations%ROWTYPE; observed timestamptz; p jsonb; prior jsonb;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'dl30_registration_immutable'; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'dl30_read_committed_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045',0));
 IF TG_TABLE_NAME='dl30_registrations' THEN
   saved:=NEW;
   IF NOT (saved.package_text IS JSON OBJECT WITH UNIQUE KEYS)
      OR encode(sha256(convert_to(saved.package_text,'UTF8')),'hex') IS DISTINCT FROM saved.package_sha256
   THEN RAISE EXCEPTION 'dl30_package_hash_invalid'; END IF;
 ELSE
   SELECT * INTO STRICT saved FROM dl30_registrations WHERE id=NEW.registration_id FOR SHARE;
   IF saved.writer_txid=txid_current() OR NEW.package_sha256 IS DISTINCT FROM saved.package_sha256 THEN
     RAISE EXCEPTION 'dl30_commit_unobserved';
   END IF;
 END IF;
 PERFORM id FROM app_users WHERE id=saved.owner_user_id AND is_active AND account_role='owner' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'dl30_active_owner_required'; END IF;
 LOCK TABLE matches,series,provider_ingest_receipts IN SHARE MODE;
 observed:=conditional_real_registration_clock();
 p:=saved.package_text::jsonb;
 PERFORM check_dl30_registration(p,saved.owner_user_id,observed);
 IF TG_TABLE_NAME='dl30_registrations' THEN
   IF EXISTS (SELECT 1 FROM dl30_registration_receipts) THEN RAISE EXCEPTION 'registration_already_bound'; END IF;
   -- An import between commits may invalidate a pending attempt. Only an append-only
   -- inventory refresh of the same reviewed scope may supersede it before the deadline.
   FOR prior IN SELECT package_text::jsonb FROM dl30_registrations LOOP
     IF dl30_inventory_current(prior->'exclusions')
       OR (p-'exclusions' #- '{review,reviewedAt}') IS DISTINCT FROM (prior-'exclusions' #- '{review,reviewedAt}')
       OR (p#>>'{review,reviewedAt}')::timestamptz < (prior#>>'{review,reviewedAt}')::timestamptz
       OR NOT ((p->'exclusions') @> (prior->'exclusions'))
     THEN RAISE EXCEPTION 'registration_already_bound'; END IF;
   END LOOP;
   NEW.recorded_at:=observed; NEW.writer_txid:=txid_current();
 ELSE
   IF observed<saved.recorded_at THEN RAISE EXCEPTION 'dl30_clock_regression'; END IF;
   NEW.observed_at:=observed; NEW.observer_txid:=txid_current();
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dl30_register BEFORE INSERT OR UPDATE OR DELETE ON dl30_registrations FOR EACH ROW EXECUTE FUNCTION guard_dl30_registration();
CREATE TRIGGER dl30_receipt BEFORE INSERT OR UPDATE OR DELETE ON dl30_registration_receipts FOR EACH ROW EXECUTE FUNCTION guard_dl30_registration();
CREATE TRIGGER dl30_register_no_truncate BEFORE TRUNCATE ON dl30_registrations FOR EACH STATEMENT EXECUTE FUNCTION guard_dl30_registration();
CREATE TRIGGER dl30_receipt_no_truncate BEFORE TRUNCATE ON dl30_registration_receipts FOR EACH STATEMENT EXECUTE FUNCTION guard_dl30_registration();
