-- Extend the typed whitelist, without modifying any historical observation or SQL file.
ALTER TABLE match_field_observations DROP CONSTRAINT ck_context_evidence;
ALTER TABLE match_field_observations ADD CONSTRAINT ck_context_evidence CHECK (context_sha256 IS NULL OR (
  field_name IN ('context.series_id','context.map_number','context.series_score_before','context.teams',
    'context.first_pick_side','context.draft_order_version','context.lineup','context.roles','context.heroes',
    'context.league_id','context.game_mode','context.lobby_type')
  AND (known_at IS NULL OR known_at <= fetched_at) AND (event_at IS NULL OR event_at <= fetched_at)
  AND fetched_at = date_trunc('milliseconds',fetched_at)
  AND (known_at IS NULL OR known_at = date_trunc('milliseconds',known_at))
  AND (event_at IS NULL OR event_at = date_trunc('milliseconds',event_at))
  AND (availability_class <> 'verified_asof' OR
    (known_at IS NOT NULL AND evidence_ref IS NOT NULL AND length(btrim(evidence_ref)) > 0))
  AND (field_name NOT IN ('context.heroes','context.first_pick_side','context.draft_order_version') OR earliest_stage <> 'pre_match')
));

CREATE TABLE patch_release_evidence (
  id BIGSERIAL PRIMARY KEY,
  patch_id BIGINT NOT NULL REFERENCES patches(id),
  released_at TIMESTAMPTZ NOT NULL,
  coverage_until TIMESTAMPTZ NOT NULL CHECK (released_at < coverage_until),
  event_at TIMESTAMPTZ,
  known_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 512),
  evidence_ref TEXT NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 512),
  review_state TEXT NOT NULL CHECK (review_state IN ('accepted','unverified','conflict','rejected')),
  evidence_sha256 CHAR(64) NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (known_at <= fetched_at AND coverage_until <= fetched_at),
  CHECK (event_at IS NULL OR event_at <= fetched_at),
  CHECK (released_at = date_trunc('milliseconds',released_at) AND coverage_until = date_trunc('milliseconds',coverage_until)
    AND known_at = date_trunc('milliseconds',known_at) AND fetched_at = date_trunc('milliseconds',fetched_at)
    AND (event_at IS NULL OR event_at = date_trunc('milliseconds',event_at)))
);
CREATE INDEX idx_patch_evidence_time ON patch_release_evidence(released_at,known_at);

-- Identifies the historically applicable ruleset, NOT validation of a map's raw timeline.
CREATE TABLE draft_rule_evidence (
  id BIGSERIAL PRIMARY KEY,
  patch_id BIGINT NOT NULL REFERENCES patches(id),
  game_mode SMALLINT NOT NULL CHECK (game_mode >= 0),
  lobby_type SMALLINT NOT NULL CHECK (lobby_type >= 0),
  rule_version TEXT NOT NULL CHECK (length(btrim(rule_version)) BETWEEN 1 AND 512),
  event_at TIMESTAMPTZ,
  known_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 512),
  evidence_ref TEXT NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 512),
  review_state TEXT NOT NULL CHECK (review_state IN ('accepted','unverified','conflict','rejected')),
  evidence_sha256 CHAR(64) NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (known_at <= fetched_at AND (event_at IS NULL OR event_at <= fetched_at)),
  CHECK (known_at = date_trunc('milliseconds',known_at) AND fetched_at = date_trunc('milliseconds',fetched_at)
    AND (event_at IS NULL OR event_at = date_trunc('milliseconds',event_at)))
);
CREATE INDEX idx_draft_rule_lookup ON draft_rule_evidence(patch_id,game_mode,lobby_type,known_at);

ALTER TABLE hero_availability_rules
  ADD COLUMN event_at TIMESTAMPTZ,
  ADD COLUMN fetched_at TIMESTAMPTZ,
  ADD COLUMN review_state TEXT NOT NULL DEFAULT 'unverified' CHECK (review_state IN ('accepted','unverified','conflict','rejected')),
  ADD COLUMN evidence_sha256 CHAR(64) UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_hero_rule_evidence CHECK (evidence_sha256 IS NULL OR (
    fetched_at IS NOT NULL AND known_at <= fetched_at AND (event_at IS NULL OR event_at <= fetched_at)
    AND length(btrim(source)) BETWEEN 1 AND 512 AND length(btrim(evidence_ref)) BETWEEN 1 AND 512
    AND known_at = date_trunc('milliseconds',known_at) AND fetched_at = date_trunc('milliseconds',fetched_at)
    AND valid_from = date_trunc('milliseconds',valid_from)
    AND (valid_to IS NULL OR valid_to = date_trunc('milliseconds',valid_to))
    AND (event_at IS NULL OR event_at = date_trunc('milliseconds',event_at))
  ));
CREATE TRIGGER trg_patch_evidence_immutable BEFORE UPDATE OR DELETE ON patch_release_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_draft_rule_immutable BEFORE UPDATE OR DELETE ON draft_rule_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_hero_rule_immutable BEFORE UPDATE OR DELETE ON hero_availability_rules
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();

CREATE TABLE game_context_registry_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO game_context_registry_state(singleton) VALUES (TRUE);
CREATE FUNCTION bump_game_context_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE game_context_registry_state SET revision=revision+1 WHERE singleton=TRUE;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_patch_registry_revision AFTER INSERT ON patch_release_evidence
  FOR EACH ROW EXECUTE FUNCTION bump_game_context_revision();
CREATE TRIGGER trg_draft_registry_revision AFTER INSERT ON draft_rule_evidence
  FOR EACH ROW EXECUTE FUNCTION bump_game_context_revision();
CREATE TRIGGER trg_hero_registry_revision AFTER INSERT ON hero_availability_rules
  FOR EACH ROW EXECUTE FUNCTION bump_game_context_revision();
-- No real patch dates, draft versions or hero eligibility are seeded without evidence.
