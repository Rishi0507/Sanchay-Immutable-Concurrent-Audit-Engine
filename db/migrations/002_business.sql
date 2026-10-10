-- Business chain: event log and ledger postings (PRD sections 6 and 7).
-- Written only by the ledger core.

CREATE TABLE business.events (
  seq               bigint       PRIMARY KEY,
  event_type        text         NOT NULL,
  entity_id         text         NOT NULL,
  aggregate_type    text         NOT NULL,
  aggregate_id      text         NOT NULL,
  aggregate_version integer      NOT NULL CHECK (aggregate_version >= 1),
  sale_id           text,
  payload           jsonb        NOT NULL,
  business_date     date,
  recorded_at       timestamptz  NOT NULL,
  identity_user     text         NOT NULL,
  identity_role     text         NOT NULL,
  idempotency_key   text         NOT NULL,
  request_hash      char(64)     NOT NULL,
  prev_hash         char(64)     NOT NULL,
  hash              char(64)     NOT NULL,
  CONSTRAINT events_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT events_aggregate_version UNIQUE (aggregate_id, aggregate_version),
  CONSTRAINT events_hash UNIQUE (hash)
);

CREATE INDEX events_type_seq ON business.events (event_type, seq);
CREATE INDEX events_sale ON business.events (sale_id, seq) WHERE sale_id IS NOT NULL;
CREATE INDEX events_business_date ON business.events (business_date);

CREATE TABLE business.postings (
  seq               bigint   NOT NULL REFERENCES business.events (seq),
  line_no           integer  NOT NULL,
  account_code      text     NOT NULL,
  debit             bigint   NOT NULL CHECK (debit >= 0),
  credit            bigint   NOT NULL CHECK (credit >= 0),
  entity_id         text     NOT NULL,
  sale_id           text,
  source_event_type text     NOT NULL,
  business_date     date,
  PRIMARY KEY (seq, line_no),
  CONSTRAINT postings_one_side CHECK ((debit = 0) <> (credit = 0))
);

CREATE INDEX postings_account ON business.postings (account_code, business_date);
CREATE INDEX postings_sale ON business.postings (sale_id) WHERE sale_id IS NOT NULL;

-- LG-2 as a database backstop: an event's postings must balance when the
-- transaction commits, whatever inserted them.
CREATE OR REPLACE FUNCTION business.check_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO d, c
    FROM business.postings WHERE seq = NEW.seq;
  IF d <> c THEN
    RAISE EXCEPTION 'unbalanced posting for seq %: debit % credit %', NEW.seq, d, c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER postings_balanced
  AFTER INSERT ON business.postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION business.check_balanced();

CREATE TABLE business.merkle_roots (
  day         date         NOT NULL,
  first_seq   bigint       NOT NULL,
  last_seq    bigint       NOT NULL,
  root        char(64)     NOT NULL,
  computed_at timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (day, last_seq)
);

CREATE TABLE business.accounts (
  code text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL
);

INSERT INTO business.accounts (code, name, type) VALUES
  ('1000', 'Bank', 'asset'),
  ('1100', 'Trade Receivables', 'asset'),
  ('1300', 'GST Input Credit', 'asset'),
  ('2000', 'Trade Payables', 'liability'),
  ('2100', 'CGST Output', 'liability'),
  ('2101', 'SGST Output', 'liability'),
  ('2102', 'IGST Output', 'liability'),
  ('2200', 'TCS Payable', 'liability'),
  ('4000', 'Sales Revenue', 'income'),
  ('4100', 'Sales Returns and Credit Notes', 'income_contra'),
  ('4200', 'Freight, Packing and Insurance Recovered', 'income'),
  ('4900', 'Round-off', 'income'),
  ('5000', 'Purchases', 'expense'),
  ('9000', 'Suspense', 'other');
