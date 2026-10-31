-- Typed, evidence-reviewed context alongside immutable raw provider observations.
-- No backfill of known_at, event_at or stage from matches.started_at/fetched_at.
ALTER TABLE match_field_observations
  ADD COLUMN event_at TIMESTAMPTZ,
  ADD COLUMN availability_class TEXT NOT NULL DEFAULT 'unknown'
    CHECK (availability_class IN ('verified_asof','user_asserted_asof','retrospective_fact','unknown')),
  ADD COLUMN earliest_stage TEXT NOT NULL DEFAULT 'post_match'
    CHECK (earliest_stage IN ('pre_match','post_draft','post_match')),
  ADD COLUMN context_sha256 CHAR(64) CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_context_evidence CHECK (context_sha256 IS NULL OR (
    field_name IN ('context.series_id','context.map_number','context.series_score_before',
      'context.teams','context.first_pick_side','context.draft_order_version',
      'context.lineup','context.roles','context.heroes')
    AND (known_at IS NULL OR known_at <= fetched_at)
    AND (event_at IS NULL OR event_at <= fetched_at)
    -- Typed JS contracts have millisecond precision: reject, never truncate future knowledge.
    AND fetched_at = date_trunc('milliseconds',fetched_at)
    AND (known_at IS NULL OR known_at = date_trunc('milliseconds',known_at))
    AND (event_at IS NULL OR event_at = date_trunc('milliseconds',event_at))
    AND (availability_class <> 'verified_asof' OR
      (known_at IS NOT NULL AND evidence_ref IS NOT NULL AND length(btrim(evidence_ref)) > 0))
    AND (field_name NOT IN ('context.heroes','context.first_pick_side','context.draft_order_version')
      OR earliest_stage <> 'pre_match')
  ));
CREATE UNIQUE INDEX uq_context_observation ON match_field_observations(match_id,context_sha256)
  WHERE context_sha256 IS NOT NULL;
CREATE INDEX idx_context_asof ON match_field_observations(match_id,known_at)
  WHERE context_sha256 IS NOT NULL;
-- Existing immutable trigger also protects new context evidence. Corrections append.
COMMENT ON COLUMN matches.started_at IS 'Actual single-map start (played_at); never historical knowledge time';
COMMENT ON COLUMN match_field_observations.event_at IS 'Fact announcement/observation event; NULL if unproven, independent of map start';
COMMENT ON COLUMN match_field_observations.known_at IS 'Evidence-backed public availability; never inferred from fetch or completed lineup';
