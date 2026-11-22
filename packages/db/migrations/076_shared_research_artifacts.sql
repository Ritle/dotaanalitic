-- Private research files keyed by the SHA-256 of their exact bytes.
CREATE TABLE research_artifacts (
  sha256 text PRIMARY KEY,
  body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 16777216),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (sha256 = encode(sha256(body), 'hex'))
);
CREATE TRIGGER research_artifacts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_artifacts
FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
