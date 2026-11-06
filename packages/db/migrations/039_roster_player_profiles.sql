-- Explicit numeric profile fallback; original registry evidence remains separate.
ALTER TABLE roster_catalogue_cache DROP CONSTRAINT roster_catalogue_cache_source_key_check;
ALTER TABLE roster_catalogue_cache ADD CONSTRAINT roster_catalogue_cache_source_key_check
 CHECK (source_key IN ('registry','directory') OR source_key ~ '^team:[1-9][0-9]{0,18}$'
  OR source_key ~ '^player:[1-9][0-9]{0,9}$');
