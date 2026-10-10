-- Trail chain: one entry per tool call by any identity (PRD section 16.4).
-- Written only by the ledger core.

CREATE TABLE trail.entries (
  trail_seq     bigint       PRIMARY KEY,
  ts            timestamptz  NOT NULL,
  identity_user text         NOT NULL,
  identity_role text         NOT NULL,
  tool          text         NOT NULL,
  args_hash     char(64)     NOT NULL,
  result_hash   char(64)     NOT NULL,
  status        text         NOT NULL,
  engagement_id text,
  prev_hash     char(64)     NOT NULL,
  hash          char(64)     NOT NULL,
  CONSTRAINT entries_hash UNIQUE (hash)
);

CREATE INDEX entries_engagement ON trail.entries (engagement_id, trail_seq);
CREATE INDEX entries_user ON trail.entries (identity_user, trail_seq);
