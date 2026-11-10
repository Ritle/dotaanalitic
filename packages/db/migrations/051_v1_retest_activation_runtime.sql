-- Separate retest admission; old prospective activation and snapshot evidence remains intact.
ALTER TABLE model_activation_events
  ADD COLUMN retest_request_id UUID UNIQUE,
  ADD COLUMN retest_request_hash CHAR(64),
  ADD COLUMN retest_protocol_fingerprint CHAR(64),
  ADD COLUMN retest_freeze_sha256 CHAR(64),
  ADD COLUMN retest_report_sha256 CHAR(64),
  ADD COLUMN retest_runtime_text TEXT,
  ADD COLUMN retest_runtime_sha256 CHAR(64);
ALTER TABLE model_activation_events DROP CONSTRAINT model_activation_promotion_evidence;
ALTER TABLE model_activation_events ADD CONSTRAINT model_activation_promotion_evidence CHECK (
  event_type <> 'promote' OR (activated_model_id IS NOT NULL AND
    (supporting_evaluation_id IS NOT NULL OR v1_plan_fingerprint IS NOT NULL OR retest_request_id IS NOT NULL)));
ALTER TABLE model_activation_events ADD CONSTRAINT retest_transition_fields CHECK (
 (retest_request_id IS NULL AND retest_request_hash IS NULL AND retest_protocol_fingerprint IS NULL
   AND retest_freeze_sha256 IS NULL AND retest_report_sha256 IS NULL AND retest_runtime_text IS NULL AND retest_runtime_sha256 IS NULL)
 OR (retest_request_id IS NOT NULL AND retest_request_hash IS NOT NULL AND retest_request_hash ~ '^[a-f0-9]{64}$'
   AND stage='pre_match' AND actor='owner' AND length(btrim(reason)) BETWEEN 10 AND 1000
   AND v1_request_id IS NULL AND supporting_evaluation_id IS NULL
   AND ((event_type='deactivate' AND previous_model_id IS NOT NULL AND activated_model_id IS NULL
     AND retest_protocol_fingerprint IS NULL AND retest_freeze_sha256 IS NULL AND retest_report_sha256 IS NULL
     AND retest_runtime_text IS NULL AND retest_runtime_sha256 IS NULL)
   OR (event_type IN ('promote','rollback') AND activated_model_id IS NOT NULL
     AND activated_model_id IS DISTINCT FROM previous_model_id AND retest_protocol_fingerprint IS NOT NULL
     AND retest_freeze_sha256 IS NOT NULL AND retest_report_sha256 IS NOT NULL
     AND retest_runtime_text IS NOT NULL AND retest_runtime_sha256 IS NOT NULL
     AND octet_length(retest_runtime_text) BETWEEN 2 AND 8388608
     AND retest_runtime_sha256=encode(sha256(convert_to(retest_runtime_text,'UTF8')),'hex')
     AND coalesce(retest_runtime_text::jsonb->>'policy','')='v1-retest-runtime-admission-v1'))));

CREATE OR REPLACE FUNCTION guard_retest_activation_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.retest_request_id IS NULL AND EXISTS(SELECT 1 FROM v1_retest_model_artifacts
   WHERE model_id IN (NEW.activated_model_id,NEW.previous_model_id)) THEN
   RAISE EXCEPTION 'retest_registry_activation_pending';
 END IF; RETURN NEW;
END;
$$;
DROP TRIGGER trg_validate_model_activation_evidence ON model_activation_events;
CREATE TRIGGER trg_validate_model_activation_evidence BEFORE INSERT ON model_activation_events
 FOR EACH ROW WHEN (NEW.retest_request_id IS NULL) EXECUTE FUNCTION validate_model_activation_evidence();
CREATE FUNCTION validate_retest_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_id UUID; a v1_retest_model_artifacts%ROWTYPE; m prediction_model_versions%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0));
 SELECT id INTO current_id FROM prediction_model_versions WHERE stage='pre_match' AND is_active FOR UPDATE;
 IF current_id IS DISTINCT FROM NEW.previous_model_id THEN RAISE EXCEPTION 'retest_registry_current_changed'; END IF;
 IF current_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM v1_retest_model_artifacts WHERE model_id=current_id)
   THEN RAISE EXCEPTION 'retest_registry_foreign_active_model'; END IF;
 IF NEW.event_type<>'deactivate' THEN
  SELECT * INTO a FROM v1_retest_model_artifacts WHERE model_id=NEW.activated_model_id;
  SELECT * INTO m FROM prediction_model_versions WHERE id=NEW.activated_model_id FOR UPDATE;
  IF a.model_id IS NULL OR m.stage IS DISTINCT FROM 'pre_match' OR m.algorithm IS DISTINCT FROM 'fixed_player_mean_elo'
    OR m.artifact_sha256 IS DISTINCT FROM a.freeze_sha256 OR m.is_active
    OR a.protocol_fingerprint IS DISTINCT FROM NEW.retest_protocol_fingerprint
    OR a.freeze_sha256 IS DISTINCT FROM NEW.retest_freeze_sha256 OR a.report_sha256 IS DISTINCT FROM NEW.retest_report_sha256
    OR a.metadata->>'qualityDecision' IS DISTINCT FROM 'passed' OR a.metadata->>'syntheticOnly' IS DISTINCT FROM 'false'
    OR a.metadata->>'evaluationBasis' IS DISTINCT FROM 'conditional_retrospective_unexposed_series'
    OR a.metadata->'runtime' IS DISTINCT FROM NEW.retest_runtime_text::jsonb#>'{runtime,runtime}'
    OR a.registered_at>clock_timestamp() THEN RAISE EXCEPTION 'retest_registry_activation_binding'; END IF;
  IF NEW.event_type='rollback' AND NOT EXISTS(SELECT 1 FROM model_activation_events
    WHERE retest_request_id IS NOT NULL AND activated_model_id=NEW.activated_model_id)
    THEN RAISE EXCEPTION 'retest_registry_rollback_target'; END IF;
 END IF;
 UPDATE prediction_model_versions SET is_active=false WHERE id=current_id;
 UPDATE prediction_model_versions SET is_active=true WHERE id=NEW.activated_model_id;
 RETURN NEW;
END;
$$;
CREATE TRIGGER trg_retest_activation BEFORE INSERT ON model_activation_events
 FOR EACH ROW WHEN (NEW.retest_request_id IS NOT NULL) EXECUTE FUNCTION validate_retest_activation();
CREATE OR REPLACE FUNCTION guard_retest_model_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM v1_retest_model_artifacts WHERE model_id=OLD.id) AND
   (TG_OP='DELETE' OR (to_jsonb(OLD)-'is_active') IS DISTINCT FROM (to_jsonb(NEW)-'is_active')) THEN
   RAISE EXCEPTION 'retest_registry_model_immutable';
 END IF; RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE FUNCTION validate_retest_active_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest_id UUID; active BOOLEAN;
BEGIN
 IF EXISTS(SELECT 1 FROM v1_retest_model_artifacts WHERE model_id=NEW.id) THEN
  SELECT activated_model_id INTO latest_id FROM model_activation_events WHERE stage='pre_match' ORDER BY registry_sequence DESC LIMIT 1;
  SELECT is_active INTO active FROM prediction_model_versions WHERE id=NEW.id;
  IF active IS DISTINCT FROM (latest_id IS NOT DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'retest_registry_active_audit_required'; END IF;
 END IF; RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_retest_active_audit AFTER INSERT OR UPDATE ON prediction_model_versions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_retest_active_audit();

CREATE FUNCTION validate_retest_runtime_model(p prediction_runs,s JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0));
 IF p.issued_at IS NULL OR p.issued_at<p.created_at OR (s#>>'{scenario,input,scheduledAt}')::timestamptz IS NULL
   OR p.issued_at>=(s#>>'{scenario,input,scheduledAt}')::timestamptz
   OR clock_timestamp()>=(s#>>'{scenario,input,scheduledAt}')::timestamptz
   OR s#>>'{gate,status}' IS DISTINCT FROM 'model_eligible' OR s#>>'{gate,modelId}' IS DISTINCT FROM p.model_version_id::text
   OR p.quality IS DISTINCT FROM s->'gate'
   OR s#>>'{gate,evaluationBasis}' IS DISTINCT FROM 'conditional_retrospective_unexposed_series'
   OR NOT coalesce((s->'warnings') ? 'HISTORICAL_LINEUPS_RECONSTRUCTED',false)
   OR NOT EXISTS(SELECT 1 FROM prediction_model_versions m JOIN v1_retest_model_artifacts a ON a.model_id=m.id
     JOIN model_activation_events e ON e.activated_model_id=m.id
     WHERE m.id=p.model_version_id AND m.is_active AND m.stage='pre_match' AND m.artifact_sha256=a.freeze_sha256
       AND e.retest_request_id IS NOT NULL AND e.id::text=s#>>'{gate,activationEventId}'
       AND e.registry_sequence=(SELECT max(registry_sequence) FROM model_activation_events WHERE stage='pre_match')
       AND a.report_sha256=s#>>'{gate,reportSha256}' AND a.freeze_sha256=s#>>'{gate,freezeSha256}'
       AND a.protocol_fingerprint=s#>>'{gate,protocolFingerprint}'
       AND a.metadata->>'candidateFingerprint'=s#>>'{gate,candidateFingerprint}'
       AND e.retest_report_sha256=a.report_sha256 AND e.retest_freeze_sha256=a.freeze_sha256
       AND e.retest_runtime_sha256=s#>>'{gate,runtimeSha256}') THEN
   RAISE EXCEPTION 'retest_runtime_active_gate_required';
 END IF;
END;
$$;

-- Preserve all scenario/target/schedule/time guards from 033; dispatch only the model gate.
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
  IF p.status='done' AND s#>>'{gate,registryFormat}'='v1-retest-registry-v1' THEN
    PERFORM validate_retest_runtime_model(p,s);
  ELSE
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
  END IF;
  IF p.status='unavailable' AND (p.issued_at IS NOT NULL OR p.team_a_win_probability IS NOT NULL) THEN
    RAISE EXCEPTION 'runtime_unavailable_probability';
  END IF;
  RETURN NEW;
END;
$$;
