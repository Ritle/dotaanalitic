-- Durable one-click preparation; model snapshots remain in the existing runtime tables.
CREATE TABLE upcoming_forecast_preparations (
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 request_id uuid NOT NULL,
 provider_match_id bigint NOT NULL CHECK(provider_match_id>0),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 scenario_id uuid NOT NULL REFERENCES scenarios(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_user_id,request_id)
);
CREATE INDEX upcoming_forecast_preparations_match ON upcoming_forecast_preparations(owner_user_id,provider_match_id,created_at DESC);
CREATE FUNCTION protect_upcoming_forecast_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'upcoming_forecast_preparation_immutable'; END;
$$;
CREATE TRIGGER upcoming_forecast_preparation_immutable BEFORE UPDATE OR DELETE ON upcoming_forecast_preparations
 FOR EACH ROW EXECUTE FUNCTION protect_upcoming_forecast_preparation();
