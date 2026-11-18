-- Durable conditional research journal. This storage grants no evaluation/activation permission.
CREATE TABLE conditional_registrations (
 id UUID PRIMARY KEY,
 plan_text TEXT NOT NULL CHECK(octet_length(plan_text)<=16777216),
 plan_sha256 TEXT NOT NULL UNIQUE CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 protocol_key TEXT NOT NULL UNIQUE CHECK(protocol_key ~ '^[a-f0-9]{64}$'),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 writer_txid TEXT NOT NULL
);
CREATE TABLE conditional_registration_receipts (
 registration_id UUID PRIMARY KEY REFERENCES conditional_registrations(id),
 plan_sha256 TEXT NOT NULL,
 observed_committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 observer_txid TEXT NOT NULL
);
CREATE TABLE conditional_assessments (
 registration_id UUID NOT NULL REFERENCES conditional_registration_receipts(registration_id),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000),
 parent_execution_sha256 TEXT,
 correction_reason TEXT,
 execution_text TEXT NOT NULL CHECK(octet_length(execution_text)<=16777216),
 execution_sha256 TEXT NOT NULL CHECK(execution_sha256 ~ '^[a-f0-9]{64}$'),
 report_text TEXT NOT NULL CHECK(octet_length(report_text)<=16777216),
 report_sha256 TEXT NOT NULL CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
 manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(registration_id,revision),
 UNIQUE(registration_id,execution_sha256),
 UNIQUE(registration_id,report_sha256),
 UNIQUE(registration_id,manifest_sha256),
 CHECK((revision=1 AND parent_execution_sha256 IS NULL AND correction_reason IS NULL) OR
       (revision>1 AND parent_execution_sha256 IS NOT NULL AND parent_execution_sha256 ~ '^[a-f0-9]{64}$'
         AND correction_reason IS NOT NULL AND length(trim(correction_reason)) BETWEEN 10 AND 1000))
);

CREATE FUNCTION guard_conditional_registration() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p JSONB; scope_item JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'conditional_registration_immutable' USING ERRCODE='55000'; END IF;
 NEW.recorded_at:=date_trunc('milliseconds',clock_timestamp()); NEW.writer_txid:=txid_current()::text;
 p:=NEW.plan_text::jsonb;
 NEW.protocol_key:=encode(sha256(convert_to(jsonb_build_object('policy',p->>'policySha256','window',p->'window',
   'scope',(SELECT jsonb_agg(jsonb_build_object('leagueId',s->>'leagueId','editionKey',s->>'editionKey') ORDER BY s->>'leagueId')
     FROM jsonb_array_elements(p->'scope') s))::text,'UTF8')),'hex');
 IF encode(sha256(convert_to(NEW.plan_text,'UTF8')),'hex') IS DISTINCT FROM NEW.plan_sha256
   OR p->>'format' IS DISTINCT FROM 'conditional-registration-plan-v1'
   OR p->>'syntheticOnly' IS DISTINCT FROM 'true'
   OR p->>'policySha256' IS DISTINCT FROM '77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f'
   OR p->>'candidateSha256' IS DISTINCT FROM '9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b'
   OR p->'exposure'->>'sha256' IS DISTINCT FROM 'ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3'
   OR (p->'window'->>'from')::timestamptz IS NULL OR (p->'window'->>'until')::timestamptz IS NULL
   OR (p->'window'->>'assessmentAt')::timestamptz IS NULL
   OR NEW.recorded_at >= (p->'window'->>'from')::timestamptz
   OR (p->'window'->>'until')::timestamptz-(p->'window'->>'from')::timestamptz<>interval '28 days'
   OR (p->'window'->>'assessmentAt')::timestamptz-(p->'window'->>'until')::timestamptz<>interval '7 days'
   OR (p->'executable'->>'capturedAt')::timestamptz IS NULL
   OR (p->'executable'->>'capturedAt')::timestamptz>NEW.recorded_at
   OR jsonb_typeof(p->'scope') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'scope') NOT BETWEEN 1 AND 10
 THEN RAISE EXCEPTION 'conditional_registration_invalid' USING ERRCODE='23514'; END IF;
 FOR scope_item IN SELECT value FROM jsonb_array_elements(p->'scope') LOOP
   IF scope_item->>'stage' IS DISTINCT FROM 'main_event' OR (scope_item->>'earliestSeriesAt')::timestamptz IS NULL
     OR (scope_item->>'earliestSeriesAt')::timestamptz<=NEW.recorded_at OR (scope_item->>'evidenceObservedAt')::timestamptz IS NULL
     OR (scope_item->>'evidenceObservedAt')::timestamptz>NEW.recorded_at
   THEN RAISE EXCEPTION 'conditional_registration_scope_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE FUNCTION guard_conditional_registration_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r conditional_registrations%ROWTYPE; p JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'conditional_receipt_immutable' USING ERRCODE='55000'; END IF;
 NEW.observed_committed_at:=date_trunc('milliseconds',clock_timestamp()); NEW.observer_txid:=txid_current()::text;
 SELECT * INTO r FROM conditional_registrations WHERE id=NEW.registration_id;
 p:=r.plan_text::jsonb;
 IF r.id IS NULL OR r.writer_txid=NEW.observer_txid OR r.plan_sha256 IS DISTINCT FROM NEW.plan_sha256
   OR NEW.observed_committed_at<r.recorded_at OR NEW.observed_committed_at>=(p->'window'->>'from')::timestamptz
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'scope') s WHERE (s->>'earliestSeriesAt')::timestamptz<=NEW.observed_committed_at)
 THEN RAISE EXCEPTION 'conditional_commit_not_observed_in_time' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION guard_conditional_assessment() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r conditional_registrations%ROWTYPE; c conditional_registration_receipts%ROWTYPE;
 h conditional_assessments%ROWTYPE; p JSONB; e JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'conditional_assessment_immutable' USING ERRCODE='55000'; END IF;
 -- The row lock serializes even direct SQL writers, not only repository callers.
 SELECT * INTO r FROM conditional_registrations WHERE id=NEW.registration_id FOR UPDATE;
 SELECT * INTO c FROM conditional_registration_receipts WHERE registration_id=NEW.registration_id;
 SELECT * INTO h FROM conditional_assessments WHERE registration_id=NEW.registration_id ORDER BY revision DESC LIMIT 1;
 NEW.recorded_at:=date_trunc('milliseconds',clock_timestamp()); p:=r.plan_text::jsonb; e:=NEW.execution_text::jsonb;
 IF r.id IS NULL OR c.registration_id IS NULL
   OR NEW.revision<>coalesce(h.revision,0)+1 OR NEW.parent_execution_sha256 IS DISTINCT FROM h.execution_sha256
   OR NEW.recorded_at<(p->'window'->>'assessmentAt')::timestamptz
   OR encode(sha256(convert_to(NEW.execution_text,'UTF8')),'hex') IS DISTINCT FROM NEW.execution_sha256
   OR encode(sha256(convert_to(NEW.report_text,'UTF8')),'hex') IS DISTINCT FROM NEW.report_sha256
   OR e->>'format' IS DISTINCT FROM 'conditional-assessment-binding-v1' OR e->>'syntheticOnly' IS DISTINCT FROM 'true'
   OR e->>'reportSha256' IS DISTINCT FROM NEW.report_sha256 OR e->>'manifestSha256' IS DISTINCT FROM NEW.manifest_sha256
   OR e->>'policySha256' IS DISTINCT FROM p->>'policySha256' OR e->>'candidateSha256' IS DISTINCT FROM p->>'candidateSha256'
   OR e->>'exposureSha256' IS DISTINCT FROM p->'exposure'->>'sha256'
   OR e->'code' IS DISTINCT FROM p->'executable'->'code' OR e->>'environmentSha256' IS DISTINCT FROM p->'executable'->>'environmentSha256'
   OR e->'window'->>'fromAt' IS DISTINCT FROM p->'window'->>'from' OR e->'window'->>'until' IS DISTINCT FROM p->'window'->>'until'
   OR e->'schedule'->>'from' IS DISTINCT FROM p->'window'->>'from' OR e->'schedule'->>'until' IS DISTINCT FROM p->'window'->>'until'
   OR e->'schedule'->>'assessmentAt' IS DISTINCT FROM p->'window'->>'assessmentAt'
   OR (e->'schedule'->>'registeredAt')::timestamptz IS DISTINCT FROM c.observed_committed_at
   OR (e->'schedule'->>'assessedAt')::timestamptz IS NULL
   OR (e->'schedule'->>'assessedAt')::timestamptz<(p->'window'->>'assessmentAt')::timestamptz
   OR (e->'schedule'->>'assessedAt')::timestamptz>NEW.recorded_at
   OR (h.revision IS NOT NULL AND ((e->'schedule'->>'assessedAt')::timestamptz<(h.execution_text::jsonb->'schedule'->>'assessedAt')::timestamptz OR NEW.recorded_at<h.recorded_at))
   OR coalesce(e->>'status','') NOT IN ('insufficient','negative','positive_synthetic_only')
   OR e->'releaseGatePassed' IS DISTINCT FROM 'false'::jsonb OR e->'activationAllowed' IS DISTINCT FROM 'false'::jsonb OR e->'deployable' IS DISTINCT FROM 'false'::jsonb
   OR (SELECT jsonb_agg(x ORDER BY x->>'leagueId') FROM jsonb_array_elements(e->'scope') x) IS DISTINCT FROM
      (SELECT jsonb_agg(jsonb_build_object('leagueId',x->>'leagueId','editionKey',x->>'editionKey') ORDER BY x->>'leagueId') FROM jsonb_array_elements(p->'scope') x)
 THEN RAISE EXCEPTION 'conditional_assessment_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER conditional_registration_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_registrations
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_registration();
CREATE TRIGGER conditional_registration_no_truncate BEFORE TRUNCATE ON conditional_registrations
 FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_registration();
CREATE TRIGGER conditional_registration_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_registration_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_registration_receipt();
CREATE TRIGGER conditional_registration_receipt_no_truncate BEFORE TRUNCATE ON conditional_registration_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_registration_receipt();
CREATE TRIGGER conditional_assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON conditional_assessments
 FOR EACH ROW EXECUTE FUNCTION guard_conditional_assessment();
CREATE TRIGGER conditional_assessment_no_truncate BEFORE TRUNCATE ON conditional_assessments
 FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_assessment();
