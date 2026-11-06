-- Current owner decisions across organizations; never historical attendance evidence.
CREATE TABLE provider_player_links (
 id bigserial PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES app_users(id),
 provider text NOT NULL CHECK(provider='pandascore'),
 external_player_id bigint NOT NULL CHECK(external_player_id>0),
 player_id bigint NOT NULL REFERENCES players(id),
 account_id text NOT NULL CHECK(account_id ~ '^[1-9][0-9]{0,9}$' AND account_id::numeric<=4294967295),
 binding_id bigint NOT NULL REFERENCES expected_roster_catalogue_bindings(id),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_user_id,external_player_id,binding_id)
);
CREATE INDEX provider_player_links_current ON provider_player_links(owner_user_id,external_player_id,id DESC);
CREATE TRIGGER provider_player_links_immutable BEFORE UPDATE OR DELETE ON provider_player_links
 FOR EACH ROW EXECUTE FUNCTION reject_expected_roster_catalogue_update();
ALTER TABLE roster_catalogue_cache DROP CONSTRAINT roster_catalogue_cache_source_key_check;
ALTER TABLE roster_catalogue_cache ADD CONSTRAINT roster_catalogue_cache_source_key_check
 CHECK(source_key IN ('registry','directory') OR source_key ~ '^team:[1-9][0-9]{0,18}$'
 OR source_key ~ '^player:[1-9][0-9]{0,9}$' OR source_key ~ '^search:[a-f0-9]{64}$');
