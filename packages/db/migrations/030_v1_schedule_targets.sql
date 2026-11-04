CREATE TABLE v1_schedule_targets (
  owner_user_id UUID NOT NULL REFERENCES app_users(id),provider_match_id BIGINT NOT NULL CHECK(provider_match_id>0),
  revision INTEGER NOT NULL CHECK(revision>0),request_id UUID NOT NULL,request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  observation_id BIGINT NOT NULL REFERENCES upcoming_source_observations(id),
  record_text TEXT NOT NULL CHECK(octet_length(record_text) BETWEEN 1 AND 32768),
  record_sha256 CHAR(64) NOT NULL CHECK(record_sha256=encode(sha256(convert_to(record_text,'UTF8')),'hex')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_user_id,provider_match_id,revision),UNIQUE(owner_user_id,request_id)
);
CREATE FUNCTION validate_v1_schedule_target() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r jsonb:=NEW.record_text::jsonb; q jsonb:=r->'request'; o jsonb:=r->'observation';
  previous v1_schedule_targets%ROWTYPE; source upcoming_source_observations%ROWTYPE; m jsonb;
  newest_id BIGINT; omitted INTEGER; selected TIMESTAMPTZ:=(r->>'selectedAt')::timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-target:'||NEW.owner_user_id::text,0));
  LOCK TABLE upcoming_source_observations IN SHARE MODE;
  SELECT * INTO previous FROM v1_schedule_targets WHERE owner_user_id=NEW.owner_user_id AND provider_match_id=NEW.provider_match_id ORDER BY revision DESC LIMIT 1;
  SELECT * INTO source FROM upcoming_source_observations WHERE id=NEW.observation_id;
  WITH recent AS (SELECT * FROM upcoming_source_observations WHERE cache_key='schedule' ORDER BY recorded_at DESC,id DESC LIMIT 200)
    SELECT id INTO newest_id FROM recent WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=NEW.provider_match_id::text)
    ORDER BY recorded_at DESC,id DESC LIMIT 1;
  SELECT count(*) INTO omitted FROM upcoming_source_observations WHERE cache_key='schedule' AND (recorded_at,id)>(source.recorded_at,source.id);
  IF source.id IS NULL OR source.id IS DISTINCT FROM newest_id OR source.cache_key<>'schedule'
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
CREATE TRIGGER trg_v1_schedule_target_validate BEFORE INSERT ON v1_schedule_targets FOR EACH ROW EXECUTE FUNCTION validate_v1_schedule_target();
CREATE TRIGGER trg_v1_schedule_target_immutable BEFORE UPDATE OR DELETE ON v1_schedule_targets FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_v1_schedule_target_no_truncate BEFORE TRUNCATE ON v1_schedule_targets FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
