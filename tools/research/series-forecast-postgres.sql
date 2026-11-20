-- Install only in a disposable research database, outside the product migration chain.
DO $guard$
BEGIN
  IF current_database() !~ '^codex_ingest_[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'disposable rehearsal database required';
  END IF;
END $guard$;
CREATE SCHEMA bo3_rehearsal;
CREATE TABLE bo3_rehearsal.forecasts (
  match_id bigint PRIMARY KEY CHECK (match_id > 0),
  request_sha text NOT NULL,
  receipt_text text NOT NULL,
  receipt_sha text NOT NULL CHECK (receipt_sha = encode(sha256(convert_to(receipt_text,'UTF8')),'hex'))
);
CREATE TABLE bo3_rehearsal.commit_witnesses (
  match_id bigint PRIMARY KEY REFERENCES bo3_rehearsal.forecasts(match_id),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER forecast_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON bo3_rehearsal.forecasts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER witness_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON bo3_rehearsal.commit_witnesses
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
