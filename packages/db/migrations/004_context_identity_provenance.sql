-- Personal MVP: point-in-time game context, canonical player identity and provider provenance.
-- Forward-only migration: depends on 001_initial, 002_patch_awareness, 003_roster_continuity.
-- Nullable columns represent UNKNOWN, not false or zero; don't backfill conjectures.

-- A series and a map are distinct objects. Map number/score are nullable until verified.
ALTER TABLE series
  ADD COLUMN tournament_stage TEXT,
  ADD COLUMN venue_kind TEXT CHECK (venue_kind IN ('lan','online','hybrid','unknown')),
  ADD COLUMN context_known_at TIMESTAMPTZ;

ALTER TABLE matches
  ADD COLUMN map_number SMALLINT CHECK (map_number > 0),
  ADD COLUMN radiant_series_wins_before SMALLINT CHECK (radiant_series_wins_before >= 0),
  ADD COLUMN dire_series_wins_before SMALLINT CHECK (dire_series_wins_before >= 0),
  ADD COLUMN first_pick_side TEXT CHECK (first_pick_side IN ('radiant','dire')),
  ADD COLUMN draft_order_version TEXT,
  ADD COLUMN venue_kind TEXT CHECK (venue_kind IN ('lan','online','hybrid','unknown')),
  ADD COLUMN tournament_stage TEXT;
CREATE UNIQUE INDEX uq_matches_series_map_number
  ON matches(series_id, map_number)
  WHERE series_id IS NOT NULL AND map_number IS NOT NULL;

-- No future field is automatically considered known before its first observation.
-- Known_at is independent of fetched_at; historical API backfills cannot invent known_at.
CREATE TABLE match_field_observations (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  value JSONB,
  provider_record_id TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  known_at TIMESTAMPTZ,
  evidence_ref TEXT,
  adapter_version TEXT NOT NULL,
  value_sha256 CHAR(64) NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (review_state IN ('unverified','accepted','conflict','rejected')),
  CHECK (length(field_name) BETWEEN 1 AND 120),
  CHECK (length(provider) BETWEEN 1 AND 80)
);
CREATE INDEX idx_field_obs_lookup ON match_field_observations(match_id,field_name,fetched_at DESC);
CREATE INDEX idx_field_obs_known_at ON match_field_observations(known_at) WHERE known_at IS NOT NULL;

-- Idempotent source-level ingestion; preserve conflicts for review, do not silently overwrite.
CREATE TABLE match_source_snapshots (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_match_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_sha256 CHAR(64) NOT NULL,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_blob_ref TEXT,
  UNIQUE (provider,provider_match_id,payload_sha256)
);
CREATE INDEX idx_match_source_snapshots_match ON match_source_snapshots(match_id,fetched_at DESC);

-- The players table is canonical identity; no merge on similar names.
CREATE TABLE player_alias_history (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to)
);
CREATE INDEX idx_player_alias_search ON player_alias_history(LOWER(alias));

CREATE TABLE player_external_accounts (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  link_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (link_status IN ('provisional','verified','rejected')),
  evidence_ref TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  UNIQUE (provider, external_account_id),
  CHECK (link_status <> 'verified' OR (evidence_ref IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX idx_player_external_accounts_player ON player_external_accounts(player_id,link_status);

-- Player role estimates are temporal observations, never timeless personal attributes.
CREATE TABLE player_role_observations (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id BIGINT REFERENCES teams(id),
  role_pos SMALLINT NOT NULL CHECK (role_pos BETWEEN 1 AND 5),
  observed_for_match_id BIGINT REFERENCES matches(id),
  source TEXT NOT NULL,
  evidence_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  UNIQUE (player_id,observed_for_match_id,source)
);
CREATE INDEX idx_player_role_observed ON player_role_observations(player_id,evidence_at DESC);

-- Announcement/verification time must be tracked independently of roster valid time.
ALTER TABLE team_roster_periods ADD COLUMN known_at TIMESTAMPTZ;

-- Match availability must not be inferred from missing picks; evidence is required for rules.
CREATE TABLE hero_availability_rules (
  id BIGSERIAL PRIMARY KEY,
  hero_id INTEGER NOT NULL REFERENCES heroes(id),
  patch_id BIGINT REFERENCES patches(id),
  league_id BIGINT REFERENCES leagues(id),
  allowed BOOLEAN NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  source TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  known_at TIMESTAMPTZ NOT NULL,
  CHECK (valid_to IS NULL OR valid_from < valid_to)
);
CREATE INDEX idx_hero_availability_lookup
  ON hero_availability_rules(hero_id,patch_id,league_id,valid_from DESC);

-- Keep model scenario versions comparable; Team A/B are never implied Radiant/Dire.
ALTER TABLE scenarios
  ADD COLUMN first_pick_slot CHAR(1) CHECK (first_pick_slot IN ('A','B')),
  ADD COLUMN draft_order_version TEXT,
  ADD COLUMN map_number SMALLINT CHECK (map_number > 0),
  ADD COLUMN team_a_series_wins_before SMALLINT CHECK (team_a_series_wins_before >= 0),
  ADD COLUMN team_b_series_wins_before SMALLINT CHECK (team_b_series_wins_before >= 0),
  ADD COLUMN venue_kind TEXT CHECK (venue_kind IN ('lan','online','hybrid','unknown')),
  ADD COLUMN tournament_stage TEXT,
  ADD COLUMN parent_scenario_id UUID REFERENCES scenarios(id);
CREATE INDEX idx_scenarios_parent ON scenarios(parent_scenario_id)
  WHERE parent_scenario_id IS NOT NULL;

-- Attach actual result AFTER the event, without changing the immutable prediction snapshot.
CREATE TABLE prediction_outcomes (
  prediction_run_id UUID PRIMARY KEY REFERENCES prediction_runs(id) ON DELETE CASCADE,
  match_id BIGINT NOT NULL REFERENCES matches(id),
  team_a_won BOOLEAN NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome_source TEXT NOT NULL,
  linked_by TEXT NOT NULL DEFAULT 'verified_ingestion'
);
CREATE INDEX idx_prediction_outcomes_match ON prediction_outcomes(match_id);

-- Historical prediction snapshots cannot be silently rewritten after they reach a terminal
-- state. Re-running a prediction creates a NEW prediction_runs row/version.
-- Outcome association is stored separately in prediction_outcomes.
CREATE OR REPLACE FUNCTION guard_prediction_terminal_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('done', 'failed', 'unavailable') THEN
    RAISE EXCEPTION 'Terminal prediction % is immutable; create a new prediction run', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_prediction_terminal_snapshot_immutable
  BEFORE UPDATE ON prediction_runs
  FOR EACH ROW EXECUTE FUNCTION guard_prediction_terminal_snapshot();
