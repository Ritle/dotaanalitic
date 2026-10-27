-- v9 forward-only source observations and orthogonal quality assessments.
-- Requires 001..005 (match_source_snapshots in migration 004).
-- No backfill guesses: existing matches remain without quality assessment until evaluated.

-- Composite references prevent an observation/assessment from pointing to a
-- provider snapshot belonging to a different map.
ALTER TABLE match_source_snapshots
  ADD CONSTRAINT uq_match_source_snapshots_id_match UNIQUE (id, match_id);

-- An immutable observation of the raw provider draft array, including missing (SQL NULL),
-- empty [], inconsistent and extra pick events. JSONB retains event values and order
-- of array elements. Original HTTP bytes may be referenced by match_source_snapshots.
CREATE TABLE match_draft_source_observations (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source_snapshot_id BIGINT,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 120),
  fetched_at TIMESTAMPTZ NOT NULL,
  raw_picks_bans JSONB,
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (raw_picks_bans IS NULL OR jsonb_typeof(raw_picks_bans) = 'array'),
  UNIQUE (match_id, provider, adapter_version, payload_sha256),
  UNIQUE (id,match_id),
  FOREIGN KEY (source_snapshot_id,match_id) REFERENCES match_source_snapshots(id,match_id)
);
CREATE INDEX idx_draft_raw_match_time
  ON match_draft_source_observations(match_id, fetched_at DESC);

-- These are versioned assessments of independent data dimensions, NOT static
-- train eligibility. Train eligibility requires stage, point-in-time evidence,
-- feature policy and the frozen dataset revision, and is computed downstream.
CREATE TABLE match_quality_assessments (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source_snapshot_id BIGINT,
  draft_observation_id BIGINT,
  validator_version TEXT NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 120),
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (outcome_status IN ('unknown','eligible','ineligible')),
  player_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (player_status IN ('unknown','eligible','ineligible')),
  final_heroes_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (final_heroes_status IN ('unknown','eligible','ineligible')),
  organization_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (organization_status IN ('unknown','eligible','ineligible')),
  series_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (series_status IN ('unknown','eligible','ineligible')),
  draft_timeline_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (draft_timeline_status IN ('unknown','structurally_inconsistent','missing','verified')),
  -- Unknown mode or missing patch-specific rule => no verified timeline.
  draft_order_valid BOOLEAN,
  anomalies JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(anomalies) = 'array'),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metrics) = 'object'),
  CHECK (draft_timeline_status <> 'verified' OR draft_order_valid IS TRUE),
  UNIQUE NULLS NOT DISTINCT (match_id, source_snapshot_id, draft_observation_id, validator_version),
  FOREIGN KEY (source_snapshot_id,match_id) REFERENCES match_source_snapshots(id,match_id),
  FOREIGN KEY (draft_observation_id,match_id) REFERENCES match_draft_source_observations(id,match_id)
);
CREATE INDEX idx_quality_match_assessed
  ON match_quality_assessments(match_id,assessed_at DESC);
CREATE INDEX idx_quality_draft_status
  ON match_quality_assessments(draft_timeline_status,assessed_at DESC);

-- Enforce append-only semantics: corrections must be new observations/policy revisions.
CREATE FUNCTION guard_match_draft_quality_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable draft source/assessment: insert new revision instead';
END;
$$;
CREATE TRIGGER trg_match_draft_source_immutable
  BEFORE UPDATE OR DELETE ON match_draft_source_observations
  FOR EACH ROW EXECUTE FUNCTION guard_match_draft_quality_immutable();
CREATE TRIGGER trg_match_quality_assessment_immutable
  BEFORE UPDATE OR DELETE ON match_quality_assessments
  FOR EACH ROW EXECUTE FUNCTION guard_match_draft_quality_immutable();
