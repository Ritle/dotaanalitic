-- Provider observations for the owner-facing future schedule, never canonical map results.
CREATE TABLE upcoming_source_cache (
  cache_key text PRIMARY KEY CHECK (cache_key = 'schedule' OR cache_key ~ '^tournament:[1-9][0-9]{0,18}$'),
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  expires_at timestamptz,
  retry_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid,
  lease_until timestamptz NOT NULL DEFAULT '-infinity',
  failure_code text CHECK (failure_code IS NULL OR failure_code = 'source_unavailable'),
  CHECK ((payload IS NULL) = (expires_at IS NULL)),
  CHECK (octet_length(payload::text) <= 2097152)
);
CREATE TABLE pandascore_request_quota (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  hour_start timestamptz NOT NULL DEFAULT date_trunc('hour', now(), 'UTC'),
  requests_used integer NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
  next_request_at timestamptz NOT NULL DEFAULT '-infinity',
  blocked_until timestamptz NOT NULL DEFAULT '-infinity'
);
