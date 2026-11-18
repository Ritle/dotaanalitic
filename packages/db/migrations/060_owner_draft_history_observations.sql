-- Committed local observations, distinct from provider known_at and a future draft cutoff.
CREATE TABLE owner_draft_history_observations (
 id UUID PRIMARY KEY,
 owner_user_id UUID NOT NULL REFERENCES app_users(id),
 scenario_id UUID NOT NULL,
 revision INTEGER NOT NULL,
 evidence_text TEXT NOT NULL CHECK(octet_length(evidence_text)<=33554432),
 evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 read_at TIMESTAMPTZ NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(scenario_id,revision) REFERENCES scenario_input_snapshots(scenario_id,revision),
 UNIQUE(owner_user_id,scenario_id,revision)
);
CREATE FUNCTION guard_owner_draft_history_observation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE e JSONB; p scenario_input_snapshots%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Draft history observations are immutable' USING ERRCODE='55000'; END IF;
 NEW.recorded_at:=clock_timestamp(); e:=NEW.evidence_text::jsonb;
 SELECT * INTO p FROM scenario_input_snapshots WHERE scenario_id=NEW.scenario_id AND revision=NEW.revision;
 IF NOT EXISTS(SELECT 1 FROM scenarios s JOIN app_users u ON u.id=s.owner_user_id WHERE s.id=NEW.scenario_id
   AND s.owner_user_id=NEW.owner_user_id AND s.revision=NEW.revision AND u.is_active AND u.account_role='owner')
   OR EXISTS(SELECT 1 FROM owner_draft_captures WHERE scenario_id=NEW.scenario_id AND revision=NEW.revision)
   OR e->>'format' IS DISTINCT FROM 'owner-draft-history-observation-v1'
   OR e->'selection'->>'format' IS DISTINCT FROM 'owner-scenario-selection-v2'
   OR e->'selection'->>'scenarioId' IS DISTINCT FROM NEW.scenario_id::text
   OR e->'selection'->>'revision' IS DISTINCT FROM NEW.revision::text
   OR e->'selection'->>'scenarioHash' IS DISTINCT FROM p.input_hash
   OR e->'selection'->'actualMatchId' IS DISTINCT FROM 'null'::jsonb
   OR (e->>'readAt')::timestamptz IS DISTINCT FROM NEW.read_at
   OR (e->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
   OR NEW.read_at<transaction_timestamp() OR NEW.read_at<p.recorded_at
   OR NEW.read_at>NEW.observed_at OR NEW.observed_at>NEW.recorded_at
   OR e->>'basis' IS DISTINCT FROM 'local_receipt_verification'
   OR e->'history'->>'format' IS DISTINCT FROM 'draft-history-projection-v1'
   OR e->'history'->>'sourcePayloadsIncluded' IS DISTINCT FROM 'false'
   OR e->'history'->>'fieldObservationsIncluded' IS DISTINCT FROM 'false'
   OR e->>'primaryEligible' IS DISTINCT FROM 'false' OR e->>'deployable' IS DISTINCT FROM 'false'
   OR e->>'scoringPerformed' IS DISTINCT FROM 'false'
   OR encode(sha256(convert_to(NEW.evidence_text,'UTF8')),'hex')<>NEW.evidence_sha256
 THEN RAISE EXCEPTION 'draft_history_observation_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER owner_draft_history_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_draft_history_observations
 FOR EACH ROW EXECUTE FUNCTION guard_owner_draft_history_observation();

CREATE TABLE owner_draft_history_links (
 capture_id UUID PRIMARY KEY REFERENCES owner_draft_captures(id),
 observation_id UUID NOT NULL UNIQUE REFERENCES owner_draft_history_observations(id),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_owner_draft_history_link() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c owner_draft_captures%ROWTYPE; o owner_draft_history_observations%ROWTYPE; observed_xid BIGINT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Draft history links are immutable' USING ERRCODE='55000'; END IF;
 NEW.recorded_at:=clock_timestamp();
 SELECT * INTO c FROM owner_draft_captures WHERE id=NEW.capture_id;
 SELECT * INTO o FROM owner_draft_history_observations WHERE id=NEW.observation_id;
 SELECT xmin::text::bigint INTO observed_xid FROM owner_draft_history_observations WHERE id=NEW.observation_id;
 IF c.id IS NULL OR o.id IS NULL OR c.owner_user_id<>o.owner_user_id OR c.scenario_id<>o.scenario_id OR c.revision<>o.revision
   OR o.recorded_at>=c.decision_cutoff_at OR observed_xid=mod(txid_current(),4294967296)
   OR (o.evidence_text::jsonb)->'selection'->>'scenarioHash' IS DISTINCT FROM (c.snapshot_text::jsonb)->>'scenarioHash'
 THEN RAISE EXCEPTION 'draft_history_link_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER owner_draft_history_link_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_draft_history_links
 FOR EACH ROW EXECUTE FUNCTION guard_owner_draft_history_link();
