-- Additive schedule binding; retain the original activation/release guards verbatim.
ALTER TABLE v1_runtime_snapshots ADD COLUMN schedule_target_request_id UUID;
ALTER TABLE v1_runtime_snapshots ADD CONSTRAINT fk_runtime_schedule_target
  FOREIGN KEY(owner_user_id,schedule_target_request_id) REFERENCES v1_schedule_targets(owner_user_id,request_id);

CREATE FUNCTION validate_v1_scheduled_runtime(owner_id UUID,target_request UUID,s JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE t v1_schedule_targets%ROWTYPE; o upcoming_source_observations%ROWTYPE; latest_request UUID;
  b jsonb:=s#>'{targetReview,scheduleBinding}'; ref jsonb:=s#>'{request,realTarget}'; m jsonb;
  checked TIMESTAMPTZ:=(b->>'checkedAt')::timestamptz; created TIMESTAMPTZ:=(s->>'createdAt')::timestamptz; omitted INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-target:'||owner_id::text,0));
  LOCK TABLE upcoming_source_observations IN SHARE MODE;
  SELECT * INTO t FROM v1_schedule_targets WHERE owner_user_id=owner_id AND request_id=target_request;
  SELECT request_id INTO latest_request FROM v1_schedule_targets WHERE owner_user_id=owner_id AND provider_match_id=t.provider_match_id ORDER BY revision DESC LIMIT 1;
  IF t.request_id IS NULL OR latest_request IS DISTINCT FROM target_request
    OR NOT EXISTS(SELECT 1 FROM app_users WHERE id=owner_id AND is_active)
    OR ref->>'bindingVersion' IS DISTINCT FROM '1' OR ref->>'mapNumber' IS DISTINCT FROM '1'
    OR ref->>'targetRequestId' IS DISTINCT FROM target_request::text OR ref->>'targetSha256' IS DISTINCT FROM t.record_sha256::text
    OR ref->>'providerMatchId' IS DISTINCT FROM t.provider_match_id::text
    OR b->>'format' IS DISTINCT FROM 'v1-schedule-runtime-binding-v1'
    OR b#>'{target,record}' IS DISTINCT FROM t.record_text::jsonb OR b#>>'{target,sha256}' IS DISTINCT FROM t.record_sha256::text
    OR checked IS NULL OR checked<transaction_timestamp() OR checked>created OR created>clock_timestamp() OR t.recorded_at>checked
    THEN RAISE EXCEPTION 'scheduled_target_reference_mismatch'; END IF;
  WITH recent AS (SELECT * FROM upcoming_source_observations WHERE cache_key='schedule' ORDER BY recorded_at DESC,id DESC LIMIT 200)
    SELECT * INTO o FROM recent WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_text::jsonb->'data') e WHERE e->>'providerMatchId'=t.provider_match_id::text)
      ORDER BY recorded_at DESC,id DESC LIMIT 1;
  SELECT count(*) INTO omitted FROM upcoming_source_observations WHERE cache_key='schedule' AND (recorded_at,id)>(o.recorded_at,o.id);
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
  IF s#>>'{request,purpose}'='real_map' AND s#>>'{request,realTarget,provider}'='opendota' AND (
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
  IF p.status='done' AND s#>>'{request,purpose}'='real_map' AND s#>>'{request,realTarget,provider}'='opendota' AND (
    s#>>'{scenario,input,context,mapNumber}' IS DISTINCT FROM '1' OR
    EXISTS(SELECT 1 FROM matches m WHERE m.started_at<=clock_timestamp() AND (
      EXISTS(SELECT 1 FROM series sr WHERE sr.id=m.series_id AND sr.provider='opendota'
        AND sr.provider_series_id=s#>>'{request,realTarget,providerSeriesId}') OR
      EXISTS(SELECT 1 FROM provider_ingest_receipts r WHERE r.canonical_match_id=m.id AND r.provider='opendota'
        AND r.source_payload->>'series_id'=s#>>'{request,realTarget,providerSeriesId}')))) THEN
    RAISE EXCEPTION 'forecast_target_already_started_or_ambiguous';
  END IF;
  IF s#>>'{request,purpose}'='real_map' AND coalesce(s#>>'{request,realTarget,provider}','') NOT IN ('opendota','pandascore') THEN
    RAISE EXCEPTION 'forecast_provider_unsupported'; END IF;
  IF s#>>'{request,purpose}'='real_map' AND s#>>'{request,realTarget,provider}'='pandascore' THEN
    PERFORM validate_v1_scheduled_runtime(NEW.owner_user_id,NEW.schedule_target_request_id,s);
  ELSIF NEW.schedule_target_request_id IS NOT NULL THEN RAISE EXCEPTION 'scheduled_target_unexpected_reference'; END IF;
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


-- A schedule meeting is not yet a verified OpenDota series/map association.
ALTER FUNCTION verify_v1_forecast_outcome(UUID,BIGINT,TIMESTAMPTZ) RENAME TO verify_v1_forecast_outcome_opendota_v1;
CREATE FUNCTION verify_v1_forecast_outcome(prediction UUID,map_id BIGINT,checked_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET TimeZone='UTC' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM v1_runtime_snapshots WHERE prediction_id=prediction AND snapshot_text::jsonb#>>'{request,realTarget,provider}'='pandascore')
    THEN RAISE EXCEPTION 'forecast_schedule_binding_required'; END IF;
  RETURN verify_v1_forecast_outcome_opendota_v1(prediction,map_id,checked_at);
END;
$$;
