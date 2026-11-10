-- Owner-reviewed current organizational status, not historical participation or an ML feature.
CREATE TABLE team_activity_reviews (
 id bigserial PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 team_id bigint NOT NULL REFERENCES teams(id),
 request_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('active','inactive','unknown')),
 basis text NOT NULL CHECK(basis IN ('source','owner')),
 source_url text CHECK(source_url IS NULL OR (length(source_url)<=2000 AND source_url LIKE 'https://%')),
 note text NOT NULL CHECK(length(note) BETWEEN 3 AND 1000),
 checked_at timestamptz NOT NULL CHECK(isfinite(checked_at)),
 effective_at timestamptz CHECK(effective_at IS NULL OR (isfinite(effective_at) AND effective_at<=checked_at)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=8192),
 CHECK(checked_at<=recorded_at),
 CHECK((basis='source' AND source_url IS NOT NULL) OR (basis='owner' AND source_url IS NULL)),
 UNIQUE(owner_user_id,request_id),
 UNIQUE(owner_user_id,team_id,revision)
);
CREATE FUNCTION reject_team_activity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'team_activity_immutable'; END;
$$;
CREATE TRIGGER team_activity_immutable BEFORE UPDATE OR DELETE ON team_activity_reviews
 FOR EACH ROW EXECUTE FUNCTION reject_team_activity_change();
