-- schedule-source-age-v1: operational admission, not an Elo feature or validation change.
-- Add independent guards; keep SQL 001-043 and the frozen executor byte-identical.
CREATE FUNCTION schedule_source_freshness_reason_v1(fetched TIMESTAMPTZ, checked TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN fetched IS NULL OR checked IS NULL OR NOT isfinite(fetched) OR NOT isfinite(checked) OR fetched>checked
      THEN 'schedule_source_clock_invalid'
    WHEN checked>=fetched+interval '5 minutes' THEN 'schedule_source_stale'
    ELSE NULL END;
$$;

CREATE FUNCTION guard_schedule_target_freshness_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE fetched TIMESTAMPTZ; reason TEXT;
BEGIN
  -- The existing validation trigger retains owner/source mapping and publication locks.
  SELECT source_fetched_at INTO fetched FROM upcoming_source_observations WHERE id=NEW.observation_id;
  reason:=schedule_source_freshness_reason_v1(fetched,clock_timestamp());
  IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_v1_schedule_target_freshness AFTER INSERT ON v1_schedule_targets
  FOR EACH ROW EXECUTE FUNCTION guard_schedule_target_freshness_v1();

CREATE FUNCTION guard_scheduled_runtime_freshness_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s JSONB:=NEW.snapshot_text::jsonb; fetched TIMESTAMPTZ; reason TEXT;
BEGIN
  IF s#>>'{request,purpose}'='real_map' AND s#>>'{request,realTarget,provider}'='pandascore' THEN
    SELECT source_fetched_at INTO fetched FROM upcoming_source_observations
      WHERE id=(s#>>'{targetReview,scheduleBinding,currentObservation,id}')::bigint AND cache_key='schedule';
    -- Recheck after inference/lock waits, at persistence. Raising rolls back the prediction too.
    reason:=schedule_source_freshness_reason_v1(fetched,clock_timestamp());
    IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_v1_runtime_schedule_freshness AFTER INSERT ON v1_runtime_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_scheduled_runtime_freshness_v1();
