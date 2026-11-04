-- Current descriptive role hints only. No changes to historical identities, roles or Elo.
CREATE TABLE role_profile_bindings (
  owner_user_id uuid NOT NULL REFERENCES app_users(id), request_id uuid NOT NULL,
  team_id bigint NOT NULL REFERENCES teams(id), revision integer NOT NULL CHECK (revision>0),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding)='object' AND octet_length(binding::text)<16384),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_user_id,request_id), UNIQUE(owner_user_id,team_id,revision)
);
CREATE FUNCTION role_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'role_binding_immutable'; END $$;
CREATE TRIGGER role_binding_immutable BEFORE UPDATE OR DELETE ON role_profile_bindings
  FOR EACH ROW EXECUTE FUNCTION role_binding_immutable();
CREATE TABLE role_profile_cache (
  source_key text PRIMARY KEY CHECK (source_key ~ '^(stratz:player|pandascore:roster):[1-9][0-9]{0,18}$'),
  payload jsonb CHECK (payload IS NULL OR (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2097152)),
  expires_at timestamptz, retry_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid, lease_until timestamptz NOT NULL DEFAULT '-infinity', failure_code text,
  CHECK ((payload IS NULL)=(expires_at IS NULL))
);
CREATE TABLE role_profile_stratz_quota (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  day_start timestamptz NOT NULL DEFAULT date_trunc('day',now(),'UTC'), requests_used integer NOT NULL DEFAULT 0 CHECK(requests_used>=0),
  next_request_at timestamptz NOT NULL DEFAULT '-infinity', blocked_until timestamptz NOT NULL DEFAULT '-infinity'
);
