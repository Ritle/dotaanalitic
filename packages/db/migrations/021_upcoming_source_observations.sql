-- Preserve what the owner-facing provider returned at refresh time. These are
-- source observations, not verified map lineups, canonical identities or labels.
CREATE TABLE upcoming_source_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cache_key text NOT NULL CHECK (cache_key = 'schedule' OR cache_key ~ '^tournament:[1-9][0-9]{0,18}$'),
  provider text NOT NULL CHECK (provider = 'pandascore'),
  source_endpoint text NOT NULL,
  source_payload_sha256 char(64) NOT NULL CHECK (source_payload_sha256 ~ '^[0-9a-f]{64}$'),
  source_fetched_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_text text NOT NULL CHECK (octet_length(snapshot_text) BETWEEN 2 AND 2097152),
  CHECK (source_fetched_at <= recorded_at),
  CHECK (cache_key = 'schedule' AND source_endpoint = '/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20'
    OR cache_key <> 'schedule' AND source_endpoint = '/tournaments/' || substring(cache_key from 12) || '/rosters')
);
CREATE INDEX idx_upcoming_source_observations_lookup ON upcoming_source_observations(cache_key,recorded_at,id);
CREATE TRIGGER trg_upcoming_source_observations_immutable BEFORE UPDATE OR DELETE ON upcoming_source_observations
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
