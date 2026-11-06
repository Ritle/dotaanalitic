-- schedule-pages-source-v2: preserve source tables/bytes; namespace IDs by their real endpoint.
CREATE VIEW forecast_schedule_observations_v2 AS
 SELECT id,1::integer AS page,source_endpoint,source_payload_sha256,source_fetched_at,recorded_at,snapshot_sha256,snapshot_text
 FROM upcoming_source_observations WHERE cache_key='schedule'
 UNION ALL
 SELECT id,page,source_endpoint,source_payload_sha256,source_fetched_at,recorded_at,snapshot_sha256,snapshot_text FROM upcoming_page_observations;
-- A later observation of the same meeting on the same page supersedes its prior
-- observation even when it carries an old fetched clock. Omissions never renew age.
CREATE FUNCTION current_forecast_schedule_v2(meeting_id BIGINT) RETURNS SETOF forecast_schedule_observations_v2 LANGUAGE sql STABLE AS $$
 WITH recent AS (SELECT * FROM forecast_schedule_observations_v2 ORDER BY recorded_at DESC,page ASC,id DESC LIMIT 200),
 per_page AS (SELECT DISTINCT ON (page) * FROM recent WHERE EXISTS
  (SELECT 1 FROM jsonb_array_elements(snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=meeting_id::text)
  ORDER BY page,recorded_at DESC,id DESC)
 SELECT * FROM per_page ORDER BY source_fetched_at DESC,recorded_at DESC,page ASC,id DESC LIMIT 1;
$$;
CREATE FUNCTION forecast_schedule_omissions_v2(meeting_id BIGINT,source_time TIMESTAMPTZ,source_page INTEGER,source_id BIGINT)
 RETURNS INTEGER LANGUAGE sql STABLE AS $$
 SELECT count(*)::integer FROM forecast_schedule_observations_v2 WHERE (recorded_at,-page,id)>(source_time,-source_page,source_id)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=meeting_id::text);
$$;
ALTER TABLE v1_schedule_targets ALTER COLUMN observation_id DROP NOT NULL;
ALTER TABLE v1_schedule_targets ADD COLUMN page_observation_id BIGINT REFERENCES upcoming_page_observations(id);
ALTER TABLE v1_schedule_targets ADD CONSTRAINT schedule_target_source_namespace CHECK ((observation_id IS NULL) <> (page_observation_id IS NULL));
-- Both source histories are immutable, including TRUNCATE and cascading deletion attempts.
CREATE TRIGGER trg_upcoming_source_observations_no_truncate BEFORE TRUNCATE ON upcoming_source_observations FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_upcoming_page_observations_no_truncate BEFORE TRUNCATE ON upcoming_page_observations FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE FUNCTION validate_page_schedule_target_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r jsonb:=NEW.record_text::jsonb; q jsonb:=r->'request'; o jsonb:=r->'observation';
  previous v1_schedule_targets%ROWTYPE; source forecast_schedule_observations_v2%ROWTYPE; m jsonb;
  newest_id BIGINT; newest_page INTEGER; omitted INTEGER; selected TIMESTAMPTZ:=(r->>'selectedAt')::timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-target:'||NEW.owner_user_id::text,0));
  LOCK TABLE upcoming_source_observations,upcoming_page_observations IN SHARE MODE;
  SELECT * INTO previous FROM v1_schedule_targets WHERE owner_user_id=NEW.owner_user_id AND provider_match_id=NEW.provider_match_id ORDER BY revision DESC LIMIT 1;
  SELECT * INTO source FROM forecast_schedule_observations_v2 WHERE (page=1 AND id=NEW.observation_id) OR (page>1 AND id=NEW.page_observation_id);
  SELECT id,page INTO newest_id,newest_page FROM current_forecast_schedule_v2(NEW.provider_match_id);
  omitted:=forecast_schedule_omissions_v2(NEW.provider_match_id,source.recorded_at,source.page,source.id);
  IF source.id IS NULL OR source.id IS DISTINCT FROM newest_id OR source.page IS DISTINCT FROM newest_page
    OR source.snapshot_sha256<>encode(sha256(convert_to(source.snapshot_text,'UTF8')),'hex')
    OR source.source_payload_sha256 IS DISTINCT FROM source.snapshot_text::jsonb#>>'{source,payloadSha256}'
    OR source.source_endpoint IS DISTINCT FROM source.snapshot_text::jsonb#>>'{source,endpoint}'
    OR source.source_fetched_at IS DISTINCT FROM (source.snapshot_text::jsonb#>>'{source,fetchedAt}')::timestamptz
    OR (SELECT count(*) FROM jsonb_array_elements(source.snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=NEW.provider_match_id::text)<>1
    THEN RAISE EXCEPTION 'schedule_target_source_required'; END IF;
  SELECT e INTO m FROM jsonb_array_elements(source.snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=NEW.provider_match_id::text;
  IF m->>'status' IS DISTINCT FROM 'not_started' OR m->>'scheduledAt' IS NULL OR (m->>'scheduledAt')::timestamptz<=clock_timestamp()
    OR selected IS NULL OR selected<transaction_timestamp() OR selected>clock_timestamp() OR source.recorded_at>selected
    OR jsonb_array_length(m->'opponents')<>2
    OR (SELECT count(DISTINCT t->>'providerTeamId') FROM jsonb_array_elements(m->'opponents') t)<>2
    THEN RAISE EXCEPTION 'schedule_target_not_upcoming'; END IF;
  IF r->>'format' IS DISTINCT FROM 'v1-schedule-target-v1' OR r->>'provider' IS DISTINCT FROM 'pandascore'
    OR r->>'mapBinding' IS DISTINCT FROM 'pending' OR r->'probability' IS DISTINCT FROM 'null'::jsonb
    OR r->>'mappingBasis' IS DISTINCT FROM 'owner_reviewed'
    OR q->>'requestId' IS DISTINCT FROM NEW.request_id::text OR q->>'providerMatchId' IS DISTINCT FROM NEW.provider_match_id::text
    OR q->>'mapNumber' IS DISTINCT FROM '1' OR q->>'observationId' IS DISTINCT FROM source.id::text
    OR q->>'observationSha256' IS DISTINCT FROM source.snapshot_sha256::text
    OR r->>'revision' IS DISTINCT FROM NEW.revision::text OR NEW.revision<>coalesce(previous.revision,0)+1
    OR q->>'expectedRevision' IS DISTINCT FROM (NEW.revision-1)::text OR r->>'previousSha256' IS DISTINCT FROM previous.record_sha256::text
    OR o->'match' IS DISTINCT FROM m OR o->>'id' IS DISTINCT FROM source.id::text
    OR o->>'snapshotSha256' IS DISTINCT FROM source.snapshot_sha256::text OR o->>'sourcePayloadSha256' IS DISTINCT FROM source.source_payload_sha256::text
    OR o->>'endpoint' IS DISTINCT FROM source.source_endpoint OR o->>'adapterVersion' IS DISTINCT FROM source.snapshot_text::jsonb#>>'{source,adapterVersion}'
    OR (o->>'fetchedAt')::timestamptz IS DISTINCT FROM source.source_fetched_at OR (o->>'recordedAt')::timestamptz IS DISTINCT FROM source.recorded_at
    OR o->'knownAt' IS DISTINCT FROM 'null'::jsonb OR r->>'omittingLaterPages' IS DISTINCT FROM omitted::text
    OR coalesce(length(trim(q->>'reason')),0) NOT BETWEEN 20 AND 1000 OR coalesce(q->>'reviewSourceUrl','') !~ '^https://'
    OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active)
    THEN RAISE EXCEPTION 'schedule_target_record_binding'; END IF;
  IF q->>'teamAId'=q->>'teamBId' OR q->>'providerTeamAId'=q->>'providerTeamBId'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m->'opponents') t WHERE t->>'providerTeamId'=q->>'providerTeamAId')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m->'opponents') t WHERE t->>'providerTeamId'=q->>'providerTeamBId')
    OR NOT EXISTS(SELECT 1 FROM teams WHERE id::text=q->>'teamAId' AND name=r->>'teamAName')
    OR NOT EXISTS(SELECT 1 FROM teams WHERE id::text=q->>'teamBId' AND name=r->>'teamBName')
    OR (q->>'leagueId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM leagues WHERE id::text=q->>'leagueId' AND name=r->>'leagueName'))
    OR (q->>'leagueId' IS NULL AND r->'leagueName' IS DISTINCT FROM 'null'::jsonb)
    THEN RAISE EXCEPTION 'schedule_target_mapping'; END IF;
  NEW.recorded_at=selected;RETURN NEW;
END;
$$;
CREATE FUNCTION validate_page_scheduled_runtime_v2(owner_id UUID,target_request UUID,s JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE t v1_schedule_targets%ROWTYPE; o forecast_schedule_observations_v2%ROWTYPE; latest_request UUID;
  b jsonb:=s#>'{targetReview,scheduleBinding}'; ref jsonb:=s#>'{request,realTarget}'; m jsonb;
  checked TIMESTAMPTZ:=(b->>'checkedAt')::timestamptz; created TIMESTAMPTZ:=(s->>'createdAt')::timestamptz; omitted INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-target:'||owner_id::text,0));
  LOCK TABLE upcoming_source_observations,upcoming_page_observations IN SHARE MODE;
  SELECT * INTO t FROM v1_schedule_targets WHERE owner_user_id=owner_id AND request_id=target_request;
  SELECT request_id INTO latest_request FROM v1_schedule_targets WHERE owner_user_id=owner_id AND provider_match_id=t.provider_match_id ORDER BY revision DESC LIMIT 1;
  IF t.request_id IS NULL OR latest_request IS DISTINCT FROM target_request
    OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=owner_id AND is_active)
    OR ref->>'bindingVersion' IS DISTINCT FROM '1' OR ref->>'mapNumber' IS DISTINCT FROM '1'
    OR ref->>'targetRequestId' IS DISTINCT FROM target_request::text OR ref->>'targetSha256' IS DISTINCT FROM t.record_sha256::text
    OR ref->>'providerMatchId' IS DISTINCT FROM t.provider_match_id::text
    OR b->>'format' IS DISTINCT FROM 'v1-schedule-runtime-binding-v2'
    OR b#>'{target,record}' IS DISTINCT FROM t.record_text::jsonb OR b#>>'{target,sha256}' IS DISTINCT FROM t.record_sha256::text
    OR checked IS NULL OR checked<transaction_timestamp() OR checked>created OR created>clock_timestamp() OR t.recorded_at>checked
    THEN RAISE EXCEPTION 'scheduled_target_reference_mismatch'; END IF;
  SELECT * INTO o FROM current_forecast_schedule_v2(t.provider_match_id);
  omitted:=forecast_schedule_omissions_v2(t.provider_match_id,o.recorded_at,o.page,o.id);
  SELECT e INTO m FROM jsonb_array_elements(o.snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=t.provider_match_id::text;
  IF o.id IS NULL OR o.snapshot_sha256<>encode(sha256(convert_to(o.snapshot_text,'UTF8')),'hex')
    OR o.source_payload_sha256 IS DISTINCT FROM o.snapshot_text::jsonb#>>'{source,payloadSha256}'
    OR o.source_fetched_at IS DISTINCT FROM (o.snapshot_text::jsonb#>>'{source,fetchedAt}')::timestamptz
    OR o.source_endpoint IS DISTINCT FROM o.snapshot_text::jsonb#>>'{source,endpoint}'
    OR b#>>'{currentObservation,id}' IS DISTINCT FROM o.id::text OR b#>>'{currentObservation,snapshotSha256}' IS DISTINCT FROM o.snapshot_sha256::text
    OR b#>>'{currentObservation,sourcePayloadSha256}' IS DISTINCT FROM o.source_payload_sha256::text
    OR b#>>'{currentObservation,endpoint}' IS DISTINCT FROM o.source_endpoint
    OR b#>>'{currentObservation,adapterVersion}' IS DISTINCT FROM o.snapshot_text::jsonb#>>'{source,adapterVersion}'
    OR (b#>>'{currentObservation,fetchedAt}')::timestamptz IS DISTINCT FROM o.source_fetched_at
    OR (b#>>'{currentObservation,recordedAt}')::timestamptz IS DISTINCT FROM o.recorded_at
    OR b#>'{currentObservation,knownAt}' IS DISTINCT FROM 'null'::jsonb OR b#>'{currentObservation,match}' IS DISTINCT FROM m
    OR b->>'omittingLaterPages' IS DISTINCT FROM omitted::text OR o.recorded_at>checked OR o.source_fetched_at>checked
    OR m IS DISTINCT FROM t.record_text::jsonb#>'{observation,match}'
    OR (SELECT count(*) FROM jsonb_array_elements(o.snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=t.provider_match_id::text)<>1
    OR m->>'status' IS DISTINCT FROM 'not_started' OR m->>'scheduledAt' IS NULL OR (m->>'scheduledAt')::timestamptz<=checked
    OR (s->>'status'='done' AND (m->>'scheduledAt')::timestamptz<=clock_timestamp())
    THEN RAISE EXCEPTION 'scheduled_target_source_changed'; END IF;
  IF s#>'{scenario,input,teamAId}' IS DISTINCT FROM t.record_text::jsonb#>'{request,teamAId}'
    OR s#>'{scenario,input,teamBId}' IS DISTINCT FROM t.record_text::jsonb#>'{request,teamBId}'
    OR s#>'{scenario,input,context,leagueId}' IS DISTINCT FROM t.record_text::jsonb#>'{request,leagueId}'
    OR s#>'{scenario,input,scheduledAt}' IS DISTINCT FROM m->'scheduledAt'
    OR s#>>'{scenario,input,context,mapNumber}' IS DISTINCT FROM '1'
    OR s#>'{scenario,input,context,seriesId}' IS DISTINCT FROM 'null'::jsonb
    OR coalesce((s#>>'{scenario,input,context,teamASeriesWinsBefore}')::integer,0)<>0
    OR coalesce((s#>>'{scenario,input,context,teamBSeriesWinsBefore}')::integer,0)<>0
    THEN RAISE EXCEPTION 'scheduled_target_scenario_mismatch'; END IF;
END;
$$;


DROP TRIGGER trg_v1_schedule_target_validate ON v1_schedule_targets;
CREATE TRIGGER trg_v1_schedule_target_validate BEFORE INSERT ON v1_schedule_targets FOR EACH ROW
 EXECUTE FUNCTION validate_page_schedule_target_v2();
-- Every new row, including a legacy CLI request, checks both immutable histories.
ALTER TABLE v1_schedule_targets ADD CONSTRAINT schedule_target_warnings_required CHECK
 ((record_text::jsonb->'warnings') IS NOT NULL AND jsonb_typeof(record_text::jsonb->'warnings')='array');

ALTER FUNCTION validate_v1_scheduled_runtime(UUID,UUID,JSONB) RENAME TO validate_original_scheduled_runtime_v1;
CREATE FUNCTION validate_v1_scheduled_runtime(owner_id UUID,target_request UUID,s JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE o forecast_schedule_observations_v2%ROWTYPE;
BEGIN
 IF s#>>'{targetReview,scheduleBinding,format}'='v1-schedule-runtime-binding-v2' THEN
  PERFORM validate_page_scheduled_runtime_v2(owner_id,target_request,s);
 ELSE
  PERFORM validate_original_scheduled_runtime_v1(owner_id,target_request,s);
  LOCK TABLE upcoming_page_observations IN SHARE MODE;
  SELECT * INTO o FROM current_forecast_schedule_v2((s#>>'{request,realTarget,providerMatchId}')::bigint);
  IF o.id IS NULL OR o.source_endpoint IS DISTINCT FROM s#>>'{targetReview,scheduleBinding,currentObservation,endpoint}'
   OR o.id::text IS DISTINCT FROM s#>>'{targetReview,scheduleBinding,currentObservation,id}'
   OR o.snapshot_sha256::text IS DISTINCT FROM s#>>'{targetReview,scheduleBinding,currentObservation,snapshotSha256}'
   THEN RAISE EXCEPTION 'scheduled_target_source_changed'; END IF;
 END IF;
END;
$$;
CREATE OR REPLACE FUNCTION guard_schedule_target_freshness_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE fetched TIMESTAMPTZ; reason TEXT;
BEGIN
 SELECT source_fetched_at INTO fetched FROM forecast_schedule_observations_v2
  WHERE (page=1 AND id=NEW.observation_id) OR (page>1 AND id=NEW.page_observation_id);
 reason:=schedule_source_freshness_reason_v1(fetched,clock_timestamp());
 IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason; END IF; RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION guard_scheduled_runtime_freshness_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s JSONB:=NEW.snapshot_text::jsonb; fetched TIMESTAMPTZ; reason TEXT;
BEGIN
 IF s#>>'{request,purpose}'='real_map' AND s#>>'{request,realTarget,provider}'='pandascore' THEN
  SELECT source_fetched_at INTO fetched FROM forecast_schedule_observations_v2
   WHERE id=(s#>>'{targetReview,scheduleBinding,currentObservation,id}')::bigint
    AND source_endpoint=s#>>'{targetReview,scheduleBinding,currentObservation,endpoint}';
  reason:=schedule_source_freshness_reason_v1(fetched,clock_timestamp());
  IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason; END IF;
 END IF; RETURN NEW;
END;
$$;
