-- Both windows include the Swiss maps. A choice applies to the edition across owners.
LOCK TABLE dl30_registrations IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE dl30_protocol_choice (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  protocol text NOT NULL,
  proposal_sha256 text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES app_users(id),
  selected_at timestamptz NOT NULL,
  CHECK ((protocol, proposal_sha256) IN (
    ('full_event', '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045'),
    ('swiss_stage', '5d6015e97563ed366f5ec40ec3c941c3896607b29c1e0b0735431bd5be2b55f0')
  ))
);

-- Even an unreceipted 072 registration has already committed its choice of window.
INSERT INTO dl30_protocol_choice(protocol, proposal_sha256, owner_user_id, selected_at)
SELECT 'full_event', proposal_sha256, owner_user_id, recorded_at
FROM dl30_registrations ORDER BY recorded_at, id LIMIT 1;

CREATE FUNCTION guard_dl30_protocol_choice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'dl30_choice_immutable'; END IF;
  PERFORM id FROM app_users WHERE id=NEW.owner_user_id AND account_role='owner' AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dl30_active_owner_required'; END IF;
  -- Same lock as 072, including direct inserts that bypass the operator CLI.
  PERFORM pg_advisory_xact_lock(hashtextextended('9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045',0));
  NEW.selected_at := conditional_real_registration_clock();
  IF NEW.selected_at >= timestamptz '2026-11-30 18:00:00+00' THEN RAISE EXCEPTION 'dl30_deadline'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dl30_choice_write BEFORE INSERT OR UPDATE OR DELETE ON dl30_protocol_choice
FOR EACH ROW EXECUTE FUNCTION guard_dl30_protocol_choice();
CREATE TRIGGER dl30_choice_truncate BEFORE TRUNCATE ON dl30_protocol_choice
FOR EACH STATEMENT EXECUTE FUNCTION guard_dl30_protocol_choice();

CREATE FUNCTION dl30_choose_protocol(owner_id uuid, requested text, digest text)
RETURNS dl30_protocol_choice LANGUAGE plpgsql VOLATILE AS $$
DECLARE chosen dl30_protocol_choice%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'dl30_read_committed_required'; END IF;
  PERFORM id FROM app_users WHERE id=owner_id AND account_role='owner' AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dl30_active_owner_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045',0));
  SELECT * INTO chosen FROM dl30_protocol_choice WHERE singleton;
  IF FOUND THEN
    IF (chosen.protocol, chosen.proposal_sha256, chosen.owner_user_id) IS DISTINCT FROM (requested, digest, owner_id)
    THEN RAISE EXCEPTION 'dl30_protocol_already_chosen'; END IF;
    RETURN chosen;
  END IF;
  INSERT INTO dl30_protocol_choice(protocol,proposal_sha256,owner_user_id)
    VALUES(requested,digest,owner_id) RETURNING * INTO chosen;
  RETURN chosen;
END;
$$;

CREATE FUNCTION choose_protocol_for_dl30_registration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dl30_choose_protocol(NEW.owner_user_id, 'full_event', NEW.proposal_sha256);
  RETURN NEW;
END;
$$;
CREATE TRIGGER dl30_registration_choice AFTER INSERT ON dl30_registrations
FOR EACH ROW EXECUTE FUNCTION choose_protocol_for_dl30_registration();
