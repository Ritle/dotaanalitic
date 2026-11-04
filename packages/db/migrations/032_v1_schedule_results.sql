-- Preserve snapshots and legacy verifier. A reviewed cross-provider association is separate from the verified map outcome.
CREATE FUNCTION verify_v1_resolved_forecast(s JSONB, prediction UUID, map_id BIGINT, checked_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE m matches%ROWTYPE; o jsonb; proof jsonb := '[]'; a_side text;
  reasons text[] := ARRAY[]::text[]; eligible boolean := false; roster text := 'unknown';
  actual_a text[]; actual_b text[]; expected_a text[]; expected_b text[];
  linked boolean := false; verified_number boolean := false;
BEGIN
  IF checked_at IS NULL OR checked_at>clock_timestamp() OR checked_at<>date_trunc('milliseconds',checked_at) THEN
    RAISE EXCEPTION 'forecast_invalid_check_time';
  END IF;
  IF s IS NULL OR s#>>'{request,purpose}' IS DISTINCT FROM 'real_map' THEN RAISE EXCEPTION 'forecast_real_purpose_required'; END IF;
  SELECT * INTO m FROM matches WHERE id=map_id FOR SHARE;
  IF m.id IS NULL THEN reasons=array_append(reasons,'MAP_NOT_FOUND');
  ELSE
    a_side=CASE WHEN m.radiant_team_id::text=s#>>'{scenario,input,teamAId}' AND m.dire_team_id::text=s#>>'{scenario,input,teamBId}' THEN 'radiant'
      WHEN m.dire_team_id::text=s#>>'{scenario,input,teamAId}' AND m.radiant_team_id::text=s#>>'{scenario,input,teamBId}' THEN 'dire' END;
    IF a_side IS NULL THEN reasons=array_append(reasons,'TARGET_TEAMS_MISMATCH');
    ELSE
      o=verify_training_outcome(map_id,checked_at,a_side);
      IF o->>'status'<>'verified' THEN
        SELECT reasons||ARRAY(SELECT jsonb_array_elements_text(o->'reasons')) INTO reasons; o=NULL;
      END IF;
    END IF;
    IF m.league_id::text IS DISTINCT FROM s#>>'{scenario,input,context,leagueId}' OR NOT EXISTS (
      SELECT 1 FROM leagues WHERE id=m.league_id AND opendota_league_id::text=s#>>'{request,targetScope,leagueId}') THEN
      reasons=array_append(reasons,'TARGET_LEAGUE_MISMATCH');
    END IF;
    IF (SELECT count(*) FROM series WHERE provider='opendota' AND provider_series_id=s#>>'{request,realTarget,providerSeriesId}')<>1 OR
      NOT EXISTS(SELECT 1 FROM series WHERE id=m.series_id AND provider='opendota' AND league_id=m.league_id
        AND ((team_a_id=m.radiant_team_id AND team_b_id=m.dire_team_id) OR (team_b_id=m.radiant_team_id AND team_a_id=m.dire_team_id))
        AND provider_series_id=s#>>'{request,realTarget,providerSeriesId}') OR
      (o IS NOT NULL AND NOT EXISTS(SELECT 1 FROM provider_ingest_receipts WHERE id=(o->>'outcomeReceiptId')::bigint
        AND source_payload->>'series_id'=s#>>'{request,realTarget,providerSeriesId}')) THEN
      reasons=array_append(reasons,'TARGET_SERIES_UNVERIFIED');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id::text,'value',value,'provider',provider,'reviewState',review_state,
        'evidenceRef',evidence_ref,'contextSha256',context_sha256,'fetchedAt',fetched_at,'recordedAt',recorded_at) ORDER BY id),'[]'),
      coalesce(bool_and(review_state='accepted' AND value='1'::jsonb),false)
      INTO proof,verified_number FROM match_field_observations
      WHERE match_id=map_id AND field_name='context.map_number' AND context_sha256 IS NOT NULL
        AND review_state IN ('accepted','conflict') AND availability_class IN ('verified_asof','retrospective_fact')
        AND evidence_ref IS NOT NULL AND length(btrim(evidence_ref))>0
        AND fetched_at<=checked_at AND recorded_at<=checked_at AND (known_at IS NULL OR known_at<=checked_at);
    IF NOT verified_number OR (m.map_number IS NOT NULL AND m.map_number<>1) THEN reasons=array_append(reasons,'TARGET_MAP_NUMBER_UNVERIFIED'); END IF;
    IF EXISTS(SELECT 1 FROM matches sibling WHERE sibling.series_id=m.series_id AND sibling.id<>m.id AND
      (sibling.map_number=1 OR EXISTS(SELECT 1 FROM match_field_observations obs WHERE obs.match_id=sibling.id
        AND obs.field_name='context.map_number' AND obs.value='1'::jsonb AND obs.review_state='accepted'
        AND obs.availability_class IN ('verified_asof','retrospective_fact') AND obs.context_sha256 IS NOT NULL
        AND obs.evidence_ref IS NOT NULL AND obs.recorded_at<=checked_at AND obs.fetched_at<=checked_at))) THEN
      reasons=array_append(reasons,'TARGET_MAP_NUMBER_CONFLICT');
    END IF;
    IF s#>'{request,targetScope}' IS NULL OR s#>'{request,targetScope}'='null'::jsonb OR
      m.started_at<(s#>>'{request,targetScope,fromAt}')::timestamptz OR m.started_at>=(s#>>'{request,targetScope,until}')::timestamptz THEN
      reasons=array_append(reasons,'ACTUAL_MAP_OUTSIDE_TIER1_SCOPE');
    END IF;
    linked=cardinality(reasons)=0 AND o IS NOT NULL;
    IF linked THEN
      SELECT array_agg(player_id::text ORDER BY player_id::text) FILTER(WHERE side=a_side),
        array_agg(player_id::text ORDER BY player_id::text) FILTER(WHERE side<>a_side)
        INTO actual_a,actual_b FROM match_players WHERE match_id=map_id;
      SELECT array_agg(x->>'playerId' ORDER BY x->>'playerId') INTO expected_a FROM jsonb_array_elements(s#>'{scenario,input,lineupA}') x;
      SELECT array_agg(x->>'playerId' ORDER BY x->>'playerId') INTO expected_b FROM jsonb_array_elements(s#>'{scenario,input,lineupB}') x;
      IF cardinality(actual_a)=5 AND cardinality(actual_b)=5 AND array_position(actual_a,NULL) IS NULL AND array_position(actual_b,NULL) IS NULL
        AND (SELECT count(DISTINCT id) FROM unnest(actual_a||actual_b) id)=10 THEN
        roster=CASE WHEN actual_a=expected_a AND actual_b=expected_b THEN 'matched' ELSE 'mismatched' END;
      END IF;
      IF s->>'status'<>'done' OR s->>'issuedAt' IS NULL THEN reasons=array_append(reasons,'NO_ISSUED_PROBABILITY');
      ELSIF (s->>'createdAt')::timestamptz>=m.started_at OR (s->>'issuedAt')::timestamptz>=m.started_at
        OR (s->>'cutoffAt')::timestamptz>m.started_at THEN reasons=array_append(reasons,'NOT_BEFORE_ACTUAL_START');
      ELSE eligible=true;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('policyVersion','verified-first-map-forecast-v1','predictionId',prediction,'matchId',map_id::text,
    'checkedAt',to_char(checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status',CASE WHEN linked THEN 'linked' ELSE 'unlinked' END,'prospectiveEligible',eligible,
    'rosterStatus',roster,'reasons',to_jsonb(reasons),'teamASide',a_side,'mapNumberEvidence',proof,
    'outcome',CASE WHEN linked THEN o ELSE NULL END);
END;
$$;

CREATE FUNCTION verify_v1_schedule_candidate(prediction UUID,map_id BIGINT,source_series TEXT,checked_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE s JSONB;
BEGIN
  SELECT snapshot_text::jsonb INTO s FROM v1_runtime_snapshots WHERE prediction_id=prediction;
  IF s#>>'{request,purpose}' IS DISTINCT FROM 'real_map' OR s#>>'{request,realTarget,provider}' IS DISTINCT FROM 'pandascore'
    OR source_series !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'schedule_result_target_required'; END IF;
  -- Resolved verification input only: never written back to the original prediction.
  s=jsonb_set(s,'{request,realTarget}',jsonb_build_object('provider','opendota','providerSeriesId',source_series,'mapNumber',1));
  RETURN verify_v1_resolved_forecast(s,prediction,map_id,checked_at);
END;
$$;

CREATE TABLE v1_schedule_result_bindings (
  owner_user_id UUID NOT NULL REFERENCES app_users(id), request_id UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  target_request_id UUID NOT NULL, provider_match_id BIGINT NOT NULL CHECK(provider_match_id>0),
  prediction_id UUID NOT NULL REFERENCES v1_runtime_snapshots(prediction_id),match_id BIGINT NOT NULL REFERENCES matches(id),
  provider_series_id TEXT NOT NULL CHECK(provider_series_id ~ '^[1-9][0-9]{0,18}$'),
  record_text TEXT NOT NULL CHECK(octet_length(record_text) BETWEEN 1 AND 1048576),
  record_sha256 CHAR(64) NOT NULL CHECK(record_sha256=encode(sha256(convert_to(record_text,'UTF8')),'hex')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_user_id,request_id), UNIQUE(owner_user_id,target_request_id),
  FOREIGN KEY(owner_user_id,target_request_id) REFERENCES v1_schedule_targets(owner_user_id,request_id)
);
CREATE FUNCTION validate_v1_schedule_result_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s JSONB; b JSONB:=NEW.record_text::jsonb; actual JSONB; reviewed TIMESTAMPTZ:=(b->>'reviewedAt')::timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-result:'||NEW.owner_user_id::text,0));
  SELECT snapshot_text::jsonb INTO s FROM v1_runtime_snapshots WHERE prediction_id=NEW.prediction_id AND owner_user_id=NEW.owner_user_id;
  IF s IS NULL OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active)
    OR s#>>'{request,purpose}' IS DISTINCT FROM 'real_map' OR s#>>'{request,realTarget,provider}' IS DISTINCT FROM 'pandascore'
    OR b->>'format' IS DISTINCT FROM 'v1-schedule-result-binding-v1' OR b->>'basis' IS DISTINCT FROM 'owner_reviewed_cross_provider_mapping'
    OR b->>'ownerId' IS DISTINCT FROM NEW.owner_user_id::text OR b->>'predictionId' IS DISTINCT FROM NEW.prediction_id::text
    OR b#>>'{request,requestId}' IS DISTINCT FROM NEW.request_id::text OR b#>>'{request,matchId}' IS DISTINCT FROM NEW.match_id::text
    OR b#>>'{request,providerSeriesId}' IS DISTINCT FROM NEW.provider_series_id
    OR b#>>'{request,predictionRequestId}' IS DISTINCT FROM s#>>'{request,requestId}'
    OR b#>>'{request,targetSha256}' IS DISTINCT FROM s#>>'{request,realTarget,targetSha256}'
    OR b->'target' IS DISTINCT FROM s#>'{request,realTarget}'
    OR s#>>'{request,realTarget,targetRequestId}' IS DISTINCT FROM NEW.target_request_id::text
    OR s#>>'{request,realTarget,providerMatchId}' IS DISTINCT FROM NEW.provider_match_id::text
    OR coalesce(b#>>'{request,sourceUrl}','') !~ '^https://[^/]+'
    OR length(btrim(coalesce(b#>>'{request,rationale}','')))<20
    OR reviewed IS NULL OR reviewed<transaction_timestamp() OR reviewed>clock_timestamp()
    THEN RAISE EXCEPTION 'schedule_result_target_mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=NEW.owner_user_id AND target_request_id=NEW.target_request_id)
    THEN RAISE EXCEPTION 'schedule_result_already_bound'; END IF;
  IF EXISTS(SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=NEW.owner_user_id AND
    ((provider_match_id=NEW.provider_match_id AND (match_id<>NEW.match_id OR provider_series_id<>NEW.provider_series_id)) OR
     (match_id=NEW.match_id AND provider_match_id<>NEW.provider_match_id))) THEN RAISE EXCEPTION 'schedule_result_map_conflict'; END IF;
  actual=verify_v1_schedule_candidate(NEW.prediction_id,NEW.match_id,NEW.provider_series_id,date_trunc('milliseconds',reviewed));
  IF actual->>'status' IS DISTINCT FROM 'linked' OR b->'verification' IS DISTINCT FROM actual
    THEN RAISE EXCEPTION 'schedule_result_map_unverified'; END IF;
  NEW.recorded_at=clock_timestamp();RETURN NEW;
END;
$$;
CREATE TRIGGER trg_schedule_result_validate BEFORE INSERT ON v1_schedule_result_bindings FOR EACH ROW EXECUTE FUNCTION validate_v1_schedule_result_binding();
CREATE TRIGGER trg_schedule_result_immutable BEFORE UPDATE OR DELETE ON v1_schedule_result_bindings FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_schedule_result_no_truncate BEFORE TRUNCATE ON v1_schedule_result_bindings FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();

CREATE OR REPLACE FUNCTION verify_v1_forecast_outcome(prediction UUID,map_id BIGINT,checked_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE s JSONB; owner_id UUID; b v1_schedule_result_bindings%ROWTYPE; result JSONB;
BEGIN
  IF checked_at IS NULL OR checked_at>clock_timestamp() OR checked_at<>date_trunc('milliseconds',checked_at)
    THEN RAISE EXCEPTION 'forecast_invalid_check_time'; END IF;
  SELECT snapshot_text::jsonb,owner_user_id INTO s,owner_id FROM v1_runtime_snapshots WHERE prediction_id=prediction;
  IF s#>>'{request,realTarget,provider}' IS DISTINCT FROM 'pandascore'
    THEN RETURN verify_v1_forecast_outcome_opendota_v1(prediction,map_id,checked_at); END IF;
  SELECT * INTO b FROM v1_schedule_result_bindings WHERE owner_user_id=owner_id
    AND target_request_id=(s#>>'{request,realTarget,targetRequestId}')::uuid AND recorded_at<=checked_at;
  IF b.request_id IS NULL OR b.match_id<>map_id THEN
    RETURN jsonb_build_object('policyVersion','verified-first-map-forecast-v1','predictionId',prediction,'matchId',map_id::text,
      'checkedAt',to_char(checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'status','unlinked','prospectiveEligible',false,
      'rosterStatus','unknown','reasons',jsonb_build_array(CASE WHEN b.request_id IS NULL THEN 'SCHEDULE_BINDING_REQUIRED' ELSE 'SCHEDULE_BOUND_MAP_MISMATCH' END),
      'teamASide',NULL,'mapNumberEvidence','[]'::jsonb,'outcome',NULL);
  END IF;
  result=verify_v1_schedule_candidate(prediction,map_id,b.provider_series_id,checked_at);
  RETURN result||jsonb_build_object('scheduleBinding',jsonb_build_object('requestId',b.request_id,'sha256',b.record_sha256,
    'targetRequestId',b.target_request_id,'targetSha256',s#>>'{request,realTarget,targetSha256}','providerMatchId',b.provider_match_id::text,
    'providerSeriesId',b.provider_series_id,'matchId',b.match_id::text,'reviewedAt',b.record_text::jsonb->>'reviewedAt',
    'sourceUrl',b.record_text::jsonb#>>'{request,sourceUrl}','basis','owner_reviewed_cross_provider_mapping'));
END;
$$;

-- Provider-qualified journal binding; primary and metric policies unchanged.
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
    OR NOT coalesce(((r->>'format'='v1-journal-report-v1' AND i->>'format'='v1-journal-input-v1') OR (r->>'format'='v1-journal-report-v2' AND i->>'format'='v1-journal-input-v2')),false)
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
  IF r->>'format'='v1-journal-report-v2' THEN
    IF r#>>'{summary,lifecyclePolicy}' IS DISTINCT FROM 'owner_reported_verified_binding_precedence_v1'
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
  NEW.recorded_at=clock_timestamp();RETURN NEW;
END;
$$;
