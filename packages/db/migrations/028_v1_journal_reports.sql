CREATE TABLE v1_journal_reports (
  owner_user_id UUID NOT NULL REFERENCES app_users(id),request_id UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  revision INTEGER NOT NULL CHECK(revision>0),previous_sha256 CHAR(64),captured_at TIMESTAMPTZ NOT NULL,
  input_text TEXT NOT NULL CHECK(octet_length(input_text) BETWEEN 1 AND 33554432),
  input_sha256 CHAR(64) NOT NULL CHECK(input_sha256=encode(sha256(convert_to(input_text,'UTF8')),'hex')),
  report_text TEXT NOT NULL CHECK(octet_length(report_text) BETWEEN 1 AND 33554432),
  report_sha256 CHAR(64) NOT NULL CHECK(report_sha256=encode(sha256(convert_to(report_text,'UTF8')),'hex')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_user_id,revision),UNIQUE(owner_user_id,request_id)
);
CREATE FUNCTION validate_v1_journal_report() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE previous v1_journal_reports%ROWTYPE; r jsonb:=NEW.report_text::jsonb; i jsonb:=NEW.input_text::jsonb;
  obs jsonb; original jsonb; current_verification jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('v1-journal:'||NEW.owner_user_id::text,0));
  SELECT * INTO previous FROM v1_journal_reports WHERE owner_user_id=NEW.owner_user_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.previous_sha256 IS DISTINCT FROM previous.report_sha256
    OR r->>'ownerId' IS DISTINCT FROM NEW.owner_user_id::text OR r->>'revision' IS DISTINCT FROM NEW.revision::text
    OR r#>>'{request,requestId}' IS DISTINCT FROM NEW.request_id::text
    OR r->>'previousSha256' IS DISTINCT FROM NEW.previous_sha256::text
    OR r->>'inputSha256' IS DISTINCT FROM NEW.input_sha256::text
    OR r->>'format' IS DISTINCT FROM 'v1-journal-report-v1' OR i->>'format' IS DISTINCT FROM 'v1-journal-input-v1'
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
          AND s.snapshot_text::jsonb#>>'{request,realTarget,providerSeriesId}'=original#>>'{request,realTarget,providerSeriesId}'
          AND s.snapshot_text::jsonb#>>'{request,realTarget,mapNumber}'=original#>>'{request,realTarget,mapNumber}') THEN
        RAISE EXCEPTION 'journal_map_binding'; END IF;
      current_verification=verify_v1_forecast_outcome((obs->>'id')::uuid,(obs#>>'{binding,matchId}')::bigint,date_trunc('milliseconds',NEW.captured_at));
      IF obs->'verification' IS DISTINCT FROM current_verification THEN RAISE EXCEPTION 'journal_current_verification_required'; END IF;
    ELSIF obs->'verification' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'journal_unbound_verification'; END IF;
  END LOOP;
  NEW.recorded_at=clock_timestamp();RETURN NEW;
END;
$$;
CREATE TRIGGER trg_v1_journal_validate BEFORE INSERT ON v1_journal_reports FOR EACH ROW EXECUTE FUNCTION validate_v1_journal_report();
CREATE TRIGGER trg_v1_journal_immutable BEFORE UPDATE OR DELETE ON v1_journal_reports FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_v1_journal_no_truncate BEFORE TRUNCATE ON v1_journal_reports FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
