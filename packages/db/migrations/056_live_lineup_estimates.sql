-- Conditional neutral-map estimates are deliberately outside real forecast/outcome tables.
CREATE TABLE live_lineup_estimates (
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 request_id uuid NOT NULL,
 provider_match_id bigint NOT NULL CHECK(provider_match_id>0),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 snapshot_text text NOT NULL,
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_user_id,request_id)
);
CREATE INDEX live_lineup_estimates_match ON live_lineup_estimates(owner_user_id,provider_match_id,created_at DESC);
CREATE FUNCTION protect_live_lineup_estimate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'live_lineup_estimate_immutable'; END;
$$;
CREATE TRIGGER live_lineup_estimate_immutable BEFORE UPDATE OR DELETE ON live_lineup_estimates
 FOR EACH ROW EXECUTE FUNCTION protect_live_lineup_estimate();
