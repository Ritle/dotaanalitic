-- Forward-only patch-awareness metadata extension. Requires 001_initial.sql.
-- No hard-coded game versions; change impact is evidence-backed and nullable.
ALTER TABLE patches
    ADD COLUMN patch_type TEXT NOT NULL DEFAULT 'unknown'
        CHECK (patch_type IN ('major','minor','hotfix','unknown')),
    ADD COLUMN release_source_url TEXT,
    ADD COLUMN source_revision TEXT,
    ADD COLUMN metadata_updated_at TIMESTAMPTZ;

CREATE TABLE patch_hero_impacts (
    patch_id BIGINT NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
    hero_id INTEGER NOT NULL REFERENCES heroes(id) ON DELETE CASCADE,
    impact_level TEXT NOT NULL CHECK (impact_level IN ('minor','moderate','major','rework')),
    source_url TEXT NOT NULL,
    notes TEXT,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (patch_id, hero_id)
);
CREATE INDEX idx_patch_hero_impacts_hero_patch
    ON patch_hero_impacts(hero_id,patch_id);
