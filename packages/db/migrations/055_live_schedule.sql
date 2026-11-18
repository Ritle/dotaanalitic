-- Descriptive running-series cache only. Never a canonical result or training label.
CREATE TABLE live_schedule_cache (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  expires_at timestamptz,
  retry_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid,
  lease_until timestamptz NOT NULL DEFAULT '-infinity',
  failure_code text CHECK (failure_code IS NULL OR failure_code = 'source_unavailable'),
  CHECK ((payload IS NULL) = (expires_at IS NULL)),
  CHECK (octet_length(payload::text) <= 2097152)
);
