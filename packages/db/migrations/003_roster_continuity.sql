-- Optional expected five for a scenario, separate from the actual/selected scenario_lineup.
-- Forward-only: DO NOT rewrite 001/002 if already applied.
-- Player IDs refer to canonical player identities, NOT team membership rows.
CREATE TABLE scenario_expected_lineup (
    scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    team_slot CHAR(1) NOT NULL CHECK (team_slot IN ('A','B')),
    role_pos SMALLINT NOT NULL CHECK (role_pos BETWEEN 1 AND 5),
    player_id BIGINT REFERENCES players(id),
    source_kind TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual','observed_suggestion')),
    confirmed_by_owner BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at TIMESTAMPTZ,
    observed_at TIMESTAMPTZ,
    PRIMARY KEY (scenario_id, team_slot, role_pos),
    UNIQUE (scenario_id, player_id),
    CHECK (confirmed_at IS NULL OR confirmed_by_owner),
    CHECK (source_kind <> 'observed_suggestion' OR observed_at IS NOT NULL)
);
CREATE INDEX idx_expected_lineup_player ON scenario_expected_lineup(player_id);

-- The actual lineup remains scenario_lineup; is_standin is a user-declared status,
-- NOT a penalty coefficient. Derived overlap/change can be computed on demand.
-- Keep true map participants as match_players; NEVER backfill maps with roster flags.
