-- Content-addressed projections of previously observed identifiers, shared by research clients.
-- recorded_at is the time this DB received the projection, not the time a map was first seen.
CREATE FUNCTION valid_research_exposure_snapshot(doc jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE field text; ids jsonb;
BEGIN
  IF doc - ARRAY['format','producer','codeSha256','inputs','inventory'] <> '{}'::jsonb
    OR doc->>'format' IS DISTINCT FROM 'research-exposure-snapshot-v1'
    OR coalesce(doc->>'producer','') NOT IN ('series-review','draft-lab-review')
    OR jsonb_typeof(doc->'codeSha256') IS DISTINCT FROM 'string' OR (doc->>'codeSha256') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(doc->'inputs') IS DISTINCT FROM 'object' OR doc->'inputs' = '{}'::jsonb
    OR jsonb_typeof(doc->'inventory') IS DISTINCT FROM 'object'
    OR (doc->'inventory') - ARRAY['mapIds','openDotaSeriesIds','pandaScoreMeetingIds'] <> '{}'::jsonb
  THEN RETURN false; END IF;
  IF EXISTS (SELECT FROM jsonb_each(doc->'inputs') entry
    WHERE entry.key !~ '^[A-Za-z0-9_-]{1,64}$' OR jsonb_typeof(entry.value) <> 'string'
       OR (entry.value #>> '{}') !~ '^[a-f0-9]{64}$') THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['mapIds','openDotaSeriesIds','pandaScoreMeetingIds'] LOOP
    ids := doc->'inventory'->field;
    IF jsonb_typeof(ids) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(ids)>(CASE WHEN field='mapIds' THEN 100000 ELSE 200000 END) OR EXISTS (SELECT FROM jsonb_array_elements(ids) v
      WHERE jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^[1-9][0-9]{0,18}$'
        OR (length(v #>> '{}')=19 AND (v #>> '{}') COLLATE "C" > '9223372036854775807'))
      OR (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(ids) v) <> jsonb_array_length(ids)
    THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE research_exposure_snapshots (
  sha256 text PRIMARY KEY,
  snapshot_text text NOT NULL CHECK (octet_length(snapshot_text) BETWEEN 1 AND 16777216),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (sha256 = encode(sha256(convert_to(snapshot_text,'UTF8')),'hex')),
  CHECK (snapshot_text IS JSON OBJECT WITH UNIQUE KEYS AND valid_research_exposure_snapshot(snapshot_text::jsonb))
);
CREATE TRIGGER research_exposure_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_exposure_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
