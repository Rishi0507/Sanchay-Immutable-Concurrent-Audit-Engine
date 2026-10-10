-- Audit schema baseline (PRD sections 10 to 15). Written only by the audit
-- engine. The MCP server and the UI read these tables; their columns are the
-- shared contract in contracts/. Rows are never updated: a status change is a
-- new row (FN-3), and the current state is read through the views below.

CREATE TABLE audit.engagements (
  engagement_id text         PRIMARY KEY,
  entity_ids    text[]       NOT NULL,
  period_start  date         NOT NULL,
  period_end    date         NOT NULL,
  seed          text         NOT NULL,
  snapshot_seq  bigint       NOT NULL,
  snapshot_hash char(64)     NOT NULL,
  merkle_root   char(64),
  opened_by     text         NOT NULL,
  opened_at     timestamptz  NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE TABLE audit.engagement_steps (
  engagement_id text         NOT NULL REFERENCES audit.engagements,
  step          text         NOT NULL,
  completed_by  text         NOT NULL,
  completed_at  timestamptz  NOT NULL DEFAULT now(),
  detail        jsonb        NOT NULL DEFAULT '{}',
  PRIMARY KEY (engagement_id, step, completed_at)
);

CREATE TABLE audit.register_rows (
  engagement_id text    NOT NULL REFERENCES audit.engagements,
  row_no        integer NOT NULL,
  raw           jsonb   NOT NULL,
  parsed        jsonb   NOT NULL DEFAULT '{}',
  PRIMARY KEY (engagement_id, row_no)
);

CREATE TABLE audit.register_status (
  engagement_id text    NOT NULL,
  row_no        integer NOT NULL,
  rp_tag        text,
  suggested_rp  text,
  recon_status  text,
  finding_ids   text[]  NOT NULL DEFAULT '{}',
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, row_no, recorded_at),
  FOREIGN KEY (engagement_id, row_no) REFERENCES audit.register_rows
);

CREATE TABLE audit.samples (
  sample_id     text    PRIMARY KEY,
  engagement_id text    NOT NULL REFERENCES audit.engagements,
  sheet         text    NOT NULL CHECK (sheet IN ('sales_tod', 'cutoff_tod', 'credit_note_tod')),
  position      integer NOT NULL,
  subject_type  text    NOT NULL,
  subject_id    text    NOT NULL,
  sale_id       text,
  reason_codes  text[]  NOT NULL,
  reason        text    NOT NULL,
  detail        jsonb   NOT NULL DEFAULT '{}',
  selected_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, sheet, position),
  UNIQUE (engagement_id, sheet, subject_id)
);

CREATE TABLE audit.sample_tests (
  sample_id   text NOT NULL REFERENCES audit.samples,
  test        text NOT NULL,
  result      text NOT NULL CHECK (result IN ('Pass', 'Exception', 'Pending evidence', 'Needs human review', 'Changed after testing')),
  detail      jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sample_id, test, recorded_at)
);

CREATE TABLE audit.evidence_requests (
  request_id    text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES audit.engagements,
  sample_id     text NOT NULL REFERENCES audit.samples,
  document_type text NOT NULL,
  note          text,
  requested_by  text NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sample_id, document_type)
);

CREATE TABLE audit.evidence_results (
  sample_id     text NOT NULL REFERENCES audit.samples,
  document_type text NOT NULL,
  file_hash     char(64) NOT NULL,
  evidence_seq  bigint NOT NULL,
  extracted     jsonb NOT NULL DEFAULT '{}',
  checks        jsonb NOT NULL DEFAULT '{}',
  verified_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sample_id, document_type, evidence_seq)
);

CREATE TABLE audit.findings (
  finding_id          text PRIMARY KEY,
  engagement_id       text NOT NULL REFERENCES audit.engagements,
  detector_id         text NOT NULL,
  category            text NOT NULL,
  subtype             text,
  severity            text NOT NULL CHECK (severity IN ('High', 'Medium', 'Low')),
  title               text NOT NULL,
  subject_type        text NOT NULL,
  subject_id          text NOT NULL,
  amount_impact       bigint NOT NULL DEFAULT 0,
  period_effect       text NOT NULL DEFAULT 'None' CHECK (period_effect IN ('Overstated', 'Understated', 'None')),
  proposed_adjustment jsonb NOT NULL DEFAULT '[]',
  standard_refs       text[] NOT NULL DEFAULT '{}',
  lineage             jsonb NOT NULL DEFAULT '{}',
  reason              text NOT NULL,
  sample_ids          text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX findings_engagement ON audit.findings (engagement_id, category, severity);

CREATE TABLE audit.finding_decisions (
  finding_id text NOT NULL REFERENCES audit.findings,
  decision   text NOT NULL CHECK (decision IN ('confirmed', 'rejected', 'needs_info')),
  note       text,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (finding_id, decided_at)
);

CREATE TABLE audit.outputs (
  engagement_id text NOT NULL REFERENCES audit.engagements,
  kind          text NOT NULL CHECK (kind IN ('workpaper', 'memo_docx', 'memo_md', 'trail')),
  file_hash     char(64) NOT NULL,
  file_name     text NOT NULL,
  head_hash     char(64),
  produced_by   text NOT NULL,
  produced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, kind, produced_at)
);

CREATE TABLE audit.sign_offs (
  engagement_id text PRIMARY KEY REFERENCES audit.engagements,
  signed_by     text NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  note          text
);

-- FN-4: the current status is the latest decision, or 'proposed'.
CREATE VIEW audit.v_findings AS
SELECT f.*,
       coalesce(d.decision, 'proposed') AS status,
       d.decided_by,
       d.decided_at,
       d.note AS decision_note
FROM audit.findings f
LEFT JOIN LATERAL (
  SELECT decision, decided_by, decided_at, note
  FROM audit.finding_decisions fd
  WHERE fd.finding_id = f.finding_id
  ORDER BY decided_at DESC
  LIMIT 1
) d ON true;

CREATE VIEW audit.v_sample_tests AS
SELECT DISTINCT ON (sample_id, test) sample_id, test, result, detail, recorded_at
FROM audit.sample_tests
ORDER BY sample_id, test, recorded_at DESC;

CREATE VIEW audit.v_register AS
SELECT r.engagement_id, r.row_no, r.raw, r.parsed,
       s.rp_tag, s.suggested_rp, s.recon_status,
       coalesce(s.finding_ids, '{}') AS finding_ids
FROM audit.register_rows r
LEFT JOIN LATERAL (
  SELECT rp_tag, suggested_rp, recon_status, finding_ids
  FROM audit.register_status rs
  WHERE rs.engagement_id = r.engagement_id AND rs.row_no = r.row_no
  ORDER BY recorded_at DESC
  LIMIT 1
) s ON true;
