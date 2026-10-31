-- Server attestation for owner input, distinct from source event/known/fetched clocks.
-- Legacy evidence stays NULL: adding a column cannot establish a past recording time.
ALTER TABLE match_field_observations ADD COLUMN recorded_at TIMESTAMPTZ,
  ADD CONSTRAINT ck_context_recorded_precision CHECK (recorded_at IS NULL OR recorded_at=date_trunc('milliseconds',recorded_at));
CREATE FUNCTION stamp_observation_recorded_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- A conservative upper millisecond bound avoids rounding a post-cutoff insert backwards.
  -- clock_timestamp, not transaction/statement start: a long transaction cannot backdate input.
  NEW.recorded_at=date_trunc('milliseconds',clock_timestamp())+interval '1 millisecond';
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_observation_recorded_at BEFORE INSERT ON match_field_observations
  FOR EACH ROW EXECUTE FUNCTION stamp_observation_recorded_at();
COMMENT ON COLUMN match_field_observations.recorded_at IS 'Server-recorded upper millisecond bound; never source supplied. NULL for legacy rows';
-- Existing immutable ingestion trigger protects this stamp from UPDATE/DELETE.
