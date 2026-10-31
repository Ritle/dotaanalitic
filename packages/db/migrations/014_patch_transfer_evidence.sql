-- Legacy mutable patch_hero_impacts do not become historical evidence.
CREATE TABLE patch_transition_evidence (
  id BIGSERIAL PRIMARY KEY,
  from_patch_id BIGINT NOT NULL REFERENCES patches(id),
  patch_id BIGINT NOT NULL REFERENCES patches(id),
  change_level TEXT NOT NULL CHECK (change_level IN ('minor','moderate','major')),
  event_at TIMESTAMPTZ NOT NULL,
  known_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 512),
  evidence_ref TEXT NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 512),
  review_state TEXT NOT NULL CHECK (review_state IN ('accepted','unverified','conflict','rejected')),
  evidence_sha256 CHAR(64) NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (from_patch_id <> patch_id AND event_at <= fetched_at AND known_at <= fetched_at),
  CHECK (event_at=date_trunc('milliseconds',event_at) AND known_at=date_trunc('milliseconds',known_at) AND fetched_at=date_trunc('milliseconds',fetched_at))
);
CREATE TABLE hero_impact_evidence (
  id BIGSERIAL PRIMARY KEY,
  patch_id BIGINT NOT NULL REFERENCES patches(id),
  hero_id INTEGER NOT NULL REFERENCES heroes(id),
  impact_level TEXT NOT NULL CHECK (impact_level IN ('unchanged','minor','moderate','major','rework')),
  event_at TIMESTAMPTZ NOT NULL,
  known_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 512),
  evidence_ref TEXT NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 512),
  review_state TEXT NOT NULL CHECK (review_state IN ('accepted','unverified','conflict','rejected')),
  evidence_sha256 CHAR(64) NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (event_at <= fetched_at AND known_at <= fetched_at),
  CHECK (event_at=date_trunc('milliseconds',event_at) AND known_at=date_trunc('milliseconds',known_at) AND fetched_at=date_trunc('milliseconds',fetched_at))
);
CREATE INDEX idx_patch_transfer_lookup ON patch_transition_evidence(patch_id,known_at);
CREATE INDEX idx_hero_impact_lookup ON hero_impact_evidence(patch_id,hero_id,known_at);
CREATE TRIGGER trg_patch_transfer_immutable BEFORE UPDATE OR DELETE ON patch_transition_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_hero_impact_immutable BEFORE UPDATE OR DELETE ON hero_impact_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_patch_transfer_revision AFTER INSERT ON patch_transition_evidence
  FOR EACH ROW EXECUTE FUNCTION bump_game_context_revision();
CREATE TRIGGER trg_hero_impact_revision AFTER INSERT ON hero_impact_evidence
  FOR EACH ROW EXECUTE FUNCTION bump_game_context_revision();
-- No real metadata or validated coefficients seeded.
