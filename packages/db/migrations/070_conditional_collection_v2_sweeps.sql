-- Explicit refresh boundaries only; no request budget, outcomes or activation authority.
CREATE TABLE conditional_collection_v2_sweeps (
 registration_id UUID NOT NULL REFERENCES conditional_real_registrations(id),
 sweep_id UUID NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 999),
 base_head_sha256 TEXT NOT NULL, base_request_count INTEGER NOT NULL CHECK(base_request_count BETWEEN 1 AND 1000),
 parent_sha256 TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT conditional_collection_clock(),
 marker_text TEXT NOT NULL DEFAULT '', marker_sha256 TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(registration_id,sweep_id), UNIQUE(registration_id,sequence), UNIQUE(registration_id,base_head_sha256)
);
CREATE FUNCTION guard_conditional_collection_v2_sweep() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE a conditional_blob_archives%ROWTYPE; e conditional_collection_v2_events%ROWTYPE;
 previous conditional_collection_v2_sweeps%ROWTYPE; p JSONB; n INTEGER;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'collection_v2_sweep_immutable'; END IF;
 a:=conditional_blob_archive_lock(NEW.registration_id);
 IF a.registration_id IS NULL OR NOT a.synthetic_only THEN RAISE EXCEPTION 'collection_v2_sweep_synthetic_archive_required'; END IF;
 SELECT package_text::jsonb INTO p FROM conditional_real_registrations WHERE id=NEW.registration_id;
 IF NOT (p->'executable'->'code' ?& ARRAY['tools/research/conditional-collection-v2-refresh.mjs',
  'tools/research/run-conditional-collection-v2-refresh.mjs','packages/db/migrations/070_conditional_collection_v2_sweeps.sql'])
 THEN RAISE EXCEPTION 'collection_v2_sweep_manifest_required'; END IF;
 SELECT * INTO e FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id ORDER BY sequence DESC LIMIT 1;
 SELECT count(*) INTO n FROM conditional_collection_v2_events WHERE registration_id=NEW.registration_id AND event_text::jsonb->>'kind'='reserved';
 SELECT * INTO previous FROM conditional_collection_v2_sweeps WHERE registration_id=NEW.registration_id ORDER BY sequence DESC LIMIT 1;
 IF e.head_sha256 IS NULL OR NEW.base_head_sha256 IS DISTINCT FROM e.head_sha256
  OR e.event_text::jsonb->>'kind'='reserved' OR NEW.base_request_count IS DISTINCT FROM n
  OR NEW.sequence IS DISTINCT FROM coalesce(previous.sequence+1,0) OR NEW.parent_sha256 IS DISTINCT FROM previous.marker_sha256
  OR NEW.base_request_count<=coalesce(previous.base_request_count,0)
 THEN RAISE EXCEPTION 'collection_v2_sweep_boundary_conflict'; END IF;
 NEW.created_at:=conditional_collection_clock();
 IF NEW.created_at<greatest(e.recorded_at,previous.created_at)
  OR NEW.created_at<((p->>'policyText')::jsonb->'proposedRegistration'->>'from')::timestamptz
  OR NEW.created_at>=((p->>'policyText')::jsonb->'proposedRegistration'->>'assessmentAt')::timestamptz
 THEN RAISE EXCEPTION 'collection_v2_sweep_clock_or_window'; END IF;
 NEW.marker_text:=jsonb_build_object('format','conditional-collection-v2-sweep-v1','registrationId',NEW.registration_id,
  'registrationSha256',a.registration_sha256,'sweepId',NEW.sweep_id,'sequence',NEW.sequence,
  'baseHeadSha256',NEW.base_head_sha256,'baseRequestCount',NEW.base_request_count,'parentSha256',NEW.parent_sha256,
  'syntheticOnly',true,'createdAt',to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
 NEW.marker_sha256:=encode(sha256(convert_to(NEW.marker_text,'UTF8')),'hex');RETURN NEW;
END; $$;
CREATE TRIGGER conditional_collection_v2_sweep_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_collection_v2_sweeps
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_collection_v2_sweep();
CREATE TRIGGER conditional_collection_v2_sweep_no_truncate BEFORE TRUNCATE ON conditional_collection_v2_sweeps
 FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_collection_v2_sweep();
