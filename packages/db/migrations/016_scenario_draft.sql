-- Unordered final hero assignments/bans. No invented timeline or legacy snapshot rewrite.
ALTER TABLE scenarios ADD COLUMN league_id BIGINT REFERENCES leagues(id);
ALTER TABLE scenario_input_snapshots ADD COLUMN draft_assessment JSONB
  CHECK (draft_assessment IS NULL OR jsonb_typeof(draft_assessment)='object');
CREATE TABLE scenario_bans (
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  team_slot CHAR(1) NOT NULL CHECK (team_slot IN ('A','B')),
  hero_id INTEGER NOT NULL REFERENCES heroes(id),
  PRIMARY KEY(scenario_id,hero_id)
);
