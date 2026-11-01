-- Owner-triggered bounded organization history refresh. No training automation.
CREATE TABLE history_refresh_runs (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app_users(id),
  team_id bigint NOT NULL REFERENCES teams(id),
  provider_team_id bigint NOT NULL CHECK (provider_team_id > 0),
  status text NOT NULL CHECK (status IN ('queued','running','completed','partial','error')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  next_allowed_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
  lease_token uuid,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  selected integer CHECK (selected BETWEEN 0 AND 10),
  processed integer NOT NULL DEFAULT 0 CHECK (processed BETWEEN 0 AND 10),
  accepted integer NOT NULL DEFAULT 0 CHECK (accepted BETWEEN 0 AND 10),
  duplicates integer NOT NULL DEFAULT 0 CHECK (duplicates BETWEEN 0 AND 10),
  excluded integer NOT NULL DEFAULT 0 CHECK (excluded BETWEEN 0 AND 10),
  source_errors integer NOT NULL DEFAULT 0 CHECK (source_errors BETWEEN 0 AND 10),
  conflicts integer NOT NULL DEFAULT 0 CHECK (conflicts BETWEEN 0 AND 10),
  source_fetched_at timestamptz,
  error_code text CHECK (error_code IN ('source_unavailable','import_failed','worker_unavailable')),
  audits jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(audits) = 'array' AND jsonb_array_length(audits) <= 3),
  CHECK (octet_length(audits::text) <= 131072),
  CHECK (accepted <= processed AND duplicates <= processed AND conflicts <= processed),
  CHECK (selected IS NULL OR processed <= selected),
  CHECK ((status IN ('completed','partial','error')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX history_refresh_one_active_team ON history_refresh_runs(team_id) WHERE status IN ('queued','running');
CREATE INDEX history_refresh_latest ON history_refresh_runs(owner_user_id,team_id,created_at DESC);
