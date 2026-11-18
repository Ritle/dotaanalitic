-- Independent provider receipts; never canonical outcomes or training labels.
CREATE TABLE journal_provider_result_receipts (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 provider_match_id BIGINT NOT NULL CHECK (provider_match_id > 0),
 observation_text TEXT NOT NULL CHECK (octet_length(observation_text) <= 2200000),
 observation_sha256 TEXT NOT NULL CHECK (observation_sha256 ~ '^[a-f0-9]{64}$'),
 terminal BOOLEAN NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX journal_provider_result_latest ON journal_provider_result_receipts(provider_match_id,id DESC);
CREATE FUNCTION protect_journal_provider_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'provider receipts are immutable'; END $$;
CREATE TRIGGER journal_provider_receipt_immutable BEFORE UPDATE OR DELETE ON journal_provider_result_receipts
FOR EACH ROW EXECUTE FUNCTION protect_journal_provider_receipt();
