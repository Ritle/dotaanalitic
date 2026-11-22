-- Immutable Swiss-stage research registration. Separate from the full-event collector.
CREATE TABLE dl30_swiss_plans (
  digest text PRIMARY KEY,
  evidence text NOT NULL,
  owner_id uuid NOT NULL REFERENCES app_users(id),
  reviewed_at timestamptz NOT NULL,
  private_sources_reconciled boolean NOT NULL CHECK (private_sources_reconciled),
  recorded_at timestamptz NOT NULL,
  writer_xid bigint NOT NULL
);
CREATE TABLE dl30_swiss_receipts (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  digest text NOT NULL REFERENCES dl30_swiss_plans(digest),
  observed_at timestamptz NOT NULL
);

CREATE FUNCTION guard_dl30_swiss_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan dl30_swiss_plans%ROWTYPE;
  p jsonb;
  decision dl30_protocol_choice%ROWTYPE;
  at_time timestamptz;
  od_keys jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'swiss_receipt_immutable'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'read_committed_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045',0));
  IF TG_TABLE_NAME='dl30_swiss_plans' THEN
    plan := NEW;
    IF EXISTS (SELECT FROM dl30_swiss_receipts) THEN RAISE EXCEPTION 'receipt_already_observed'; END IF;
  ELSE
    SELECT * INTO STRICT plan FROM dl30_swiss_plans WHERE digest=NEW.digest FOR SHARE;
    IF plan.writer_xid=txid_current() THEN RAISE EXCEPTION 'commit_unobserved'; END IF;
  END IF;
  IF NOT (plan.evidence IS JSON OBJECT WITH UNIQUE KEYS)
    OR encode(sha256(convert_to(plan.evidence,'UTF8')),'hex') IS DISTINCT FROM plan.digest
  THEN RAISE EXCEPTION 'evidence_changed'; END IF;
  p := plan.evidence::jsonb;
  SELECT * INTO decision FROM dl30_protocol_choice WHERE singleton;
  IF decision.protocol IS DISTINCT FROM 'swiss_stage' OR decision.owner_user_id IS DISTINCT FROM plan.owner_id
    OR decision.proposal_sha256 IS DISTINCT FROM (p->>'proposalSha256')
  THEN RAISE EXCEPTION 'swiss_owner_choice_required'; END IF;
  PERFORM id FROM app_users WHERE id=plan.owner_id AND is_active AND account_role='owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active_owner_required'; END IF;
  IF p->>'format' IS DISTINCT FROM 'dl30-swiss-receipt-input-v1'
    OR p->>'packageSha256' IS DISTINCT FROM '51183190a4710947b1135167fe52dc1c6eb0f30aca21d1c30a0fc97b53c6bd1f'
    OR coalesce(p#>>'{binding,openDotaLeagueId}','') !~ '^[1-9][0-9]*$'
    OR p#>>'{binding,openDotaLeagueId}' IN ('20359','20511')
    OR coalesce(p#>>'{binding,pandaScoreEditionId}','') !~ '^[1-9][0-9]*$'
    OR jsonb_typeof(p#>'{binding,stages}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p#>'{binding,stages}') NOT IN (1,6)
    OR EXISTS (SELECT FROM jsonb_array_elements(p#>'{binding,stages}') s WHERE coalesce(s->>'id','') !~ '^[1-9][0-9]*$')
    OR (SELECT count(DISTINCT s->>'id') FROM jsonb_array_elements(p#>'{binding,stages}') s)
         <> jsonb_array_length(p#>'{binding,stages}')
    OR EXISTS (SELECT FROM jsonb_array_elements(p#>'{binding,stages}') WITH ORDINALITY s(stage,n)
       WHERE stage->'round' IS DISTINCT FROM
         CASE WHEN jsonb_array_length(p#>'{binding,stages}')=1 THEN 'null'::jsonb ELSE to_jsonb(n) END)
  THEN RAISE EXCEPTION 'stage_binding_required'; END IF;
  IF coalesce(p->>'privateExposureSha256','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p->>'pcReportSha256','') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'registryRevisions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p->'registryRevisions') = 0
    OR EXISTS (SELECT FROM jsonb_array_elements_text(p->'registryRevisions') revision
       WHERE coalesce(revision,'') !~ '^[a-f0-9]{64}$')
    OR (SELECT count(DISTINCT revision) FROM jsonb_array_elements_text(p->'registryRevisions') revision)
       <> jsonb_array_length(p->'registryRevisions')
  THEN RAISE EXCEPTION 'swiss_inventory_evidence_required'; END IF;
  IF EXISTS (SELECT FROM unnest(ARRAY['local','peer']) k
    WHERE coalesce(p->'reviews'->k->>'sha256','') !~ '^[a-f0-9]{64}$'
      OR (p->'reviews'->k->>'capturedAt')::timestamptz IS NULL
      OR (p->'reviews'->k->>'capturedAt')::timestamptz > plan.reviewed_at)
    OR p#>>'{reviews,local,sha256}' = p#>>'{reviews,peer,sha256}'
  THEN RAISE EXCEPTION 'pc_review_required'; END IF;
  IF EXISTS (SELECT FROM unnest(ARRAY['calendar','valve','opendota','editions']) k
    WHERE coalesce(p->'sources'->k->>'sha256','') !~ '^[a-f0-9]{64}$'
      OR (p->'sources'->k->>'fetchedAt')::timestamptz IS NULL
      OR (p->'sources'->k->>'fetchedAt')::timestamptz > plan.reviewed_at)
  THEN RAISE EXCEPTION 'stage_sources_required'; END IF;
  LOCK TABLE matches,series,provider_ingest_receipts,journal_provider_result_receipts IN SHARE MODE;
  at_time := conditional_real_registration_clock();
  IF plan.reviewed_at < decision.selected_at OR plan.reviewed_at > at_time
    OR at_time >= timestamptz '2026-11-30 18:00:00+00'
    OR (p->>'firstSeriesStartLowerBound')::timestamptz IS DISTINCT FROM timestamptz '2026-12-01 10:00:00+00'
    OR at_time >= (p->>'firstSeriesStartLowerBound')::timestamptz
  THEN RAISE EXCEPTION 'swiss_registration_time_invalid'; END IF;
  IF EXISTS (SELECT FROM unnest(ARRAY['mapIds','openDotaSeriesIds','pandaScoreMeetingIds']) k
    WHERE jsonb_typeof(p->'inventory'->k) IS DISTINCT FROM 'array')
  THEN RAISE EXCEPTION 'inventory_required'; END IF;
  IF jsonb_array_length(p#>'{inventory,pandaScoreMeetingIds}') > 100000
    OR EXISTS (SELECT FROM jsonb_array_elements(p#>'{inventory,pandaScoreMeetingIds}') item
      WHERE jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ '^[1-9][0-9]{0,18}$'
        OR (length(item #>> '{}')=19 AND (item #>> '{}') COLLATE "C" > '9223372036854775807'))
    OR (SELECT count(DISTINCT item) FROM jsonb_array_elements_text(p#>'{inventory,pandaScoreMeetingIds}') item)
      <> jsonb_array_length(p#>'{inventory,pandaScoreMeetingIds}')
  THEN RAISE EXCEPTION 'dl30_exclusions_invalid'; END IF;
  -- JS hashes these three arrays of decimal strings in this exact field order.
  IF p->>'unionSha256' IS DISTINCT FROM encode(sha256(convert_to(format(
    '{"mapIds":%s,"openDotaSeriesIds":%s,"pandaScoreMeetingIds":%s}',
    replace((p#>'{inventory,mapIds}')::text,', ',','),
    replace((p#>'{inventory,openDotaSeriesIds}')::text,', ',','),
    replace((p#>'{inventory,pandaScoreMeetingIds}')::text,', ',',')),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'inventory_digest_mismatch'; END IF;
  SELECT coalesce(jsonb_agg(format('["opendota","%s"]',id)),'[]'::jsonb) INTO od_keys
    FROM jsonb_array_elements_text(p#>'{inventory,openDotaSeriesIds}') ids(id);
  PERFORM check_dl30_exclusions('{}'::jsonb,jsonb_build_object('mapIds',p#>'{inventory,mapIds}','canonicalSeriesKeys',od_keys));
  IF EXISTS (
    SELECT provider_match_id::text FROM journal_provider_result_receipts
      WHERE observation_text::jsonb #>> '{source,provider}'='pandascore'
        AND observation_text::jsonb #>> '{source,adapterVersion}'='pandascore-result-probe-v1'
    EXCEPT SELECT value FROM jsonb_array_elements_text(p#>'{inventory,pandaScoreMeetingIds}')
  ) THEN RAISE EXCEPTION 'dl30_inventory_changed'; END IF;
  IF EXISTS (SELECT FROM matches WHERE league_id::text=p#>>'{binding,openDotaLeagueId}')
    OR EXISTS (SELECT FROM provider_ingest_receipts WHERE provider='opendota'
      AND source_payload->>'leagueid'=p#>>'{binding,openDotaLeagueId}')
  THEN RAISE EXCEPTION 'swiss_target_league_already_observed'; END IF;
  IF TG_TABLE_NAME='dl30_swiss_plans' THEN
    NEW.recorded_at := at_time;
    NEW.writer_xid := txid_current();
  ELSE
    IF at_time < plan.recorded_at THEN RAISE EXCEPTION 'swiss_clock_regression'; END IF;
    NEW.observed_at := at_time;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dl30_swiss_plan_write BEFORE INSERT OR UPDATE OR DELETE ON dl30_swiss_plans
FOR EACH ROW EXECUTE FUNCTION guard_dl30_swiss_registration();
CREATE TRIGGER dl30_swiss_receipt_write BEFORE INSERT OR UPDATE OR DELETE ON dl30_swiss_receipts
FOR EACH ROW EXECUTE FUNCTION guard_dl30_swiss_registration();
CREATE TRIGGER dl30_swiss_plan_truncate BEFORE TRUNCATE ON dl30_swiss_plans
FOR EACH STATEMENT EXECUTE FUNCTION guard_dl30_swiss_registration();
CREATE TRIGGER dl30_swiss_receipt_truncate BEFORE TRUNCATE ON dl30_swiss_receipts
FOR EACH STATEMENT EXECUTE FUNCTION guard_dl30_swiss_registration();

CREATE FUNCTION write_dl30_swiss_plan(owner_id uuid, expected_digest text, evidence_text text)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE saved dl30_swiss_plans%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'read_committed_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045',0));
  SELECT * INTO saved FROM dl30_swiss_plans WHERE digest=expected_digest;
  IF FOUND THEN
    IF (saved.owner_id,saved.evidence) IS DISTINCT FROM (owner_id,evidence_text)
    THEN RAISE EXCEPTION 'evidence_changed'; END IF;
    RETURN;
  END IF;
  INSERT INTO dl30_swiss_plans(digest,evidence,owner_id,reviewed_at,private_sources_reconciled)
    VALUES(expected_digest,evidence_text,owner_id,conditional_real_registration_clock(),true);
END $$;

CREATE FUNCTION observe_dl30_swiss_registration(expected_digest text) RETURNS dl30_swiss_receipts
LANGUAGE plpgsql VOLATILE AS $$
DECLARE receipt dl30_swiss_receipts%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'read_committed_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045',0));
  SELECT * INTO receipt FROM dl30_swiss_receipts WHERE singleton;
  IF FOUND THEN
    IF receipt.digest IS DISTINCT FROM expected_digest THEN RAISE EXCEPTION 'receipt_already_observed'; END IF;
    RETURN receipt;
  END IF;
  INSERT INTO dl30_swiss_receipts(digest) VALUES(expected_digest) RETURNING * INTO receipt;
  RETURN receipt;
END $$;
