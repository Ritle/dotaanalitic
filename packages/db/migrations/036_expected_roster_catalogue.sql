-- Current, owner-selected provider associations. No historic attendance assertion.
CREATE TABLE roster_catalogue_cache (
 source_key text PRIMARY KEY CHECK (source_key='registry' OR source_key ~ '^team:[1-9][0-9]{0,18}$'),
 observation jsonb,
 expires_at timestamptz,
 lease_token uuid,
 lease_until timestamptz NOT NULL DEFAULT '-infinity',
 retry_at timestamptz NOT NULL DEFAULT '-infinity',
 CHECK (observation IS NULL OR octet_length(observation::text)<=20000000)
);
CREATE FUNCTION reject_expected_roster_catalogue_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'expected_roster_catalogue_immutable'; END;
$$;
CREATE TABLE expected_roster_catalogue_bindings (
 id bigserial PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 request_id uuid NOT NULL,
 provider_team_id bigint NOT NULL CHECK(provider_team_id>0),
 team_id bigint NOT NULL REFERENCES teams(id),
 revision integer NOT NULL CHECK(revision>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request jsonb NOT NULL,
 binding jsonb NOT NULL,
 UNIQUE(owner_user_id,request_id),
 UNIQUE(owner_user_id,provider_team_id,revision),
 CHECK(octet_length(request::text)<=8192 AND octet_length(binding::text)<=32768)
);
CREATE TRIGGER expected_roster_catalogue_immutable BEFORE UPDATE OR DELETE ON expected_roster_catalogue_bindings
 FOR EACH ROW EXECUTE FUNCTION reject_expected_roster_catalogue_update();
CREATE TABLE roster_catalogue_operations (
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 provider_team_id bigint NOT NULL CHECK(provider_team_id>0),
 lease_token uuid,
 lease_until timestamptz NOT NULL DEFAULT '-infinity',
 PRIMARY KEY(owner_user_id,provider_team_id)
);
