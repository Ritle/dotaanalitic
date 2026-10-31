-- Existing legacy job rows retain their lifecycle. Versioned reports are terminal snapshots.
ALTER TABLE scenarios ADD COLUMN report_version_counter INTEGER NOT NULL DEFAULT 0 CHECK (report_version_counter>=0);
ALTER TABLE analysis_runs
  ADD COLUMN scenario_revision INTEGER,
  ADD COLUMN report_version INTEGER,
  ADD COLUMN result_hash TEXT,
  ADD CONSTRAINT analysis_snapshot_revision_fk FOREIGN KEY (scenario_id,scenario_revision)
    REFERENCES scenario_input_snapshots(scenario_id,revision),
  ADD CONSTRAINT analysis_versioned_report_check CHECK (
    (scenario_revision IS NULL AND report_version IS NULL AND result_hash IS NULL) OR
    (scenario_revision IS NOT NULL AND scenario_revision>=1 AND report_version IS NOT NULL AND report_version>=1
      AND result_hash IS NOT NULL AND result_hash ~ '^[a-f0-9]{64}$'
      AND status='done' AND result IS NOT NULL AND jsonb_typeof(result)='object' AND computed_at IS NOT NULL)
  );
CREATE UNIQUE INDEX analysis_report_version ON analysis_runs(scenario_id,report_version) WHERE report_version IS NOT NULL;
CREATE FUNCTION guard_versioned_analysis_report() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.report_version IS NOT NULL OR (TG_OP='UPDATE' AND NEW.report_version IS NOT NULL) THEN
      RAISE EXCEPTION 'Versioned analysis reports are immutable' USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.report_version IS NOT NULL THEN
    NEW.created_at := clock_timestamp();
    IF NOT EXISTS (SELECT 1 FROM scenario_input_snapshots p WHERE p.scenario_id=NEW.scenario_id
      AND p.revision=NEW.scenario_revision AND p.input_hash=NEW.input_hash
      AND p.input_snapshot=NEW.result#>'{scenario,input}')
      OR NEW.result#>>'{scenario,id}' IS DISTINCT FROM NEW.scenario_id::text
      OR NEW.result#>>'{scenario,revision}' IS DISTINCT FROM NEW.scenario_revision::text
      OR NEW.result#>>'{scenario,inputHash}' IS DISTINCT FROM btrim(NEW.input_hash)
      OR NEW.result->>'policyVersion' IS DISTINCT FROM NEW.algorithm_version THEN
      RAISE EXCEPTION 'Report does not match frozen scenario input' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER versioned_analysis_report_guard BEFORE INSERT OR UPDATE OR DELETE ON analysis_runs
  FOR EACH ROW EXECUTE FUNCTION guard_versioned_analysis_report();
