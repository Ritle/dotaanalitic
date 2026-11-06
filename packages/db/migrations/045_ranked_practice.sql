-- Separate descriptive ranked-public observations. Never imported into pro matches.
CREATE TABLE ranked_practice_observations (
 id uuid PRIMARY KEY,
 player_id bigint NOT NULL REFERENCES players(id),
 account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 4294967295),
 provider text NOT NULL CHECK(provider IN ('opendota','stratz')),
 identity_revision bigint NOT NULL CHECK(identity_revision>=0),
 fetched_at timestamptz NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2097152),
 raw_bodies jsonb NOT NULL CHECK(jsonb_typeof(raw_bodies)='array' AND octet_length(raw_bodies::text)<=8388608),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ranked_practice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ranked_practice_immutable'; END $$;
CREATE TRIGGER ranked_practice_immutable BEFORE UPDATE OR DELETE ON ranked_practice_observations
 FOR EACH ROW EXECUTE FUNCTION ranked_practice_immutable();
CREATE TABLE ranked_practice_cache (
 source_key text PRIMARY KEY CHECK(source_key ~ '^(opendota|stratz):[1-9][0-9]{0,9}$'),
 observation_id uuid REFERENCES ranked_practice_observations(id),
 expires_at timestamptz,
 retry_at timestamptz NOT NULL DEFAULT '-infinity',
 lease_token uuid, lease_until timestamptz NOT NULL DEFAULT '-infinity', failure_code text,
 CHECK((observation_id IS NULL)=(expires_at IS NULL))
);
