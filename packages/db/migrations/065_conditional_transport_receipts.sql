-- Local synthetic transport only. A receipt is evidence, never dispatch/model permission.
CREATE TABLE conditional_transport_receipts (
 registration_id UUID NOT NULL,
 reservation_operation_id UUID NOT NULL,
 request_id UUID NOT NULL,
 receipt_text TEXT NOT NULL CHECK(octet_length(receipt_text)<=9000000),
 receipt_sha256 TEXT NOT NULL DEFAULT '',
 saved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(registration_id,request_id),
 UNIQUE(registration_id,reservation_operation_id),
 FOREIGN KEY(registration_id,reservation_operation_id)
  REFERENCES conditional_collection_events(registration_id,operation_id)
);
CREATE FUNCTION guard_conditional_transport_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE h conditional_collection_journals%ROWTYPE;e conditional_collection_events%ROWTYPE;r JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'transport_receipt_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO h FROM conditional_collection_journals WHERE registration_id=NEW.registration_id FOR SHARE;
 IF h.registration_id IS NULL OR NOT h.synthetic_only OR NOT EXISTS(
  SELECT 1 FROM app_users WHERE id=h.owner_user_id AND is_active AND account_role='owner')
 THEN RAISE EXCEPTION 'synthetic_transport_owner_required' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM conditional_collection_events WHERE registration_id=NEW.registration_id AND operation_id=NEW.reservation_operation_id;
 r:=NEW.receipt_text::jsonb;
 IF e.event_text::jsonb->>'kind' IS DISTINCT FROM 'request_started'
  OR e.event_text::jsonb->>'requestId' IS DISTINCT FROM NEW.request_id::text
  OR r->>'format' IS DISTINCT FROM 'conditional-local-transport-receipt-v1'
  OR r->>'registrationId' IS DISTINCT FROM NEW.registration_id::text
  OR r->>'requestId' IS DISTINCT FROM NEW.request_id::text
  OR r->>'reservationHeadSha256' IS DISTINCT FROM e.head_sha256
  OR r->>'endpoint' IS DISTINCT FROM e.event_text::jsonb->>'endpoint'
  OR r->>'syntheticOnly' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'transport_reservation_binding' USING ERRCODE='23514'; END IF;
 NEW.receipt_sha256:=encode(sha256(convert_to(NEW.receipt_text,'UTF8')),'hex');
 NEW.saved_at:=date_trunc('milliseconds',clock_timestamp());RETURN NEW;
END;
$$;
CREATE TRIGGER conditional_transport_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON conditional_transport_receipts FOR EACH ROW EXECUTE FUNCTION guard_conditional_transport_receipt();
CREATE TRIGGER conditional_transport_receipt_truncate_guard BEFORE TRUNCATE
 ON conditional_transport_receipts FOR EACH STATEMENT EXECUTE FUNCTION guard_conditional_transport_receipt();
