-- First committed research evaluation, including unavailable results, remains immutable.
-- Technical failures roll back before any report/metrics may be published by the CLI.
CREATE TABLE research_evaluation_journal (
  plan_fingerprint char(64) NOT NULL CHECK (plan_fingerprint ~ '^[0-9a-f]{64}$'),
  plan_sha256 char(64) NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL CHECK (revision > 0),
  parent_revision integer,
  parent_report_sha256 char(64),
  revision_reason text,
  capture_sha256 char(64) NOT NULL CHECK (capture_sha256 ~ '^[0-9a-f]{64}$'),
  scorer_sha256 char(64) NOT NULL CHECK (scorer_sha256 ~ '^[0-9a-f]{64}$'),
  capture_text text NOT NULL CHECK (octet_length(capture_text) BETWEEN 1 AND 67108864),
  report_text text NOT NULL CHECK (octet_length(report_text) BETWEEN 1 AND 67108864),
  report_sha256 char(64) NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  evaluation_status text NOT NULL CHECK (evaluation_status IN ('research_complete', 'unavailable')),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (plan_fingerprint, revision),
  UNIQUE (plan_sha256, revision),
  UNIQUE (plan_fingerprint, revision, report_sha256),
  UNIQUE (plan_fingerprint, capture_sha256, scorer_sha256),
  FOREIGN KEY (plan_fingerprint, parent_revision, parent_report_sha256)
    REFERENCES research_evaluation_journal(plan_fingerprint, revision, report_sha256),
  CHECK ((revision = 1 AND parent_revision IS NULL AND parent_report_sha256 IS NULL AND revision_reason IS NULL)
    OR (revision > 1 AND parent_revision IS NOT NULL AND parent_revision = revision - 1
      AND parent_report_sha256 IS NOT NULL AND parent_report_sha256 ~ '^[0-9a-f]{64}$'
      AND revision_reason IS NOT NULL AND length(btrim(revision_reason)) BETWEEN 10 AND 1000)),
  CHECK (coalesce(capture_text::jsonb->>'format','') = 'research-evidence-execution-v1'),
  CHECK (coalesce(report_text::jsonb->>'format','') = 'journalled-research-report-v1')
);

CREATE FUNCTION guard_research_evaluation_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous research_evaluation_journal%ROWTYPE;
BEGIN
  -- Same lock as repository; protects the append chain even for direct SQL inserts.
  PERFORM pg_advisory_xact_lock(hashtextextended('research-evaluation:' || NEW.plan_fingerprint, 0));
  SELECT * INTO previous FROM research_evaluation_journal
    WHERE plan_fingerprint = NEW.plan_fingerprint ORDER BY revision DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.plan_sha256 <> previous.plan_sha256 OR NEW.revision <> previous.revision + 1
      OR NEW.parent_revision IS DISTINCT FROM previous.revision
      OR NEW.parent_report_sha256 IS DISTINCT FROM previous.report_sha256
      OR NEW.recorded_at < previous.recorded_at THEN
      RAISE EXCEPTION 'research_evaluation_chain_conflict';
    END IF;
  ELSIF NEW.revision <> 1 THEN
    RAISE EXCEPTION 'research_evaluation_first_revision_required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_research_evaluation_chain BEFORE INSERT ON research_evaluation_journal
  FOR EACH ROW EXECUTE FUNCTION guard_research_evaluation_chain();
CREATE TRIGGER trg_research_evaluation_immutable BEFORE UPDATE OR DELETE ON research_evaluation_journal
  FOR EACH ROW EXECUTE FUNCTION guard_ingest_evidence_immutable();
CREATE TRIGGER trg_research_evaluation_no_truncate BEFORE TRUNCATE ON research_evaluation_journal
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ingest_evidence_immutable();
