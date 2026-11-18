-- Provenance for a bounded replay of retained projections. Original HTTP bytes
-- are not reconstructed; source SHA and projected-byte SHA remain distinct.
CREATE TABLE history_projection_imports (
 id uuid PRIMARY KEY,
 manifest_text text NOT NULL CHECK(jsonb_typeof(manifest_text::jsonb)='object'),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE history_projection_import_completions (
 import_id uuid PRIMARY KEY REFERENCES history_projection_imports(id),
 report_text text NOT NULL CHECK(jsonb_typeof(report_text::jsonb)='object'),
 report_sha256 text NOT NULL CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION protect_history_projection_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'history_projection_import_audit_immutable'; END;
$$;
CREATE TRIGGER history_projection_import_immutable BEFORE UPDATE OR DELETE ON history_projection_imports
 FOR EACH ROW EXECUTE FUNCTION protect_history_projection_import_audit();
CREATE TRIGGER history_projection_completion_immutable BEFORE UPDATE OR DELETE ON history_projection_import_completions
 FOR EACH ROW EXECUTE FUNCTION protect_history_projection_import_audit();
