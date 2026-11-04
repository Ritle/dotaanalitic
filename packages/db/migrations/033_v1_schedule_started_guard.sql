-- A confirmed completed map blocks new issuance, even if the schedule still says not_started.
CREATE FUNCTION guard_v1_scheduled_issuance(owner_id UUID,meeting_id BIGINT,status TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-schedule-result:'||owner_id::text,0));
  IF status='done' AND EXISTS(SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=owner_id AND provider_match_id=meeting_id)
    THEN RAISE EXCEPTION 'forecast_target_already_started_or_ambiguous'; END IF;
END;
$$;

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
    PERFORM guard_v1_scheduled_issuance(NEW.owner_user_id,(s#>>'{request,realTarget,providerMatchId}')::bigint,p.status);
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
