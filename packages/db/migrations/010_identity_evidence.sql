-- Identity proofs are append-only; canonical people are NEVER merged on a nickname.
CREATE TABLE player_account_evidence (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id),
  provider TEXT NOT NULL CHECK (provider IN ('opendota','stratz')),
  external_account_id TEXT NOT NULL CHECK (external_account_id ~ '^[1-9][0-9]{0,9}$'
    AND external_account_id::numeric <= 4294967295),
  link_status TEXT NOT NULL CHECK (link_status IN ('provisional','verified','rejected')),
  source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 512),
  evidence_ref TEXT CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 512),
  event_at TIMESTAMPTZ,
  known_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (link_status <> 'verified' OR evidence_ref IS NOT NULL),
  CHECK (known_at IS NULL OR known_at <= fetched_at),
  CHECK (event_at IS NULL OR event_at <= fetched_at),
  CHECK (fetched_at = date_trunc('milliseconds',fetched_at)),
  CHECK (known_at IS NULL OR known_at = date_trunc('milliseconds',known_at)),
  CHECK (event_at IS NULL OR event_at = date_trunc('milliseconds',event_at))
);
CREATE INDEX idx_account_evidence_lookup ON player_account_evidence(external_account_id,known_at);
CREATE INDEX idx_account_evidence_player ON player_account_evidence(player_id);
CREATE TRIGGER trg_account_evidence_immutable BEFORE UPDATE OR DELETE ON player_account_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();

-- Preserve legacy aliases without inventing their historical availability.
ALTER TABLE player_alias_history
  ADD COLUMN event_at TIMESTAMPTZ,
  ADD COLUMN known_at TIMESTAMPTZ,
  ADD COLUMN evidence_ref TEXT,
  ADD COLUMN evidence_sha256 CHAR(64) UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_alias_evidence CHECK (evidence_sha256 IS NULL OR (
    length(btrim(alias)) BETWEEN 1 AND 120 AND length(btrim(source)) BETWEEN 1 AND 512
    AND (known_at IS NULL OR (known_at <= observed_at AND evidence_ref IS NOT NULL AND length(btrim(evidence_ref)) > 0))
    AND (event_at IS NULL OR event_at <= observed_at)
    AND observed_at = date_trunc('milliseconds',observed_at)
    AND (known_at IS NULL OR known_at = date_trunc('milliseconds',known_at))
    AND (event_at IS NULL OR event_at = date_trunc('milliseconds',event_at))
  ));
CREATE TRIGGER trg_alias_history_immutable BEFORE UPDATE OR DELETE ON player_alias_history
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();

-- Identity changes invalidate derived readers without rewriting frozen predictions/maps.
CREATE TABLE identity_registry_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO identity_registry_state(singleton) VALUES (TRUE);
CREATE FUNCTION bump_identity_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE identity_registry_state SET revision=revision+1 WHERE singleton=TRUE;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_identity_revision AFTER INSERT ON player_account_evidence
  FOR EACH ROW EXECUTE FUNCTION bump_identity_revision();
CREATE TRIGGER trg_alias_revision AFTER INSERT ON player_alias_history
  FOR EACH ROW EXECUTE FUNCTION bump_identity_revision();
CREATE TRIGGER trg_legacy_identity_revision AFTER INSERT OR UPDATE OR DELETE ON player_external_accounts
  FOR EACH ROW EXECUTE FUNCTION bump_identity_revision();
-- Legacy current links remain readable for descriptive import only. No known_at backfill.
