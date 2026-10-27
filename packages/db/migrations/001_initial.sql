-- Dota 2 Pro Analytics Personal MVP v2 — PostgreSQL schema
-- PostgreSQL 15+; intended as a reviewed baseline migration, not a complete ORM implementation.
-- All times in UTC (TIMESTAMPTZ). Pro-only analytics require matches.is_pro IS TRUE.
-- Single personal owner account is created by CLI after migrations, never seeded with a password.

BEGIN;

-- Personal owner account (multi-owner-ready schema, but no public registration).
CREATE TABLE app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (length(login) BETWEEN 3 AND 120),
    CHECK (length(password_hash) >= 30)
);

-- Only SHA-256 (or stronger) digests of opaque session tokens are stored.
CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);
CREATE INDEX idx_auth_sessions_user_expires ON auth_sessions(user_id,expires_at DESC);
CREATE INDEX idx_auth_sessions_active ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE heroes (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    internal_name TEXT NOT NULL UNIQUE,
    localized_name TEXT NOT NULL,
    primary_attr TEXT,
    roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE patches (
    id BIGSERIAL PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    released_at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL DEFAULT 'dotaconstants',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_patches_release ON patches(released_at DESC);

CREATE TABLE teams (
    id BIGSERIAL PRIMARY KEY,
    opendota_team_id BIGINT UNIQUE,
    name TEXT NOT NULL,
    tag TEXT,
    logo_url TEXT,
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_teams_name_lower ON teams(LOWER(name));
CREATE INDEX idx_teams_tag_lower ON teams(LOWER(tag));

CREATE TABLE players (
    id BIGSERIAL PRIMARY KEY,
    -- OpenDota account_id is Steam32. Steam64 is stored as TEXT to avoid JS precision loss.
    opendota_account_id BIGINT UNIQUE CHECK (opendota_account_id BETWEEN 0 AND 4294967295),
    steam64_id TEXT UNIQUE,
    nickname TEXT NOT NULL,
    real_name TEXT,
    avatar_url TEXT,
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_players_nickname_lower ON players(LOWER(nickname));

CREATE TABLE leagues (
    id BIGSERIAL PRIMARY KEY,
    opendota_league_id BIGINT UNIQUE,
    name TEXT NOT NULL,
    tier TEXT,
    synced_at TIMESTAMPTZ
);

-- A series (BO1/BO2/BO3/BO5) consists of 1+ Dota maps. A map is one match_id.
CREATE TABLE series (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league_id BIGINT REFERENCES leagues(id),
    team_a_id BIGINT NOT NULL REFERENCES teams(id),
    team_b_id BIGINT NOT NULL REFERENCES teams(id),
    scheduled_at TIMESTAMPTZ,
    best_of SMALLINT NOT NULL DEFAULT 3 CHECK (best_of IN (1, 2, 3, 5)),
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','live','completed','cancelled')),
    provider TEXT NOT NULL DEFAULT 'manual',
    provider_series_id TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (team_a_id <> team_b_id)
);
CREATE INDEX idx_series_teams_time ON series(team_a_id,team_b_id,scheduled_at DESC);

-- Roster membership is temporally qualified; API current-member flags are NOT official confirmations.
CREATE TABLE team_roster_periods (
    id BIGSERIAL PRIMARY KEY,
    team_id BIGINT NOT NULL REFERENCES teams(id),
    player_id BIGINT NOT NULL REFERENCES players(id),
    role_pos SMALLINT CHECK (role_pos BETWEEN 1 AND 5),
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    source TEXT NOT NULL CHECK (source IN ('opendota','stratz','manual','match_observed')),
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to)
);
CREATE INDEX idx_rosters_team_time ON team_roster_periods(team_id,observed_at DESC);
CREATE INDEX idx_rosters_player_time ON team_roster_periods(player_id,observed_at DESC);

CREATE TABLE matches (
    id BIGINT PRIMARY KEY CHECK (id > 0), -- canonical Dota match_id
    series_id UUID REFERENCES series(id),
    league_id BIGINT REFERENCES leagues(id),
    radiant_team_id BIGINT REFERENCES teams(id),
    dire_team_id BIGINT REFERENCES teams(id),
    patch_id BIGINT REFERENCES patches(id),
    started_at TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER CHECK (duration_seconds >= 0),
    radiant_win BOOLEAN,
    radiant_score SMALLINT CHECK (radiant_score >= 0),
    dire_score SMALLINT CHECK (dire_score >= 0),
    -- NULL = unclassified, FALSE = classified non-pro, TRUE = confirmed pro.
    is_pro BOOLEAN,
    detail_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (detail_status IN ('pending','partial','complete','unavailable')),
    draft_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (draft_status IN ('pending','partial','complete','unavailable')),
    source TEXT NOT NULL DEFAULT 'opendota',
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (radiant_team_id IS NULL OR dire_team_id IS NULL OR radiant_team_id <> dire_team_id)
);
CREATE INDEX idx_matches_pro_time ON matches(started_at DESC, id DESC) WHERE is_pro IS TRUE;
CREATE INDEX idx_matches_patch_time ON matches(patch_id,started_at DESC) WHERE is_pro IS TRUE;
CREATE INDEX idx_matches_radiant_time ON matches(radiant_team_id,started_at DESC);
CREATE INDEX idx_matches_dire_time ON matches(dire_team_id,started_at DESC);
CREATE INDEX idx_matches_league_time ON matches(league_id,started_at DESC);
CREATE INDEX idx_matches_series ON matches(series_id);

-- The player_slot is the native OpenDota value (Radiant 0..4, Dire 128..132).
CREATE TABLE match_players (
    match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    player_slot SMALLINT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('radiant','dire')),
    player_id BIGINT REFERENCES players(id), -- anonymous/unresolved pro participant is allowed
    team_id BIGINT REFERENCES teams(id),
    hero_id INTEGER NOT NULL REFERENCES heroes(id),
    player_name_snapshot TEXT,
    kills SMALLINT CHECK (kills >= 0),
    deaths SMALLINT CHECK (deaths >= 0),
    assists SMALLINT CHECK (assists >= 0),
    gpm INTEGER CHECK (gpm >= 0),
    xpm INTEGER CHECK (xpm >= 0),
    hero_damage INTEGER CHECK (hero_damage >= 0),
    tower_damage INTEGER CHECK (tower_damage >= 0),
    last_hits INTEGER CHECK (last_hits >= 0),
    denies INTEGER CHECK (denies >= 0),
    net_worth INTEGER CHECK (net_worth >= 0),
    inferred_role_pos SMALLINT CHECK (inferred_role_pos BETWEEN 1 AND 5),
    role_confidence REAL CHECK (role_confidence BETWEEN 0 AND 1),
    PRIMARY KEY (match_id,player_slot),
    CHECK (
        (side = 'radiant' AND player_slot BETWEEN 0 AND 4)
        OR (side = 'dire' AND player_slot BETWEEN 128 AND 132)
    )
);
CREATE UNIQUE INDEX uq_match_player_identity ON match_players(match_id,player_id)
    WHERE player_id IS NOT NULL;
CREATE INDEX idx_matchplayers_player_hero ON match_players(player_id,hero_id,match_id);
CREATE INDEX idx_matchplayers_hero_side ON match_players(hero_id,side,match_id);
CREATE INDEX idx_matchplayers_team ON match_players(team_id,match_id);

CREATE TABLE match_draft_actions (
    match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    action_order SMALLINT NOT NULL CHECK (action_order >= 0),
    action TEXT NOT NULL CHECK (action IN ('pick','ban')),
    side TEXT NOT NULL CHECK (side IN ('radiant','dire')),
    hero_id INTEGER NOT NULL REFERENCES heroes(id),
    team_id BIGINT REFERENCES teams(id),
    PRIMARY KEY (match_id,action_order),
    UNIQUE (match_id,hero_id)
);
CREATE INDEX idx_matchdraft_hero_action ON match_draft_actions(hero_id,action,match_id);

-- A scenario is a hypothetical single-map analysis; it can reference a planned series.
-- Team labels A/B are UI slots, not Radiant/Dire.
CREATE TABLE scenarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES app_users(id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    series_id UUID REFERENCES series(id),
    team_a_id BIGINT NOT NULL REFERENCES teams(id),
    team_b_id BIGINT NOT NULL REFERENCES teams(id),
    title TEXT,
    scheduled_at TIMESTAMPTZ,
    cutoff_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    radiant_slot CHAR(1) CHECK (radiant_slot IN ('A','B')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (team_a_id <> team_b_id)
);
CREATE INDEX idx_scenarios_created ON scenarios(created_at DESC);
CREATE INDEX idx_scenarios_owner_created ON scenarios(owner_user_id,created_at DESC);

CREATE TABLE scenario_lineup (
    scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    team_slot CHAR(1) NOT NULL CHECK (team_slot IN ('A','B')),
    role_pos SMALLINT NOT NULL CHECK (role_pos BETWEEN 1 AND 5),
    player_id BIGINT REFERENCES players(id),
    hero_id INTEGER REFERENCES heroes(id),
    is_standin BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (scenario_id,team_slot,role_pos),
    UNIQUE (scenario_id,player_id),
    UNIQUE (scenario_id,hero_id)
);
CREATE INDEX idx_scenario_lineup_player ON scenario_lineup(player_id);

-- Ordered current draft actions, not immutable edit history. On update replace the sequence atomically.
CREATE TABLE scenario_draft_actions (
    scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    sequence_no SMALLINT NOT NULL CHECK (sequence_no >= 0),
    team_slot CHAR(1) NOT NULL CHECK (team_slot IN ('A','B')),
    action TEXT NOT NULL CHECK (action IN ('pick','ban')),
    hero_id INTEGER NOT NULL REFERENCES heroes(id),
    PRIMARY KEY (scenario_id,sequence_no),
    UNIQUE (scenario_id,hero_id)
);

CREATE TABLE analysis_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    input_hash CHAR(64) NOT NULL,
    data_revision TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','done','failed')),
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message TEXT,
    computed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_analysis_scenario_created ON analysis_runs(scenario_id,created_at DESC);
CREATE INDEX idx_analysis_lookup ON analysis_runs(scenario_id,input_hash,data_revision,algorithm_version,status);


-- Versioned offline-trained prediction models; quality check happens before is_active=true.
CREATE TABLE prediction_model_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stage TEXT NOT NULL CHECK (stage IN ('pre_match','post_draft')),
    version TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    feature_schema_version TEXT NOT NULL,
    artifact_uri TEXT NOT NULL, -- trusted local path/object URI, NEVER untrusted URL execution
    trained_at TIMESTAMPTZ NOT NULL,
    training_cutoff TIMESTAMPTZ NOT NULL,
    train_start_at TIMESTAMPTZ,
    train_end_at TIMESTAMPTZ,
    test_start_at TIMESTAMPTZ,
    test_end_at TIMESTAMPTZ,
    train_games INTEGER NOT NULL DEFAULT 0 CHECK (train_games >= 0),
    test_games INTEGER NOT NULL DEFAULT 0 CHECK (test_games >= 0),
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    hyperparameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    dataset_fingerprint CHAR(64),
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (stage,version),
    CHECK (test_end_at IS NULL OR test_start_at IS NULL OR test_start_at < test_end_at)
);
CREATE UNIQUE INDEX uq_active_model_per_stage ON prediction_model_versions(stage)
    WHERE is_active IS TRUE;

-- Predictions are immutable snapshots. Application must not UPDATE a completed prediction.
CREATE TABLE prediction_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    scenario_revision INTEGER NOT NULL CHECK (scenario_revision >= 1),
    stage TEXT NOT NULL CHECK (stage IN ('pre_match','post_draft')),
    model_version_id UUID REFERENCES prediction_model_versions(id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','done','failed','unavailable')),
    cutoff_at TIMESTAMPTZ NOT NULL,
    input_hash CHAR(64) NOT NULL,
    data_revision TEXT NOT NULL,
    input_snapshot JSONB NOT NULL,
    feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
    quality JSONB NOT NULL DEFAULT '{}'::jsonb,
    explanations JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    team_a_win_probability NUMERIC(5,4) CHECK (team_a_win_probability BETWEEN 0 AND 1),
    error_code TEXT,
    computed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status <> 'unavailable' OR team_a_win_probability IS NULL),
    CHECK (status <> 'done' OR (team_a_win_probability IS NOT NULL AND model_version_id IS NOT NULL))
);
CREATE INDEX idx_predictions_scenario_time ON prediction_runs(scenario_id,created_at DESC);
CREATE INDEX idx_predictions_model_time ON prediction_runs(model_version_id,created_at DESC);
CREATE INDEX idx_predictions_dedupe ON prediction_runs(scenario_id,stage,input_hash,data_revision,status);

CREATE TABLE sync_jobs (
    id BIGSERIAL PRIMARY KEY,
    job_type TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','succeeded','failed','retrying')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    next_attempt_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sync_jobs_dispatch ON sync_jobs(status,next_attempt_at,created_at);

COMMIT;

-- Example query: professional hero synergy for HERO_1 and HERO_2 by exact same-side maps.
-- Params: $1 = hero_id_1, $2 = hero_id_2, $3 = cutoff_at, $4 = patch_id (or NULL).
-- This query counts each real map once; if hero order is swapped, the result is the same.
-- SELECT COUNT(*) AS games,
--        COUNT(*) FILTER (WHERE (p1.side = 'radiant') = m.radiant_win) AS wins
-- FROM matches m
-- JOIN match_players p1 ON p1.match_id = m.id AND p1.hero_id = $1
-- JOIN match_players p2 ON p2.match_id = m.id AND p2.hero_id = $2
-- WHERE m.is_pro IS TRUE
--   AND m.detail_status = 'complete'
--   AND m.radiant_win IS NOT NULL
--   AND p1.side = p2.side
--   AND m.started_at < $3
--   AND ($4::BIGINT IS NULL OR m.patch_id = $4);
-- Note: enforce $1<>$2 in the analytics domain layer.
