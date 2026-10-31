-- Read-only S3 collector gate. Reuse the durable 012 label/source authority;
-- never manufacture a receipt, label, historical availability or dataset row.
CREATE FUNCTION verify_training_outcome(map_id BIGINT, snapshot_at TIMESTAMPTZ, team_a_side TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE m matches%ROWTYPE; r provider_ingest_receipts%ROWTYPE;
        example training_dataset_maps%ROWTYPE; reasons TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF map_id IS NULL OR map_id<=0 OR snapshot_at IS NULL OR team_a_side IS NULL
    OR team_a_side NOT IN ('radiant','dire') THEN
    RAISE EXCEPTION 'Invalid outcome verification request' USING ERRCODE='22023';
  END IF;
  IF snapshot_at>clock_timestamp() THEN
    RETURN jsonb_build_object('status','unavailable','matchId',map_id::text,'reasons',jsonb_build_array('SNAPSHOT_IN_FUTURE'));
  END IF;
  SELECT * INTO m FROM matches WHERE id=map_id FOR SHARE;
  IF m.id IS NULL THEN
    RETURN jsonb_build_object('status','unavailable','matchId',map_id::text,'reasons',jsonb_build_array('MAP_NOT_FOUND'));
  END IF;
  IF m.is_pro IS DISTINCT FROM TRUE THEN reasons=array_append(reasons,'PRO_STATUS_UNVERIFIED'); END IF;
  IF m.ingest_state='conflict' THEN reasons=array_append(reasons,'MAP_CONFLICT'); END IF;
  IF m.radiant_win IS NULL OR m.duration_seconds IS NULL OR m.duration_seconds<=0
    OR m.started_at+make_interval(secs=>m.duration_seconds)>snapshot_at THEN
    reasons=array_append(reasons,'OUTCOME_NOT_COMPLETED_AT_SNAPSHOT');
  END IF;
  IF m.radiant_team_id IS NULL OR m.dire_team_id IS NULL OR m.radiant_team_id=m.dire_team_id THEN
    reasons=array_append(reasons,'TEAM_SIDES_UNKNOWN');
  END IF;
  -- JS Date and the dataset request contract are millisecond precision. Never
  -- round a PostgreSQL timestamp across a strict cutoff boundary.
  IF m.started_at<>date_trunc('milliseconds',m.started_at) THEN
    reasons=array_append(reasons,'UNSUPPORTED_TIMESTAMP_PRECISION');
  END IF;
  IF cardinality(reasons)>0 THEN
    RETURN jsonb_build_object('status','unavailable','matchId',map_id::text,'reasons',to_jsonb(reasons));
  END IF;
  example.match_id=m.id;
  example.team_a_id=CASE WHEN team_a_side='radiant' THEN m.radiant_team_id ELSE m.dire_team_id END;
  example.team_b_id=CASE WHEN team_a_side='radiant' THEN m.dire_team_id ELSE m.radiant_team_id END;
  example.team_a_won=CASE WHEN team_a_side='radiant' THEN m.radiant_win ELSE NOT m.radiant_win END;
  example.cutoff_at=m.started_at;
  example.match_data_revision=m.data_revision;
  example.series_id_snapshot=m.series_id;
  example.label_verified_at=snapshot_at;
  FOR r IN SELECT * FROM provider_ingest_receipts
    WHERE canonical_match_id=m.id AND provider='opendota' AND status IN ('accepted','partial')
      AND fetched_at<=snapshot_at ORDER BY fetched_at DESC,id DESC LOOP
    example.outcome_receipt_id=r.id;
    example.label_source='opendota:receipt:'||r.id::text;
    BEGIN
      -- Includes provider payload equality and the immutable professional league
      -- reference fetched no later than example.label_verified_at.
      PERFORM assert_training_map_evidence(example);
    EXCEPTION WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
      CONTINUE;
    END;
    RETURN jsonb_build_object('status','verified','matchId',m.id::text,
      'outcomeReceiptId',r.id::text,'teamAId',example.team_a_id::text,'teamBId',example.team_b_id::text,
      'teamAWon',example.team_a_won,'seriesId',m.series_id,'dataRevision',m.data_revision::text,
      'startedAt',to_char(m.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'completedAt',to_char((m.started_at+make_interval(secs=>m.duration_seconds)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'labelVerifiedAt',to_char(snapshot_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sourceEvidence',jsonb_build_object('receiptId',r.id::text,'payloadSha256',r.payload_sha256,
        'adapterVersion',r.adapter_version,'normalizerVersion',r.normalizer_version,
        'receiptFetchedAt',to_char(r.fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END LOOP;
  RETURN jsonb_build_object('status','unavailable','matchId',map_id::text,
    'reasons',jsonb_build_array('NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT'));
END;
$$;
