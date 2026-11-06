-- Optional known-map context only; neither professional statistics nor ranked sample membership.
CREATE TABLE ranked_context_receipts (
 id uuid PRIMARY KEY,
 parent_observation_id uuid NOT NULL REFERENCES ranked_practice_observations(id),
 player_id bigint NOT NULL REFERENCES players(id),
 account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 4294967295),
 identity_revision bigint NOT NULL CHECK(identity_revision>=0),
 policy_version text NOT NULL,
 fetched_at timestamptz NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2097152),
 raw_body text NOT NULL CHECK(octet_length(raw_body)<=2097152),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ranked_context_receipts_immutable BEFORE UPDATE OR DELETE ON ranked_context_receipts
 FOR EACH ROW EXECUTE FUNCTION ranked_practice_immutable();
CREATE TABLE ranked_context_map_cache (
 account_id bigint NOT NULL CHECK(account_id BETWEEN 1 AND 4294967295),
 match_id bigint NOT NULL CHECK(match_id>0),
 policy_version text NOT NULL,
 receipt_id uuid NOT NULL REFERENCES ranked_context_receipts(id),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,match_id,policy_version)
);
CREATE TABLE ranked_context_leases (
 account_id bigint PRIMARY KEY CHECK(account_id BETWEEN 1 AND 4294967295),
 lease_token uuid,
 lease_until timestamptz NOT NULL DEFAULT '-infinity',
 retry_at timestamptz NOT NULL DEFAULT '-infinity',
 failure_code text
);
