-- Additive ingestion evidence and shared quotas. pg-boss owns a separate schema.
ALTER TABLE matches
  ADD COLUMN data_revision BIGINT NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
  ADD COLUMN ingest_state TEXT NOT NULL DEFAULT 'partial'
    CHECK (ingest_state IN ('partial','accepted','conflict'));
ALTER TABLE match_players ADD COLUMN source_account_id BIGINT
  CHECK (source_account_id > 0 AND source_account_id <= 4294967295);

-- Retain a minimal replayable source projection, not chat, avatars or credentials.
-- Receipts without a canonical map can quarantine invalid/missing start times.
CREATE TABLE provider_ingest_receipts (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_match_id TEXT NOT NULL CHECK (provider_match_id ~ '^[1-9][0-9]*$'),
  canonical_match_id BIGINT REFERENCES matches(id),
  adapter_version TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  context_sha256 CHAR(64) NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at TIMESTAMPTZ NOT NULL,
  event_at TIMESTAMPTZ,
  known_at TIMESTAMPTZ,
  source_payload JSONB NOT NULL CHECK (jsonb_typeof(source_payload)='object'),
  status TEXT NOT NULL CHECK (status IN ('received','accepted','partial','conflict','quarantined')),
  reasons JSONB NOT NULL CHECK (jsonb_typeof(reasons)='array'),
  UNIQUE(provider,provider_match_id,payload_sha256,adapter_version,normalizer_version,context_sha256)
);
CREATE INDEX idx_ingest_receipts_map ON provider_ingest_receipts(provider_match_id,fetched_at DESC);
ALTER TABLE match_field_observations ADD COLUMN receipt_id BIGINT REFERENCES provider_ingest_receipts(id);
CREATE UNIQUE INDEX uq_field_observation_receipt ON match_field_observations(receipt_id,field_name)
  WHERE receipt_id IS NOT NULL;

CREATE TABLE provider_reference_snapshots (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at TIMESTAMPTZ NOT NULL,
  source_payload JSONB NOT NULL,
  UNIQUE(provider,endpoint,payload_sha256)
);

CREATE FUNCTION guard_ingest_evidence_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable ingestion evidence: insert a new revision';
END;
$$;
CREATE TRIGGER trg_ingest_receipt_immutable BEFORE UPDATE OR DELETE ON provider_ingest_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_reference_snapshot_immutable BEFORE UPDATE OR DELETE ON provider_reference_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_source_snapshot_immutable BEFORE UPDATE OR DELETE ON match_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_field_observation_immutable BEFORE UPDATE OR DELETE ON match_field_observations
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();

CREATE TABLE provider_quotas (
  provider TEXT PRIMARY KEY,
  next_request_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  blocked_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  minute_start TIMESTAMPTZ NOT NULL,
  day_start TIMESTAMPTZ NOT NULL,
  month_start TIMESTAMPTZ NOT NULL,
  minute_used INTEGER NOT NULL DEFAULT 0 CHECK (minute_used >= 0),
  day_used INTEGER NOT NULL DEFAULT 0 CHECK (day_used >= 0),
  month_used INTEGER NOT NULL DEFAULT 0 CHECK (month_used >= 0)
);
