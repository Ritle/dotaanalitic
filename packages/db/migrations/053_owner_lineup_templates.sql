-- Shared expected lineups, authored by the single owner; never historical participation.
-- Keep the existing single-account index. Additional account provisioning is out of scope.
ALTER TABLE app_users ADD COLUMN account_role text NOT NULL DEFAULT 'owner'
 CHECK(account_role IN ('owner','user'));
CREATE TABLE owner_lineup_templates (
 id bigserial PRIMARY KEY,
 team_id bigint NOT NULL REFERENCES teams(id),
 revision integer NOT NULL CHECK(revision>0),
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 owner_login text NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 lineup jsonb NOT NULL CHECK(jsonb_typeof(lineup)='array' AND jsonb_array_length(lineup)=5),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=8192),
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(team_id,revision)
);
CREATE FUNCTION validate_owner_lineup_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_users WHERE id=NEW.owner_user_id AND is_active AND account_role='owner' AND login=NEW.owner_login) THEN
  RAISE EXCEPTION 'owner_lineup_permission_denied';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.lineup) p WHERE jsonb_typeof(p)<>'object'
  OR coalesce(p->>'playerId','') !~ '^[1-9][0-9]{0,18}$'
  OR jsonb_typeof(p->'playerId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p->'rolePos') IS DISTINCT FROM 'number'
  OR coalesce(p->>'rolePos','') !~ '^[1-5]$')
  OR (SELECT count(DISTINCT p->>'playerId') FROM jsonb_array_elements(NEW.lineup) p)<>5
  OR (SELECT count(DISTINCT p->>'rolePos') FROM jsonb_array_elements(NEW.lineup) p)<>5
  OR (SELECT count(*) FROM players WHERE id IN (SELECT (p->>'playerId')::bigint FROM jsonb_array_elements(NEW.lineup) p))<>5 THEN
  RAISE EXCEPTION 'owner_lineup_invalid_players_or_roles';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER owner_lineup_validate BEFORE INSERT ON owner_lineup_templates FOR EACH ROW EXECUTE FUNCTION validate_owner_lineup_template();
CREATE FUNCTION reject_owner_lineup_template_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'owner_lineup_template_immutable'; END;
$$;
CREATE TRIGGER owner_lineup_immutable BEFORE UPDATE OR DELETE ON owner_lineup_templates FOR EACH ROW EXECUTE FUNCTION reject_owner_lineup_template_change();
