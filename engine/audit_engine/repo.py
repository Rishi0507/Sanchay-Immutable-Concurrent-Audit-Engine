"""The ``audit`` schema (PRD section 4.4), written only by the engine (rule C-3).

Every table is insert-only because ``UPDATE`` and ``DELETE`` are blocked by
triggers on every table (L4). Current state is always the latest row for a
key. The same code runs on Postgres (schema ``audit``) and on SQLite for local
development and tests (no schema).
"""

from __future__ import annotations

import datetime as dt
import json
from typing import Any, Iterable

from sqlalchemy import (JSON, BigInteger, Column, Date, Integer, MetaData, String, Table, Text, create_engine, event,
                        select)
from sqlalchemy.engine import Engine

metadata = MetaData(schema="audit")


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


engagements = Table(
    "eng_engagements", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("client_name", Text),
    Column("period_start", Date, nullable=False),
    Column("period_end", Date, nullable=False),
    Column("seed", String(128), nullable=False),
    Column("entity_ids", JSON),
    Column("snapshot_seq", BigInteger, nullable=False),
    Column("snapshot_hash", String(64), nullable=False),
    Column("merkle_root", String(64)),
    Column("register_upload_seq", BigInteger),
    Column("rp_upload_seq", BigInteger),
    Column("opened_by", Text),
    Column("opened_at", String(32)),
)

engagement_events = Table(
    "eng_engagement_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("kind", String(32), nullable=False),  # step_done, closed
    Column("step", String(64)),
    Column("detail", JSON),
    Column("identity", Text),
    Column("at", String(32)),
)

register_imports = Table(
    "eng_register_imports", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("file_hash", String(64), nullable=False),
    Column("file_name", Text),
    Column("upload_seq", BigInteger),
    Column("headers", JSON),
    Column("column_map", JSON),
    Column("missing_columns", JSON),
    Column("row_count", Integer),
    Column("at", String(32)),
)

register_rows = Table(
    "eng_register_rows", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("row_no", Integer, primary_key=True),
    Column("raw", JSON, nullable=False),
    Column("parsed", JSON, nullable=False),
)

register_recon = Table(
    "eng_register_recon", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("row_no", Integer, primary_key=True),
    Column("status", Text, nullable=False),
    Column("finding_refs", JSON),
)

rp_tags = Table(
    "eng_rp_tags", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("customer_id", String(128), primary_key=True),
    Column("tag", String(32), nullable=False),
    Column("detail", JSON),
)

samples = Table(
    "eng_samples", metadata,
    Column("sample_id", String(64), primary_key=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("sheet", String(32), nullable=False),
    Column("position", Integer, nullable=False),
    Column("subject_type", String(32), nullable=False),
    Column("subject_id", String(128), nullable=False),
    Column("reason", Text),
    Column("reason_codes", JSON),
    Column("score", Integer),
    Column("data", JSON),
)

sample_meta = Table(
    "eng_sample_meta", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("sheet", String(32), primary_key=True),
    Column("detail", JSON),
)

sample_tests = Table(
    "eng_sample_tests", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("sample_id", String(64), nullable=False, index=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("tests", JSON, nullable=False),
    Column("flags", JSON),
    Column("cause", Text),
    Column("at", String(32)),
)

evidence_requests = Table(
    "eng_evidence_requests", metadata,
    Column("request_id", String(64), primary_key=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("sample_id", String(64), nullable=False),
    Column("document_type", String(32), nullable=False),
    Column("note", Text),
    Column("created_by", Text),
    Column("created_at", String(32)),
)

# Requests for a document that the records say does not exist (PRD 14.4). They
# sit beside the ordinary requests and are never shown to the client as different.
control_requests = Table(
    "eng_control_requests", metadata,
    Column("request_id", String(64), primary_key=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("sample_id", String(64), nullable=False),
    Column("document_type", String(32), nullable=False),
    Column("basis", Text),
    Column("created_at", String(32)),
)

# The sealed sampling seed of a register upload (PRD 12.5): a secret fixed when
# the register arrives, of which only the hash is given out until an engagement opens.
sampling_seals = Table(
    "eng_sampling_seals", metadata,
    Column("register_upload_seq", BigInteger, primary_key=True, autoincrement=False),
    Column("commitment", String(64), nullable=False),
    Column("nonce", String(64), nullable=False),
    Column("sealed_when", String(16), nullable=False),
    Column("sealed_at", String(32)),
)

evidence_results = Table(
    "eng_evidence_results", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("request_id", String(64), nullable=False),
    Column("sample_id", String(64), nullable=False),
    Column("upload_seq", BigInteger, nullable=False),
    Column("file_hash", String(64), nullable=False),
    Column("extracted", JSON),
    Column("checks", JSON),
    Column("at", String(32)),
)

extraction_cache = Table(
    "eng_extraction_cache", metadata,
    Column("file_hash", String(64), primary_key=True),
    Column("document_type", String(32), primary_key=True),
    Column("result", JSON),
)

findings = Table(
    "eng_findings", metadata,
    Column("finding_id", String(32), primary_key=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("detector_id", String(8), nullable=False),
    Column("category", String(40), nullable=False),
    Column("severity", String(8), nullable=False),
    Column("record", JSON, nullable=False),
    Column("created_at", String(32)),
)

finding_decisions = Table(
    "eng_finding_decisions", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("finding_id", String(32), nullable=False, index=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("decision", String(16), nullable=False),
    Column("note", Text),
    Column("identity", Text),
    Column("role", String(32)),
    Column("at", String(32)),
)

change_matches = Table(
    "eng_change_matches", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("seq", BigInteger, primary_key=True),
    Column("detail", JSON),
)

indicators = Table(
    "eng_indicators", metadata,
    Column("engagement_id", String(64), primary_key=True),
    Column("subject_id", String(128), primary_key=True),
    Column("detail", JSON),
)

outputs = Table(
    "eng_outputs", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("engagement_id", String(64), nullable=False, index=True),
    Column("kind", String(16), nullable=False),
    Column("file_hash", String(64), nullable=False),
    Column("path", Text),
    Column("head_hash", String(64)),
    Column("at", String(32)),
)


# The shared audit tables (db/migrations/004_audit.sql) that the MCP server reads.
# The engine keeps its own working tables above and mirrors these rows into them.
SHARED_ENGAGEMENT_SQL = (
    "INSERT INTO audit.engagements (engagement_id, entity_ids, period_start, period_end, seed, snapshot_seq, "
    "snapshot_hash, merkle_root, opened_by) VALUES (:engagement_id, :entity_ids, :period_start, :period_end, :seed, "
    ":snapshot_seq, :snapshot_hash, :merkle_root, :opened_by) ON CONFLICT (engagement_id) DO NOTHING")
SHARED_SIGN_OFF_SQL = (
    "INSERT INTO audit.sign_offs (engagement_id, signed_by, note) VALUES (:engagement_id, :signed_by, :note) "
    "ON CONFLICT (engagement_id) DO NOTHING")


class AuditRepo:
    def __init__(self, url: str):
        from .store.business import sql_url

        url = sql_url(url)
        self.url = url
        self.is_sqlite = url.startswith("sqlite")
        if self.is_sqlite and url.startswith("sqlite:///") and not url.startswith("sqlite:///:memory:"):
            from pathlib import Path

            Path(url[len("sqlite:///"):]).parent.mkdir(parents=True, exist_ok=True)
        kwargs: dict[str, Any] = {}
        if self.is_sqlite:
            kwargs["connect_args"] = {"check_same_thread": False}
        self.engine: Engine = create_engine(url, **kwargs).execution_options(
            schema_translate_map={"audit": None} if self.is_sqlite else None)
        if self.is_sqlite:
            @event.listens_for(self.engine, "connect")
            def _pragma(conn, _):
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA busy_timeout=10000")
                cur.close()

    def create_all(self) -> None:
        """Create tables if they do not exist. On Postgres the migrations in db/ are authoritative."""
        if not self.is_sqlite:
            from sqlalchemy import text
            from sqlalchemy.exc import DBAPIError

            try:
                with self.engine.begin() as c:
                    c.execute(text("CREATE SCHEMA IF NOT EXISTS audit"))
            except DBAPIError:
                pass  # The schema exists already; the engine role may not create schemas.
            try:
                metadata.create_all(self.engine, checkfirst=True)
                self._postgres_append_only()
            except DBAPIError:
                pass  # No CREATE on the schema: the migrations in db/ own the tables.
            return
        metadata.create_all(self.engine)
        if self.is_sqlite:
            self._sqlite_append_only()

    def _postgres_append_only(self) -> None:
        """L4 for the engine's own tables: UPDATE and DELETE raise, as on every other table."""
        from sqlalchemy import text

        with self.engine.begin() as c:
            c.execute(text(
                "CREATE OR REPLACE FUNCTION audit.eng_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN RAISE EXCEPTION '% on %.% is not allowed: append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME; END $$"))
            for t in metadata.sorted_tables:
                exists = c.execute(text("SELECT 1 FROM pg_trigger WHERE tgname = :n"), {"n": f"{t.name}_append_only"}).first()
                if not exists:
                    c.execute(text(f"CREATE TRIGGER {t.name}_append_only BEFORE UPDATE OR DELETE ON audit.{t.name} "
                                   f"FOR EACH ROW EXECUTE FUNCTION audit.eng_forbid_change()"))

    def _sqlite_append_only(self) -> None:
        """Mirror the L4 triggers on SQLite so local tests catch accidental updates."""
        from sqlalchemy import text

        with self.engine.begin() as c:
            for t in metadata.sorted_tables:
                for op in ("UPDATE", "DELETE"):
                    c.execute(text(
                        f"CREATE TRIGGER IF NOT EXISTS {t.name}_no_{op.lower()} BEFORE {op} ON {t.name} "
                        f"BEGIN SELECT RAISE(ABORT, '{t.name} is append-only'); END"))

    # Generic helpers

    def insert(self, table: Table, rows: dict | Iterable[dict], ignore_conflicts: bool = True) -> int:
        rows = [rows] if isinstance(rows, dict) else list(rows)
        if not rows:
            return 0
        if self.is_sqlite:
            from sqlalchemy.dialects.sqlite import insert as dialect_insert
        else:
            from sqlalchemy.dialects.postgresql import insert as dialect_insert
        stmt = dialect_insert(table)
        if ignore_conflicts and table.primary_key.columns and not _autoinc(table):
            stmt = stmt.on_conflict_do_nothing()
        inserted = 0
        with self.engine.begin() as c:
            for i in range(0, len(rows), 500):
                res = c.execute(stmt, rows[i:i + 500])
                inserted += max(res.rowcount or 0, 0)
        return inserted

    def select(self, table: Table, order_by=None, **eq) -> list[dict]:
        stmt = select(table)
        for k, v in eq.items():
            stmt = stmt.where(table.c[k] == v)
        if order_by is not None:
            stmt = stmt.order_by(*(order_by if isinstance(order_by, (list, tuple)) else [order_by]))
        with self.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(stmt)]

    def first(self, table: Table, **eq) -> dict | None:
        rows = self.select(table, **eq)
        return rows[0] if rows else None

    # Shared tables

    def mirror(self, sql: str, params: dict) -> bool:
        """Write a row the other services read. Skipped where the shared schema does not exist (tests)."""
        if self.is_sqlite:
            return False
        from sqlalchemy import text

        with self.engine.begin() as c:
            exists = c.execute(text("SELECT to_regclass('audit.engagements')")).scalar()
            if not exists:
                return False
            c.execute(text(sql), params)
        return True

    # Engagements

    def open_engagements(self) -> list[dict]:
        closed = {r["engagement_id"] for r in self.select(engagement_events, kind="closed")}
        return [e for e in self.select(engagements, order_by=engagements.c.opened_at)
                if e["engagement_id"] not in closed]

    def is_closed(self, engagement_id: str) -> bool:
        return bool(self.select(engagement_events, engagement_id=engagement_id, kind="closed"))

    def mark_step(self, engagement_id: str, step: str, detail: dict | None = None, identity: str | None = None):
        self.insert(engagement_events, {"engagement_id": engagement_id, "kind": "step_done", "step": step,
                                        "detail": detail or {}, "identity": identity, "at": _now()})

    def steps_done(self, engagement_id: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for r in self.select(engagement_events, order_by=engagement_events.c.id, engagement_id=engagement_id,
                             kind="step_done"):
            out[r["step"]] = r
        return out

    # Findings

    def add_findings(self, records: list[dict]) -> int:
        rows = [{"finding_id": f["finding_id"], "engagement_id": f["engagement_id"], "detector_id": f["detector_id"],
                 "category": f["category"], "severity": f["severity"], "record": f, "created_at": f["created_at"]}
                for f in records]
        return self.insert(findings, rows)

    def findings(self, engagement_id: str) -> list[dict]:
        decisions = self.latest_decisions(engagement_id)
        out = []
        for r in self.select(findings, order_by=findings.c.finding_id, engagement_id=engagement_id):
            rec = dict(r["record"])
            dec = decisions.get(rec["finding_id"])
            rec["status"] = dec["decision"] if dec else "proposed"
            rec["decided_by"] = dec["identity"] if dec else None
            out.append(rec)
        return out

    def latest_decisions(self, engagement_id: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for r in self.select(finding_decisions, order_by=finding_decisions.c.id, engagement_id=engagement_id):
            out[r["finding_id"]] = r
        return out

    # Samples

    def latest_tests(self, engagement_id: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for r in self.select(sample_tests, order_by=sample_tests.c.id, engagement_id=engagement_id):
            out[r["sample_id"]] = r
        return out


def postgres_ddl() -> str:
    """DDL for the audit schema with append-only triggers (L4), for the migrations in db/."""
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.schema import CreateIndex, CreateTable

    dialect = postgresql.dialect()
    parts = ["CREATE SCHEMA IF NOT EXISTS audit;", "",
             "CREATE OR REPLACE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$",
             "BEGIN RAISE EXCEPTION '% on %.% is not allowed: append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME; END $$;",
             ""]
    for t in metadata.sorted_tables:
        parts.append(str(CreateTable(t).compile(dialect=dialect)).strip() + ";")
        for ix in t.indexes:
            parts.append(str(CreateIndex(ix).compile(dialect=dialect)).strip() + ";")
        parts.append(f"CREATE TRIGGER {t.name}_append_only BEFORE UPDATE OR DELETE ON audit.{t.name} "
                     f"FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();")
        parts.append("")
    parts.append("GRANT USAGE ON SCHEMA audit TO engine_audit, mcp_read;")
    parts.append("GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA audit TO engine_audit;")
    parts.append("GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO engine_audit;")
    parts.append("GRANT SELECT ON ALL TABLES IN SCHEMA audit TO mcp_read;")
    return "\n".join(parts) + "\n"


def _autoinc(table: Table) -> bool:
    return any(c.autoincrement is True for c in table.primary_key.columns)


def dumps(v: Any) -> str:
    return json.dumps(v, sort_keys=True, default=str)
