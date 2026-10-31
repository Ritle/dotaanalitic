-- Harden 005 without modifying existing frozen snapshots or previous migrations.
ALTER TABLE provider_ingest_receipts ADD CONSTRAINT uq_receipt_canonical_map UNIQUE(id,canonical_match_id);
ALTER TABLE training_dataset_maps
  ADD COLUMN outcome_receipt_id BIGINT,
  ADD COLUMN match_data_revision BIGINT CHECK (match_data_revision >= 0),
  ADD COLUMN series_id_snapshot UUID REFERENCES series(id),
  ADD CONSTRAINT fk_training_outcome_receipt FOREIGN KEY(outcome_receipt_id,match_id)
    REFERENCES provider_ingest_receipts(id,canonical_match_id);

-- PostgreSQL JSONB text is the specified canonical byte representation for these hashes.
CREATE FUNCTION training_json_hash(value JSONB) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex');
$$;

CREATE FUNCTION training_dataset_content(dataset UUID) RETURNS JSONB LANGUAGE SQL STABLE SET TimeZone='UTC' AS $$
  SELECT jsonb_build_object('format','pg-jsonb-dataset-v1','manifest',
    to_jsonb(v)-'id'-'status'-'dataset_fingerprint'-'frozen_at'-'created_at','maps',
    (SELECT jsonb_agg((to_jsonb(x)-'dataset_version_id') || jsonb_build_object('match_id',x.match_id::text,
      'team_a_id',x.team_a_id::text,'team_b_id',x.team_b_id::text,'outcome_receipt_id',x.outcome_receipt_id::text,
      'match_data_revision',x.match_data_revision::text) ORDER BY x.match_id)
      FROM training_dataset_maps x WHERE x.dataset_version_id=v.id))
  FROM training_dataset_versions v WHERE v.id=dataset;
$$;

CREATE FUNCTION assert_training_map_evidence(example training_dataset_maps) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE m matches%ROWTYPE; r provider_ingest_receipts%ROWTYPE;
        radiant_external BIGINT; dire_external BIGINT; league_external BIGINT;
BEGIN
  SELECT * INTO m FROM matches WHERE id=example.match_id FOR SHARE;
  IF m.id IS NULL OR m.is_pro IS DISTINCT FROM TRUE OR m.ingest_state='conflict'
    OR m.duration_seconds IS NULL OR m.duration_seconds <= 0 OR m.radiant_win IS NULL
    OR m.radiant_team_id IS NULL OR m.dire_team_id IS NULL
    OR example.cutoff_at IS DISTINCT FROM m.started_at
    OR example.match_data_revision IS DISTINCT FROM m.data_revision
    OR example.series_id_snapshot IS DISTINCT FROM m.series_id
    OR example.label_verified_at < m.started_at + make_interval(secs=>m.duration_seconds)
    OR example.label_verified_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Unverified or stale completed pro map target' USING ERRCODE='23514';
  END IF;
  IF NOT ((example.team_a_id=m.radiant_team_id AND example.team_b_id=m.dire_team_id AND example.team_a_won=m.radiant_win)
    OR (example.team_a_id=m.dire_team_id AND example.team_b_id=m.radiant_team_id AND example.team_a_won<>m.radiant_win)) THEN
    RAISE EXCEPTION 'Wrong team-side orientation or outcome label' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM provider_ingest_receipts WHERE id=example.outcome_receipt_id;
  SELECT opendota_team_id INTO radiant_external FROM teams WHERE id=m.radiant_team_id;
  SELECT opendota_team_id INTO dire_external FROM teams WHERE id=m.dire_team_id;
  SELECT opendota_league_id INTO league_external FROM leagues WHERE id=m.league_id;
  IF r.id IS NULL OR r.provider<>'opendota' OR r.status NOT IN ('accepted','partial')
    OR r.canonical_match_id IS DISTINCT FROM m.id OR r.provider_match_id IS DISTINCT FROM m.id::text
    OR r.fetched_at < m.started_at + make_interval(secs=>m.duration_seconds)
    OR example.label_verified_at < r.fetched_at
    OR example.label_source IS DISTINCT FROM 'opendota:receipt:'||r.id::text
    OR (r.source_payload->>'match_id') IS DISTINCT FROM m.id::text
    OR (r.source_payload->>'start_time')::numeric IS DISTINCT FROM extract(epoch FROM m.started_at)
    OR (r.source_payload->>'duration')::integer IS DISTINCT FROM m.duration_seconds
    OR (r.source_payload->>'radiant_win')::boolean IS DISTINCT FROM m.radiant_win
    OR radiant_external IS NULL OR dire_external IS NULL OR league_external IS NULL
    OR (r.source_payload->>'radiant_team_id') IS DISTINCT FROM radiant_external::text
    OR (r.source_payload->>'dire_team_id') IS DISTINCT FROM dire_external::text
    OR (r.source_payload->>'leagueid') IS DISTINCT FROM league_external::text THEN
    RAISE EXCEPTION 'Label requires matching immutable provider receipt' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM match_field_observations o JOIN provider_reference_snapshots ref
      ON ref.id::text=o.value->>'reference_id'
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ref.source_payload)='array'
      THEN ref.source_payload ELSE '[]'::jsonb END) league
    WHERE o.receipt_id=r.id AND o.match_id=m.id AND o.field_name='pro_classification'
      AND o.value->'value'='true'::jsonb AND o.value->>'league_tier' IN ('professional','premium')
      AND ref.provider='opendota' AND ref.fetched_at<=example.label_verified_at
      AND league->>'leagueid'=league_external::text AND league->>'tier'=o.value->>'league_tier'
  ) THEN RAISE EXCEPTION 'Label requires immutable professional league evidence' USING ERRCODE='23514'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_and_guard_training_dataset_map() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent training_dataset_versions%ROWTYPE;
BEGIN
  -- Exclusive parent lock serializes siblings, split checks and freeze/append races.
  SELECT * INTO parent FROM training_dataset_versions
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.dataset_version_id ELSE NEW.dataset_version_id END FOR UPDATE;
  IF parent.status IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION 'Only building datasets accept example changes; terminal dataset is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND (OLD.dataset_version_id IS DISTINCT FROM NEW.dataset_version_id OR OLD.match_id IS DISTINCT FROM NEW.match_id) THEN
    RAISE EXCEPTION 'Cannot reassign a training example' USING ERRCODE='55000';
  END IF;
  PERFORM assert_training_map_evidence(NEW);
  IF jsonb_typeof(NEW.input_features)<>'object' OR jsonb_typeof(NEW.source_evidence)<>'object'
    OR EXISTS (SELECT 1 FROM jsonb_each(NEW.input_features) f WHERE jsonb_typeof(f.value) NOT IN ('number','null')
      OR CASE WHEN jsonb_typeof(f.value)='number' THEN abs((f.value::text)::numeric)>1.7976931348623157e308 ELSE FALSE END
      OR f.key !~ '^[a-z][a-z0-9_]{0,95}$'
      OR f.key IN ('radiant_win','team_a_won','winner','label','outcome','duration','duration_seconds','kills','gpm',
        'prediction','probability','prediction_run_id')
      OR (parent.stage='pre_match' AND f.key IN ('heroes','hero_id','first_pick_side','draft_order_version')))
    OR NEW.input_hash IS DISTINCT FROM training_json_hash(NEW.input_features) THEN
    RAISE EXCEPTION 'Invalid feature object or hash; labels and current-map outcomes are separate' USING ERRCODE='23514';
  END IF;
  IF NEW.series_id_snapshot IS NOT NULL AND EXISTS (SELECT 1 FROM training_dataset_maps x
    WHERE x.dataset_version_id=NEW.dataset_version_id AND x.match_id<>NEW.match_id
      AND x.series_id_snapshot=NEW.series_id_snapshot AND x.split<>NEW.split) THEN
    RAISE EXCEPTION 'Whole series must share one split' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_training_dataset_version_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE example training_dataset_maps%ROWTYPE; fingerprint TEXT;
BEGIN
  IF TG_OP<>'DELETE' AND (NEW.label_policy_version<>'verified-map-v1'
    OR jsonb_typeof(NEW.split_policy)<>'object' OR jsonb_typeof(NEW.source_manifest)<>'object'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[NEW.feature_schema_version,NEW.cutoff_policy_version,
      NEW.patch_registry_revision,NEW.data_revision,NEW.code_revision]) value WHERE length(btrim(value)) NOT BETWEEN 1 AND 512)) THEN
    RAISE EXCEPTION 'Invalid versioned dataset manifest' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'building' OR NEW.frozen_at IS NOT NULL OR NEW.dataset_fingerprint IS NOT NULL THEN
      RAISE EXCEPTION 'Dataset must start building' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('frozen','rejected') THEN
    RAISE EXCEPTION 'Frozen or rejected training dataset is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Cannot reassign dataset id' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM training_dataset_maps WHERE dataset_version_id=OLD.id) AND
    (to_jsonb(NEW)-'status'-'frozen_at'-'dataset_fingerprint') IS DISTINCT FROM
    (to_jsonb(OLD)-'status'-'frozen_at'-'dataset_fingerprint') THEN
    RAISE EXCEPTION 'Cannot change dataset manifest with existing examples' USING ERRCODE='55000';
  END IF;
  IF NEW.status='frozen' THEN
    IF NOT EXISTS (SELECT 1 FROM training_dataset_maps WHERE dataset_version_id=NEW.id) THEN
      RAISE EXCEPTION 'Cannot freeze an empty dataset' USING ERRCODE='23514';
    END IF;
    FOR example IN SELECT * FROM training_dataset_maps WHERE dataset_version_id=NEW.id ORDER BY match_id LOOP
      PERFORM assert_training_map_evidence(example);
    END LOOP;
    IF EXISTS (SELECT 1 FROM training_dataset_maps WHERE dataset_version_id=NEW.id AND series_id_snapshot IS NOT NULL
      GROUP BY series_id_snapshot HAVING count(DISTINCT split)>1) THEN
      RAISE EXCEPTION 'Whole series must share one split' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM training_dataset_maps a JOIN training_dataset_maps b ON a.dataset_version_id=b.dataset_version_id
      WHERE a.dataset_version_id=NEW.id AND array_position(ARRAY['train','calibration','validation','test'],a.split)
        < array_position(ARRAY['train','calibration','validation','test'],b.split) AND a.cutoff_at>=b.cutoff_at) THEN
      RAISE EXCEPTION 'Dataset splits must be strictly chronological' USING ERRCODE='23514';
    END IF;
    fingerprint=training_json_hash(training_dataset_content(NEW.id));
    IF NEW.dataset_fingerprint IS NOT NULL AND NEW.dataset_fingerprint<>fingerprint THEN
      RAISE EXCEPTION 'Dataset fingerprint mismatch' USING ERRCODE='23514';
    END IF;
    NEW.dataset_fingerprint=fingerprint;
    NEW.frozen_at=date_trunc('milliseconds',clock_timestamp());
  ELSIF NEW.frozen_at IS NOT NULL OR NEW.dataset_fingerprint IS NOT NULL THEN
    RAISE EXCEPTION 'Only frozen datasets have a fingerprint and freeze time' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_training_dataset_initial_state BEFORE INSERT ON training_dataset_versions
  FOR EACH ROW EXECUTE FUNCTION guard_training_dataset_version_frozen();
-- Legacy frozen rows are preserved, never upgraded to verified feature eligibility.
