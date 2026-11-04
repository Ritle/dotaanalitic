-- Owner-reported meeting lifecycle is shared by all immutable schedule revisions.
CREATE TABLE v1_scheduled_lifecycle (
  owner_user_id UUID NOT NULL REFERENCES app_users(id),provider_match_id BIGINT NOT NULL CHECK(provider_match_id>0),
  revision INTEGER NOT NULL CHECK(revision>0),request_id UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  event_text TEXT NOT NULL CHECK(octet_length(event_text) BETWEEN 1 AND 16384),
  event_sha256 CHAR(64) NOT NULL CHECK(event_sha256=encode(sha256(convert_to(event_text,'UTF8')),'hex')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_user_id,provider_match_id,revision),UNIQUE(owner_user_id,request_id)
);
CREATE FUNCTION validate_v1_scheduled_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE previous v1_scheduled_lifecycle%ROWTYPE; e jsonb:=NEW.event_text::jsonb; r jsonb:=e->'request';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-journal:'||NEW.owner_user_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-result:'||NEW.owner_user_id::text,0));
  SELECT * INTO previous FROM v1_scheduled_lifecycle WHERE owner_user_id=NEW.owner_user_id
    AND provider_match_id=NEW.provider_match_id ORDER BY revision DESC LIMIT 1;
  IF NOT EXISTS(SELECT 1 FROM v1_schedule_targets WHERE owner_user_id=NEW.owner_user_id
    AND request_id=(r->>'targetRequestId')::uuid AND provider_match_id=NEW.provider_match_id)
    OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active)
    THEN RAISE EXCEPTION 'lifecycle_target_required'; END IF;
  IF e->>'format' IS DISTINCT FROM 'v1-scheduled-lifecycle-v1' OR e->>'source' IS DISTINCT FROM 'owner_reported'
    OR e->>'ownerId' IS DISTINCT FROM NEW.owner_user_id::text OR e#>>'{target,provider}' IS DISTINCT FROM 'pandascore'
    OR e#>>'{target,providerMatchId}' IS DISTINCT FROM NEW.provider_match_id::text OR e#>>'{target,mapNumber}' IS DISTINCT FROM '1'
    OR e->>'revision' IS DISTINCT FROM NEW.revision::text OR r->>'requestId' IS DISTINCT FROM NEW.request_id::text
    OR NEW.revision<>coalesce(previous.revision,0)+1 OR r->>'expectedRevision' IS DISTINCT FROM (NEW.revision-1)::text
    OR e->>'previousSha256' IS DISTINCT FROM previous.event_sha256::text
    OR coalesce(r->>'action','') NOT IN ('cancelled','reopened') OR (previous.revision IS NULL AND r->>'action'<>'cancelled')
    OR r->>'action'=previous.event_text::jsonb#>>'{request,action}'
    OR coalesce(length(trim(r->>'reason')),0) NOT BETWEEN 10 AND 1000
    OR coalesce(r->>'sourceUrl','') !~ '^https?://' OR length(r->>'sourceUrl')>2048
    OR e->>'recordedAt' IS NULL OR (e->>'recordedAt')::timestamptz>clock_timestamp()
    OR (e->>'recordedAt')::timestamptz<transaction_timestamp()
    OR (previous.revision IS NOT NULL AND (e->>'recordedAt')::timestamptz<previous.recorded_at)
    OR (r->>'eventAt')::timestamptz>(e->>'recordedAt')::timestamptz
    THEN RAISE EXCEPTION 'lifecycle_event_binding'; END IF;
  NEW.recorded_at=(e->>'recordedAt')::timestamptz;RETURN NEW;
END;
$$;
CREATE TRIGGER trg_v1_scheduled_lifecycle_validate BEFORE INSERT ON v1_scheduled_lifecycle FOR EACH ROW EXECUTE FUNCTION validate_v1_scheduled_lifecycle();
CREATE TRIGGER trg_v1_scheduled_lifecycle_immutable BEFORE UPDATE OR DELETE ON v1_scheduled_lifecycle FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_v1_scheduled_lifecycle_no_truncate BEFORE TRUNCATE ON v1_scheduled_lifecycle FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();

CREATE OR REPLACE FUNCTION guard_v1_scheduled_issuance(owner_id UUID,meeting_id BIGINT,status TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-result:'||owner_id::text,0));
  IF status='done' AND EXISTS(SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=owner_id AND provider_match_id=meeting_id)
    THEN RAISE EXCEPTION 'forecast_target_already_started_or_ambiguous'; END IF;
  IF status='done' AND (SELECT event_text::jsonb#>>'{request,action}' FROM v1_scheduled_lifecycle
    WHERE owner_user_id=owner_id AND provider_match_id=meeting_id ORDER BY revision DESC LIMIT 1)='cancelled'
    THEN RAISE EXCEPTION 'forecast_target_owner_cancelled'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_v1_journal_report() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE previous v1_journal_reports%ROWTYPE; r jsonb:=NEW.report_text::jsonb; i jsonb:=NEW.input_text::jsonb;
  obs jsonb; original jsonb; current_verification jsonb; expected_lifecycle jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-journal:'||NEW.owner_user_id::text,0));
  SELECT * INTO previous FROM v1_journal_reports WHERE owner_user_id=NEW.owner_user_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.previous_sha256 IS DISTINCT FROM previous.report_sha256
    OR r->>'ownerId' IS DISTINCT FROM NEW.owner_user_id::text OR r->>'revision' IS DISTINCT FROM NEW.revision::text
    OR r#>>'{request,requestId}' IS DISTINCT FROM NEW.request_id::text
    OR r->>'previousSha256' IS DISTINCT FROM NEW.previous_sha256::text
    OR r->>'inputSha256' IS DISTINCT FROM NEW.input_sha256::text
    OR NOT coalesce(((r->>'format'='v1-journal-report-v1' AND i->>'format'='v1-journal-input-v1') OR (r->>'format'='v1-journal-report-v2' AND i->>'format'='v1-journal-input-v2') OR (r->>'format'='v1-journal-report-v3' AND i->>'format'='v1-journal-input-v3')),false)
    OR (r->>'capturedAt')::timestamptz IS DISTINCT FROM NEW.captured_at
    OR (i->>'capturedAt')::timestamptz IS DISTINCT FROM NEW.captured_at OR NEW.captured_at>clock_timestamp()
    OR r#>>'{summary,primaryPolicy}' IS DISTINCT FROM 'last_successful_pre_start_v1'
    OR r#>>'{summary,metricPolicy}' IS DISTINCT FROM 'forecast-binary-v1' THEN RAISE EXCEPTION 'journal_report_binding'; END IF;
  IF jsonb_typeof(i->'observations') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'observations')>5000 OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(i->'observations') candidate WHERE NOT EXISTS(
      SELECT 1 FROM v1_runtime_snapshots s WHERE s.prediction_id::text=candidate->>'id' AND s.owner_user_id=NEW.owner_user_id
        AND s.snapshot_sha256=candidate->>'snapshotSha256')) THEN RAISE EXCEPTION 'journal_source_binding'; END IF;
  IF (SELECT count(*) FROM v1_runtime_snapshots WHERE owner_user_id=NEW.owner_user_id)<>jsonb_array_length(i->'observations') OR
    (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(i->'observations') e)<>jsonb_array_length(i->'observations') THEN
    RAISE EXCEPTION 'journal_complete_inventory_required'; END IF;
  FOR obs IN SELECT * FROM jsonb_array_elements(i->'observations') LOOP
    SELECT snapshot_text::jsonb INTO original FROM v1_runtime_snapshots WHERE prediction_id=(obs->>'id')::uuid;
    IF r->>'format'='v1-journal-report-v3' AND obs->'target' IS DISTINCT FROM coalesce(original#>'{request,realTarget}','null'::jsonb)
      THEN RAISE EXCEPTION 'journal_prediction_target_mismatch'; END IF;
    IF obs->>'purpose' IS DISTINCT FROM original#>>'{request,purpose}' OR obs->>'status' IS DISTINCT FROM original->>'status'
      OR obs->'probability' IS DISTINCT FROM original->'teamAWinProbability' OR obs->>'modelId' IS DISTINCT FROM original#>>'{gate,modelId}'
      OR (obs->>'eligibleModelAtIssuance')::boolean IS DISTINCT FROM (original#>>'{gate,status}'='model_eligible')
      OR obs->>'createdAt' IS DISTINCT FROM original->>'createdAt' OR obs->>'issuedAt' IS DISTINCT FROM original->>'issuedAt'
      OR obs->>'cutoffAt' IS DISTINCT FROM original->>'cutoffAt' OR obs->>'teamAId' IS DISTINCT FROM original#>>'{scenario,input,teamAId}'
      OR obs->>'teamBId' IS DISTINCT FROM original#>>'{scenario,input,teamBId}' THEN RAISE EXCEPTION 'journal_prediction_fields_mismatch'; END IF;
    IF obs->'binding'<>'null'::jsonb THEN
      IF NOT EXISTS(SELECT 1 FROM v1_forecast_outcome_revisions o JOIN v1_runtime_snapshots s ON s.prediction_id=o.prediction_id
        WHERE s.owner_user_id=NEW.owner_user_id AND o.prediction_id::text=obs#>>'{binding,sourcePredictionId}'
          AND o.revision::text=obs#>>'{binding,revision}' AND o.result_sha256=obs#>>'{binding,sha256}'
          AND o.result_text::jsonb->>'status'='linked' AND o.result_text::jsonb->>'matchId'=obs#>>'{binding,matchId}'
          AND s.snapshot_text::jsonb#>>'{request,realTarget,provider}'=original#>>'{request,realTarget,provider}'
          AND ((original#>>'{request,realTarget,provider}'='opendota' AND s.snapshot_text::jsonb#>>'{request,realTarget,providerSeriesId}'=original#>>'{request,realTarget,providerSeriesId}')
            OR (original#>>'{request,realTarget,provider}'='pandascore' AND s.snapshot_text::jsonb#>>'{request,realTarget,providerMatchId}'=original#>>'{request,realTarget,providerMatchId}'))
          AND s.snapshot_text::jsonb#>>'{request,realTarget,mapNumber}'=original#>>'{request,realTarget,mapNumber}') THEN
        RAISE EXCEPTION 'journal_map_binding'; END IF;
      current_verification=verify_v1_forecast_outcome((obs->>'id')::uuid,(obs#>>'{binding,matchId}')::bigint,date_trunc('milliseconds',NEW.captured_at));
      IF obs->'verification' IS DISTINCT FROM current_verification THEN RAISE EXCEPTION 'journal_current_verification_required'; END IF;
    ELSIF obs->'verification' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'journal_unbound_verification'; END IF;
  END LOOP;
  IF r->>'format' IN ('v1-journal-report-v2','v1-journal-report-v3') THEN
    IF r#>>'{summary,lifecyclePolicy}' IS DISTINCT FROM (CASE WHEN r->>'format'='v1-journal-report-v3' THEN 'owner_reported_verified_binding_precedence_v2' ELSE 'owner_reported_verified_binding_precedence_v1' END)
      THEN RAISE EXCEPTION 'journal_lifecycle_policy'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('event',x.event_text::jsonb,'sha256',x.event_sha256)
      ORDER BY x.provider_series_id,x.map_number),'[]'::jsonb) INTO expected_lifecycle FROM (
      SELECT DISTINCT ON (provider_series_id,map_number) * FROM v1_target_lifecycle
      WHERE owner_user_id=NEW.owner_user_id ORDER BY provider_series_id,map_number,revision DESC) x;
    IF i->'lifecycle' IS DISTINCT FROM expected_lifecycle OR EXISTS(SELECT 1 FROM v1_target_lifecycle
      WHERE owner_user_id=NEW.owner_user_id AND recorded_at>NEW.captured_at) THEN RAISE EXCEPTION 'journal_lifecycle_inventory'; END IF;
  ELSIF EXISTS(SELECT 1 FROM v1_target_lifecycle WHERE owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'journal_lifecycle_v2_required';
  END IF;
  IF r->>'format'='v1-journal-report-v3' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('event',x.event_text::jsonb,'sha256',x.event_sha256) ORDER BY x.provider_match_id),'[]'::jsonb)
      INTO expected_lifecycle FROM (SELECT DISTINCT ON (provider_match_id) * FROM v1_scheduled_lifecycle
        WHERE owner_user_id=NEW.owner_user_id ORDER BY provider_match_id,revision DESC) x;
    IF i->'scheduledLifecycle' IS DISTINCT FROM expected_lifecycle OR EXISTS(SELECT 1 FROM v1_scheduled_lifecycle
      WHERE owner_user_id=NEW.owner_user_id AND recorded_at>NEW.captured_at) THEN RAISE EXCEPTION 'journal_scheduled_lifecycle_inventory'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('providerMatchId',provider_match_id::text,'matchId',match_id::text,
      'requestId',request_id,'sha256',record_sha256,'reviewedAt',record_text::jsonb->>'reviewedAt') ORDER BY provider_match_id,request_id),'[]'::jsonb)
      INTO expected_lifecycle FROM v1_schedule_result_bindings WHERE owner_user_id=NEW.owner_user_id;
    IF i->'scheduledBindings' IS DISTINCT FROM expected_lifecycle OR EXISTS(SELECT 1 FROM v1_schedule_result_bindings
      WHERE owner_user_id=NEW.owner_user_id AND (record_text::jsonb->>'reviewedAt')::timestamptz>NEW.captured_at)
      THEN RAISE EXCEPTION 'journal_scheduled_binding_inventory'; END IF;
  ELSIF EXISTS(SELECT 1 FROM v1_scheduled_lifecycle WHERE owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'journal_scheduled_lifecycle_v3_required';
  END IF;
  NEW.recorded_at=clock_timestamp();RETURN NEW;
END;
$$;
