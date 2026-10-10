"""Read access to the business schema (events and postings).

Two sources share one interface:

* ``fixture:<dir>`` reads ``events.jsonl`` and ``postings.jsonl`` written by the
  generator's emulator. Used until the ledger core is available (PRD 27.4).
* ``postgresql://...`` reads ``business.events`` and ``business.postings``
  through the ``engine_audit`` role (contracts/events/read-model.md).

The engine never writes through either source (rule C-2).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import threading
from pathlib import Path
from typing import Iterator, Protocol


class BusinessStore(Protocol):
    def head(self) -> tuple[int, str]: ...
    def events(self, upto_seq: int | None = None, after_seq: int | None = None,
               types: tuple[str, ...] | None = None) -> Iterator[dict]: ...
    def postings(self, upto_seq: int | None = None) -> Iterator[dict]: ...


class FixtureBusinessStore:
    def __init__(self, directory: str | Path):
        self.dir = Path(directory)
        self._lock = threading.Lock()
        self._events: list[dict] = []
        self._postings: list[dict] = []
        self._stamp: tuple | None = None

    def _load(self) -> None:
        ev_path, po_path = self.dir / "events.jsonl", self.dir / "postings.jsonl"
        stamp = tuple(
            (p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else None for p in (ev_path, po_path)
        )
        with self._lock:
            if stamp == self._stamp:
                return
            self._events = _read_jsonl(ev_path)
            self._postings = _read_jsonl(po_path)
            self._events.sort(key=lambda e: e["seq"])
            self._stamp = stamp

    def head(self) -> tuple[int, str]:
        self._load()
        if not self._events:
            return 0, "0" * 64
        last = self._events[-1]
        return last["seq"], last["hash"]

    def events(self, upto_seq=None, after_seq=None, types=None) -> Iterator[dict]:
        self._load()
        for ev in self._events:
            if upto_seq is not None and ev["seq"] > upto_seq:
                break
            if after_seq is not None and ev["seq"] <= after_seq:
                continue
            if types is not None and ev["event_type"] not in types:
                continue
            yield ev

    def postings(self, upto_seq=None) -> Iterator[dict]:
        self._load()
        for p in self._postings:
            if upto_seq is not None and p["seq"] > upto_seq:
                continue
            yield p


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _iso(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        if v.tzinfo is not None:
            v = v.astimezone(dt.timezone.utc).replace(tzinfo=None)
        return v.strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(v, dt.date):
        return v.isoformat()
    return str(v)


class SqlBusinessStore:
    """Reads business.events and business.postings.

    Events in the shared catalogue shape (they carry aggregate_type) are translated
    into the engine's shape. Translation needs earlier events (an invoice number for
    a credit note's invoice_id), so the store keeps one translated, append-only copy
    of the chain and fetches only events newer than the last one it holds.
    """

    def __init__(self, url: str):
        from sqlalchemy import create_engine

        from ..catalogue import Translator

        self.engine = create_engine(url, pool_pre_ping=True)
        self._lock = threading.Lock()
        self._events: list[dict] = []
        self._translator = Translator()
        self._catalogue = self._has_column("events", "aggregate_type")
        self._account_col = "account_code" if self._has_column("postings", "account_code") else "account"

    def _has_column(self, table: str, column: str) -> bool:
        from sqlalchemy import text

        with self.engine.connect() as c:
            row = c.execute(text("SELECT 1 FROM information_schema.columns WHERE table_schema = 'business' "
                                 "AND table_name = :t AND column_name = :c"), {"t": table, "c": column}).first()
        return row is not None

    def head(self) -> tuple[int, str]:
        from sqlalchemy import text

        with self.engine.connect() as c:
            row = c.execute(text("SELECT seq, hash FROM business.events ORDER BY seq DESC LIMIT 1")).first()
        return (row[0], row[1].strip()) if row else (0, "0" * 64)

    def _sync(self) -> None:
        from sqlalchemy import text

        with self._lock:
            last = self._events[-1]["seq"] if self._events else 0
            extra = ", aggregate_type" if self._catalogue else ""
            sql = text(
                "SELECT seq, event_type, entity_id, aggregate_id, aggregate_version, sale_id, payload, business_date,"
                " recorded_at, identity_user, identity_role, idempotency_key, prev_hash, hash" + extra +
                " FROM business.events WHERE seq > :last ORDER BY seq")
            with self.engine.connect() as c:
                for r in c.execution_options(stream_results=True).execute(sql, {"last": last}):
                    payload = r.payload if isinstance(r.payload, dict) else json.loads(r.payload)
                    ev = {
                        "seq": r.seq, "event_type": r.event_type, "entity_id": r.entity_id,
                        "aggregate_id": r.aggregate_id, "aggregate_version": r.aggregate_version, "sale_id": r.sale_id,
                        "payload": payload, "business_date": _iso(r.business_date), "recorded_at": _iso(r.recorded_at),
                        "identity": {"user": r.identity_user, "role": r.identity_role},
                        "idempotency_key": r.idempotency_key, "prev_hash": r.prev_hash.strip(), "hash": r.hash.strip(),
                    }
                    if self._catalogue:
                        ev["aggregate_type"] = r.aggregate_type
                        ev = self._translator.translate(ev)
                    self._events.append(ev)

    def events(self, upto_seq=None, after_seq=None, types=None) -> Iterator[dict]:
        self._sync()
        for ev in list(self._events):
            if upto_seq is not None and ev["seq"] > upto_seq:
                break
            if after_seq is not None and ev["seq"] <= after_seq:
                continue
            if types is not None and ev["event_type"] not in types:
                continue
            yield ev

    @property
    def catalogue_format(self) -> bool:
        return self._catalogue

    def postings(self, upto_seq=None) -> Iterator[dict]:
        from sqlalchemy import text

        where = " WHERE seq <= :upto" if upto_seq is not None else ""
        sql = text(
            f"SELECT seq, line_no, entity_id, {self._account_col} AS account, debit, credit, sale_id, source_event_type,"
            " business_date FROM business.postings" + where + " ORDER BY seq, line_no"
        )
        with self.engine.connect() as c:
            for r in c.execute(sql, {"upto": upto_seq}):
                yield {
                    "seq": r.seq, "line_no": r.line_no, "entity_id": r.entity_id, "account": str(r.account),
                    "debit": int(r.debit), "credit": int(r.credit), "sale_id": r.sale_id,
                    "source_event_type": r.source_event_type, "business_date": _iso(r.business_date),
                }


def sql_url(url: str) -> str:
    """postgres:// and postgresql:// URLs as used by the other services, for SQLAlchemy with psycopg 3."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def open_business_store(source: str) -> BusinessStore:
    if source.startswith("fixture:"):
        return FixtureBusinessStore(source[len("fixture:"):])
    if source.startswith(("postgresql", "postgres", "sqlite")):
        return SqlBusinessStore(sql_url(source))
    if os.path.isdir(source):
        return FixtureBusinessStore(source)
    raise ValueError(f"Unrecognised business source: {source}")
