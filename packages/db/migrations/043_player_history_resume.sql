-- Evidence-only jobs reference an immutable accepted scope from an original import.
ALTER TABLE player_history_runs ADD COLUMN operation text NOT NULL DEFAULT 'import'
 CHECK(operation IN ('import','evidence_resume'));
ALTER TABLE player_history_runs ADD COLUMN parent_run_id uuid REFERENCES player_history_runs(id);
ALTER TABLE player_history_runs ADD COLUMN scope_map_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE player_history_runs ADD CONSTRAINT player_history_resume_scope CHECK(
 jsonb_typeof(scope_map_ids)='array' AND jsonb_array_length(scope_map_ids)<=50 AND
 ((operation='import' AND parent_run_id IS NULL AND scope_map_ids='[]'::jsonb) OR
 (operation='evidence_resume' AND parent_run_id IS NOT NULL AND jsonb_array_length(scope_map_ids)>0)));
CREATE FUNCTION guard_player_history_resume() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p player_history_runs%ROWTYPE; expected jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.operation='evidence_resume' AND OLD.status IN ('completed','partial','error') OR EXISTS(SELECT 1 FROM player_history_runs WHERE parent_run_id=OLD.id) THEN
   RAISE EXCEPTION 'history_resume_report_immutable';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' AND NEW.operation='evidence_resume' THEN
  SELECT * INTO p FROM player_history_runs WHERE id=NEW.parent_run_id FOR SHARE;
  IF NOT FOUND OR p.operation<>'import' OR p.status NOT IN ('completed','partial','error') OR p.report IS NULL
   OR p.owner_user_id<>NEW.owner_user_id OR p.lineup_key<>NEW.lineup_key OR p.bindings<>NEW.bindings OR p.options<>NEW.options THEN
   RAISE EXCEPTION 'history_resume_parent_invalid';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(id) ORDER BY id::bigint),'[]'::jsonb) INTO expected
   FROM (SELECT DISTINCT m->>'matchId' id FROM jsonb_array_elements(p.report->'maps') m
    WHERE m->>'status' IN ('accepted','duplicate')) s;
  IF NEW.scope_map_ids<>expected THEN RAISE EXCEPTION 'history_resume_scope_invalid'; END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF (OLD.operation='evidence_resume' AND OLD.status IN ('completed','partial','error') OR
   EXISTS(SELECT 1 FROM player_history_runs WHERE parent_run_id=OLD.id)) AND
   (to_jsonb(OLD)-'next_allowed_at') IS DISTINCT FROM (to_jsonb(NEW)-'next_allowed_at') THEN
   RAISE EXCEPTION 'history_resume_report_immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER player_history_resume_guard BEFORE INSERT OR UPDATE OR DELETE ON player_history_runs
 FOR EACH ROW EXECUTE FUNCTION guard_player_history_resume();

-- A derived projection has its own SHA/clock. The original receipt and reference clocks remain intact.
CREATE TABLE player_history_projection_replays(
 run_id uuid NOT NULL REFERENCES player_history_runs(id), attempt integer NOT NULL CHECK(attempt>0),
 match_id bigint NOT NULL REFERENCES matches(id), parent_receipt_id bigint NOT NULL REFERENCES provider_ingest_receipts(id),
 derived_receipt_id bigint NOT NULL REFERENCES provider_ingest_receipts(id),
 parent_hero_reference_id bigint NOT NULL REFERENCES provider_reference_snapshots(id),
 parent_league_reference_id bigint NOT NULL REFERENCES provider_reference_snapshots(id),
 derived_sha256 char(64) NOT NULL CHECK(derived_sha256 ~ '^[a-f0-9]{64}$'),
 derived_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,attempt,match_id)
);
CREATE FUNCTION guard_player_history_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p provider_ingest_receipts%ROWTYPE; d provider_ingest_receipts%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'history_projection_immutable'; END IF;
 SELECT * INTO p FROM provider_ingest_receipts WHERE id=NEW.parent_receipt_id;
 SELECT * INTO d FROM provider_ingest_receipts WHERE id=NEW.derived_receipt_id;
 IF p.id IS NULL OR d.id IS NULL OR p.provider<>'opendota' OR p.provider_match_id<>NEW.match_id::text OR p.status NOT IN ('accepted','partial')
  OR d.provider<>'opendota' OR d.provider_match_id<>p.provider_match_id OR d.source_payload<>p.source_payload
  OR d.adapter_version<>'stored-history-projection-v1' OR d.payload_sha256<>NEW.derived_sha256
  OR d.fetched_at<>NEW.derived_at OR NEW.derived_at<p.fetched_at OR NEW.derived_at>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM player_history_runs r WHERE r.id=NEW.run_id AND r.operation='evidence_resume'
   AND r.status='running' AND r.attempt=NEW.attempt AND r.scope_map_ids ? NEW.match_id::text)
  OR NOT EXISTS(SELECT 1 FROM provider_reference_snapshots WHERE id=NEW.parent_hero_reference_id AND provider='opendota' AND endpoint='/heroes')
  OR NOT EXISTS(SELECT 1 FROM provider_reference_snapshots WHERE id=NEW.parent_league_reference_id AND provider='opendota' AND endpoint='/leagues') THEN
  RAISE EXCEPTION 'history_projection_binding_invalid';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER player_history_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON player_history_projection_replays
 FOR EACH ROW EXECUTE FUNCTION guard_player_history_projection();
CREATE TRIGGER player_history_projection_truncate_guard BEFORE TRUNCATE ON player_history_projection_replays
 FOR EACH STATEMENT EXECUTE FUNCTION guard_player_history_projection();
