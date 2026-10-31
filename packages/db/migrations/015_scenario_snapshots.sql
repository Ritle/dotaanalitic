-- Owner-confirmed hypothetical inputs. No historical availability is inferred.
CREATE TABLE scenario_input_snapshots (
  scenario_id UUID NOT NULL REFERENCES scenarios(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  input_snapshot JSONB NOT NULL CHECK (jsonb_typeof(input_snapshot)='object'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  source_kind TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind='manual'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scenario_id,revision)
);
CREATE FUNCTION guard_scenario_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Scenario input snapshots are immutable' USING ERRCODE='55000';
  END IF;
  NEW.recorded_at := clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM scenarios WHERE id=NEW.scenario_id AND revision=NEW.revision) THEN
    RAISE EXCEPTION 'Scenario revision mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scenario_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON scenario_input_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_scenario_snapshot();
