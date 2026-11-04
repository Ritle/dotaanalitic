-- Extend purpose without editing old snapshots or weakening model/release guards.
CREATE OR REPLACE FUNCTION validate_v1_runtime_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p prediction_runs%ROWTYPE; s jsonb := NEW.snapshot_text::jsonb;
BEGIN
  SELECT * INTO p FROM prediction_runs WHERE id=NEW.prediction_id FOR SHARE;
  IF p.v1_request_id IS DISTINCT FROM NEW.request_id OR p.stage IS DISTINCT FROM 'pre_match'
    OR p.status NOT IN ('done','unavailable') OR p.status IS DISTINCT FROM s->>'status'
    OR s->>'format' IS DISTINCT FROM 'v1-runtime-snapshot-v1'
    OR coalesce(s#>>'{request,purpose}','') NOT IN ('what_if_single_map','real_map')
    OR s#>>'{request,requestId}' IS DISTINCT FROM NEW.request_id::text
    OR s#>>'{scenario,id}' IS DISTINCT FROM p.scenario_id::text
    OR s#>>'{scenario,revision}' IS DISTINCT FROM p.scenario_revision::text
    OR s#>>'{scenario,inputHash}' IS DISTINCT FROM btrim(p.input_hash)
    OR s#>'{scenario,input}' IS DISTINCT FROM p.input_snapshot
    OR (s->>'teamAWinProbability')::numeric IS DISTINCT FROM p.team_a_win_probability
    OR (s->>'issuedAt')::timestamptz IS DISTINCT FROM p.issued_at
    OR (s->>'createdAt')::timestamptz IS DISTINCT FROM p.created_at
    OR p.created_at>clock_timestamp() OR p.issued_at>clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM scenarios WHERE id=p.scenario_id AND owner_user_id=NEW.owner_user_id)
    OR NOT EXISTS (SELECT 1 FROM scenario_input_snapshots WHERE scenario_id=p.scenario_id
      AND revision=p.scenario_revision AND input_hash=p.input_hash AND input_snapshot=p.input_snapshot) THEN
    RAISE EXCEPTION 'runtime_snapshot_binding';
  END IF;
  IF s#>>'{request,purpose}'='real_map' AND (
    s#>>'{request,realTarget,provider}' IS DISTINCT FROM 'opendota' OR
    s#>>'{request,realTarget,mapNumber}' IS DISTINCT FROM '1' OR
    coalesce(s#>>'{request,realTarget,providerSeriesId}','') !~ '^[1-9][0-9]{0,18}$' OR
    coalesce(s#>>'{request,realTarget,sourceUrl}','') !~ '^https://' OR
    length(coalesce(s#>>'{request,realTarget,rationale}',''))<20) THEN
    RAISE EXCEPTION 'forecast_explicit_map_required';
  END IF;
  IF s#>>'{request,purpose}'='what_if_single_map' AND s#>'{request,realTarget}' IS NOT NULL THEN
    RAISE EXCEPTION 'forecast_what_if_target_forbidden';
  END IF;
  IF p.status='done' AND s#>>'{request,purpose}'='real_map' AND (
    s#>>'{scenario,input,context,mapNumber}' IS DISTINCT FROM '1' OR
    EXISTS(SELECT 1 FROM matches m WHERE m.started_at<=clock_timestamp() AND (
      EXISTS(SELECT 1 FROM series sr WHERE sr.id=m.series_id AND sr.provider='opendota'
        AND sr.provider_series_id=s#>>'{request,realTarget,providerSeriesId}') OR
      EXISTS(SELECT 1 FROM provider_ingest_receipts r WHERE r.canonical_match_id=m.id AND r.provider='opendota'
        AND r.source_payload->>'series_id'=s#>>'{request,realTarget,providerSeriesId}')))) THEN
    RAISE EXCEPTION 'forecast_target_already_started_or_ambiguous';
  END IF;
  IF p.status='done' AND (p.issued_at IS NULL OR p.issued_at<p.created_at OR
    (s#>>'{scenario,input,scheduledAt}')::timestamptz IS NULL OR
    p.issued_at>=(s#>>'{scenario,input,scheduledAt}')::timestamptz OR
    clock_timestamp()>=(s#>>'{scenario,input,scheduledAt}')::timestamptz OR
    s#>>'{gate,status}' IS DISTINCT FROM 'model_eligible' OR
    s#>>'{gate,modelId}' IS DISTINCT FROM p.model_version_id::text OR
    NOT EXISTS (SELECT 1 FROM prediction_model_versions m JOIN v1_model_artifacts a ON a.model_id=m.id
      WHERE m.id=p.model_version_id AND m.is_active AND a.candidate_sha256=s#>>'{gate,candidateSha256}'
        AND a.freeze_sha256=s#>>'{gate,freezeSha256}')) THEN
    RAISE EXCEPTION 'runtime_model_gate_required';
  END IF;
  IF p.status='done' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0));
    PERFORM pg_advisory_xact_lock(hashtextextended('v1-release-evaluation:'||(s#>>'{gate,planFingerprint}'),0));
    IF NOT EXISTS (SELECT 1 FROM model_activation_events e
      JOIN prediction_model_versions m ON m.id=e.activated_model_id
      JOIN v1_model_artifacts a ON a.model_id=m.id
      JOIN v1_release_evaluation_journal j ON j.plan_fingerprint=a.plan_fingerprint
      WHERE e.id::text=s#>>'{gate,activationEventId}' AND m.id=p.model_version_id AND m.is_active
        AND e.v1_request_id IS NOT NULL AND j.revision::text=s#>>'{gate,releaseRevision}'
        AND j.report_sha256=s#>>'{gate,reportSha256}' AND a.plan_fingerprint=s#>>'{gate,planFingerprint}'
        AND j.revision=(SELECT max(revision) FROM v1_release_evaluation_journal WHERE plan_fingerprint=a.plan_fingerprint)
        AND j.report_text::jsonb#>>'{report,releaseGatePassed}'='true'
        AND j.report_text::jsonb#>>'{report,evaluation,syntheticOnly}'='false') THEN
      RAISE EXCEPTION 'runtime_release_gate_required';
    END IF;
  END IF;
  IF p.status='unavailable' AND (p.issued_at IS NOT NULL OR p.team_a_win_probability IS NOT NULL) THEN
    RAISE EXCEPTION 'runtime_unavailable_probability';
  END IF;
  RETURN NEW;
END;
$$;

-- Read-only result authority; the caller supplies a candidate map, never a winner.
CREATE FUNCTION verify_v1_forecast_outcome(prediction UUID, map_id BIGINT, checked_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE s jsonb; m matches%ROWTYPE; o jsonb; proof jsonb := '[]'; a_side text;
  reasons text[] := ARRAY[]::text[]; eligible boolean := false; roster text := 'unknown';
  actual_a text[]; actual_b text[]; expected_a text[]; expected_b text[];
  linked boolean := false; verified_number boolean := false;
BEGIN
  IF checked_at IS NULL OR checked_at>clock_timestamp() OR checked_at<>date_trunc('milliseconds',checked_at) THEN
    RAISE EXCEPTION 'forecast_invalid_check_time';
  END IF;
  SELECT snapshot_text::jsonb INTO s FROM v1_runtime_snapshots WHERE prediction_id=prediction;
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

CREATE TABLE v1_forecast_outcome_revisions (
  prediction_id UUID NOT NULL REFERENCES v1_runtime_snapshots(prediction_id),
  revision INTEGER NOT NULL CHECK(revision>0), previous_sha256 CHAR(64),
  result_text TEXT NOT NULL CHECK(octet_length(result_text) BETWEEN 1 AND 1048576),
  result_sha256 CHAR(64) NOT NULL CHECK(result_sha256=encode(sha256(convert_to(result_text,'UTF8')),'hex')),
  content_sha256 CHAR(64) NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(prediction_id,revision)
);
CREATE FUNCTION validate_v1_forecast_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE previous v1_forecast_outcome_revisions%ROWTYPE; result jsonb := NEW.result_text::jsonb; actual jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-forecast-outcome:'||NEW.prediction_id::text,0));
  SELECT * INTO previous FROM v1_forecast_outcome_revisions WHERE prediction_id=NEW.prediction_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.previous_sha256 IS DISTINCT FROM previous.result_sha256
    OR result->>'predictionId' IS DISTINCT FROM NEW.prediction_id::text THEN RAISE EXCEPTION 'forecast_revision_conflict'; END IF;
  IF EXISTS(SELECT 1 FROM v1_forecast_outcome_revisions WHERE prediction_id=NEW.prediction_id
    AND result_text::jsonb->>'status'='linked' AND result_text::jsonb->>'matchId'<>result->>'matchId') THEN
    RAISE EXCEPTION 'forecast_bound_map_conflict'; END IF;
  actual=verify_v1_forecast_outcome(NEW.prediction_id,(result->>'matchId')::bigint,(result->>'checkedAt')::timestamptz);
  IF actual IS DISTINCT FROM result THEN RAISE EXCEPTION 'forecast_verified_result_required'; END IF;
  NEW.recorded_at=clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER trg_v1_forecast_revision_validate BEFORE INSERT ON v1_forecast_outcome_revisions
  FOR EACH ROW EXECUTE FUNCTION validate_v1_forecast_revision();
CREATE TRIGGER trg_v1_forecast_revision_immutable BEFORE UPDATE OR DELETE ON v1_forecast_outcome_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_v1_forecast_revision_no_truncate BEFORE TRUNCATE ON v1_forecast_outcome_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();

CREATE TABLE v1_forecast_refresh_requests (
  owner_user_id UUID NOT NULL REFERENCES app_users(id), request_id UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  prediction_id UUID NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id,request_id),
  FOREIGN KEY(prediction_id,revision) REFERENCES v1_forecast_outcome_revisions(prediction_id,revision)
);
CREATE FUNCTION validate_v1_forecast_refresh_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM v1_runtime_snapshots WHERE prediction_id=NEW.prediction_id AND owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'forecast_owner_mismatch'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_v1_forecast_refresh_owner BEFORE INSERT ON v1_forecast_refresh_requests
  FOR EACH ROW EXECUTE FUNCTION validate_v1_forecast_refresh_owner();
CREATE TRIGGER trg_v1_forecast_refresh_immutable BEFORE UPDATE OR DELETE ON v1_forecast_refresh_requests
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_v1_forecast_refresh_no_truncate BEFORE TRUNCATE ON v1_forecast_refresh_requests
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
