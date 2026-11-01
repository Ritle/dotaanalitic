-- Registration can establish grouping without proving that a series has ended.
-- Preserve the legacy default; the reviewed provisioner explicitly inserts NULL.
ALTER TABLE series ALTER COLUMN status DROP NOT NULL;

CREATE TABLE series_provision_batches (
  plan_sha256 char(64) PRIMARY KEY CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  known_at timestamptz CHECK (known_at IS NULL),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_series_provision_batches_immutable BEFORE UPDATE OR DELETE ON series_provision_batches
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
