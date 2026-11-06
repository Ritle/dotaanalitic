-- Provider namespaces stay explicit; no invented OpenDota ID for a new organization.
CREATE TABLE provider_team_catalogue (
 provider text NOT NULL CHECK(provider='pandascore'),
 external_team_id bigint NOT NULL CHECK(external_team_id>0),
 team_id bigint NOT NULL UNIQUE REFERENCES teams(id),
 source jsonb NOT NULL CHECK(octet_length(source::text)<=4096),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(provider,external_team_id)
);
CREATE FUNCTION reject_provider_team_catalogue_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'provider_team_catalogue_immutable'; END;
$$;
CREATE TRIGGER provider_team_catalogue_immutable BEFORE UPDATE OR DELETE ON provider_team_catalogue
 FOR EACH ROW EXECUTE FUNCTION reject_provider_team_catalogue_update();
