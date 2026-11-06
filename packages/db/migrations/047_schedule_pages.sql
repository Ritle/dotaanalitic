-- Additional descriptive schedule pages. Frozen V1 page-one evidence stays unchanged.
CREATE TABLE upcoming_page_cache (
  page integer PRIMARY KEY CHECK (page BETWEEN 2 AND 50),
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  expires_at timestamptz,
  retry_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid,
  lease_until timestamptz NOT NULL DEFAULT '-infinity',
  failure_code text CHECK (failure_code IS NULL OR failure_code = 'source_unavailable'),
  CHECK ((payload IS NULL) = (expires_at IS NULL)),
  CHECK (octet_length(payload::text) <= 2097152)
);
CREATE TABLE upcoming_page_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page integer NOT NULL CHECK (page BETWEEN 2 AND 50),
  source_endpoint text NOT NULL,
  source_payload_sha256 char(64) NOT NULL CHECK (source_payload_sha256 ~ '^[0-9a-f]{64}$'),
  source_fetched_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_text text NOT NULL CHECK (octet_length(snapshot_text) BETWEEN 2 AND 2097152),
  CHECK (source_fetched_at <= recorded_at),
  CHECK (source_endpoint = '/dota2/matches/upcoming?sort=scheduled_at,id&page=' || page::text || '&per_page=20')
);
CREATE INDEX idx_upcoming_page_observations_page ON upcoming_page_observations(page,recorded_at,id);
CREATE TRIGGER trg_upcoming_page_observations_immutable BEFORE UPDATE OR DELETE ON upcoming_page_observations
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
