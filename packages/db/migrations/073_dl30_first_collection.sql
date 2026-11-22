-- The first December league discovery request has exactly one durable reservation.
CREATE TABLE dl30_first_requests (
  registration_id uuid PRIMARY KEY REFERENCES dl30_registration_receipts(registration_id),
  operation_id uuid NOT NULL UNIQUE,
  registration_sha256 text NOT NULL CHECK (registration_sha256 ~ '^[0-9a-f]{64}$'),
  owner_user_id uuid NOT NULL REFERENCES app_users(id),
  endpoint text NOT NULL CHECK (endpoint ~ '^/leagues/[1-9][0-9]{0,18}/matches$'),
  reserved_at timestamptz NOT NULL,
  writer_txid bigint NOT NULL
);

CREATE TABLE dl30_first_responses (
  operation_id uuid PRIMARY KEY REFERENCES dl30_first_requests(operation_id),
  observed_at timestamptz NOT NULL,
  http_status integer CHECK (http_status BETWEEN 200 AND 599),
  result_code text CHECK (result_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  body bytea CHECK (octet_length(body) <= 8388608),
  body_sha256 text GENERATED ALWAYS AS (encode(sha256(body), 'hex')) STORED,
  CHECK (body IS NOT NULL OR result_code IS NOT NULL),
  CHECK (body IS NULL OR (http_status IS NOT NULL AND http_status BETWEEN 200 AND 299)),
  CHECK (result_code IS NOT NULL OR (body IS NOT NULL AND http_status BETWEEN 200 AND 299))
);

CREATE FUNCTION dl30_first_request_in_window(request_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT coalesce((SELECT t.at >= q.reserved_at AND t.at < q.reserved_at + interval '30 seconds'
    AND t.at < (p.scope->>'untilExclusive')::timestamptz AND u.is_active AND u.account_role='owner'
    FROM dl30_first_requests q JOIN dl30_registrations r ON r.id=q.registration_id
    JOIN app_users u ON u.id=q.owner_user_id
    CROSS JOIN LATERAL (SELECT (r.package_text::jsonb->>'preparedText')::jsonb->'scope' AS scope) p
    CROSS JOIN (SELECT conditional_real_registration_clock() AS at) t
    WHERE q.operation_id=request_id), false);
$$;

CREATE FUNCTION guard_dl30_first_collection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE confirmed record; reservation dl30_first_requests%ROWTYPE; observed timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'dl30_collection_immutable'; END IF;
  IF TG_TABLE_NAME='dl30_first_requests' THEN
    SELECT r.owner_user_id, r.package_sha256, c.observed_at, c.observer_txid,
      (r.package_text::jsonb->>'preparedText')::jsonb->'scope' AS scope,
      r.package_text::jsonb #>> '{review,bindings,0,leagueId}' AS league_id
      INTO confirmed FROM dl30_registrations r
      JOIN dl30_registration_receipts c ON c.registration_id=r.id AND c.package_sha256=r.package_sha256
      JOIN app_users u ON u.id=r.owner_user_id AND u.account_role='owner' AND u.is_active
      WHERE r.id=NEW.registration_id FOR SHARE OF u;
    IF NOT FOUND OR confirmed.observer_txid=txid_current()
      OR NEW.owner_user_id IS DISTINCT FROM confirmed.owner_user_id
      OR NEW.registration_sha256 IS DISTINCT FROM confirmed.package_sha256
      OR NEW.endpoint IS DISTINCT FROM '/leagues/' || confirmed.league_id || '/matches'
    THEN RAISE EXCEPTION 'dl30_collection_receipt_required'; END IF;
    observed:=conditional_real_registration_clock();
    IF (observed >= (confirmed.scope->>'fromInclusive')::timestamptz
        AND observed < (confirmed.scope->>'untilExclusive')::timestamptz
        AND observed >= confirmed.observed_at) IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'dl30_collection_window_closed'; END IF;
    NEW.reserved_at:=observed;
    NEW.writer_txid:=txid_current();
  ELSE
    SELECT * INTO STRICT reservation FROM dl30_first_requests WHERE operation_id=NEW.operation_id;
    IF reservation.writer_txid=txid_current() THEN RAISE EXCEPTION 'dl30_collection_reservation_uncommitted'; END IF;
    NEW.observed_at:=conditional_real_registration_clock();
    IF NEW.observed_at<reservation.reserved_at THEN RAISE EXCEPTION 'dl30_collection_clock_regression'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dl30_first_request_guard BEFORE INSERT OR UPDATE OR DELETE ON dl30_first_requests
  FOR EACH ROW EXECUTE FUNCTION guard_dl30_first_collection();
CREATE TRIGGER dl30_first_response_guard BEFORE INSERT OR UPDATE OR DELETE ON dl30_first_responses
  FOR EACH ROW EXECUTE FUNCTION guard_dl30_first_collection();
CREATE TRIGGER dl30_first_request_no_truncate BEFORE TRUNCATE ON dl30_first_requests
  FOR EACH STATEMENT EXECUTE FUNCTION guard_dl30_first_collection();
CREATE TRIGGER dl30_first_response_no_truncate BEFORE TRUNCATE ON dl30_first_responses
  FOR EACH STATEMENT EXECUTE FUNCTION guard_dl30_first_collection();
