-- Selected player histories are independent of organization identity. SQL 001-040 remain unchanged.
CREATE TABLE player_history_runs (
 id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 lineup_key text NOT NULL CHECK (lineup_key ~ '^[a-f0-9]{64}$'),
 bindings jsonb NOT NULL CHECK (jsonb_typeof(bindings)='array' AND jsonb_array_length(bindings)=5),
 status text NOT NULL CHECK (status IN ('queued','running','completed','partial','error')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 next_allowed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
 lease_token uuid,
 report jsonb,
 source_audit jsonb,
 error_code text CHECK (error_code IN ('source_unavailable','import_failed','identity_changed','worker_unavailable'))
);
CREATE UNIQUE INDEX player_history_one_active ON player_history_runs(lineup_key) WHERE status IN ('queued','running');
CREATE INDEX player_history_latest ON player_history_runs(owner_user_id,lineup_key,created_at DESC);
