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
    def __init__(self, url: str):
        from sqlalchemy import create_engine

        self.engine = create_engine(url, pool_pre_ping=True)

    def head(self) -> tuple[int, str]:
        from sqlalchemy import text

        with self.engine.connect() as c:
            row = c.execute(text("SELECT seq, hash FROM business.events ORDER BY seq DESC LIMIT 1")).first()
        return (row[0], row[1]) if row else (0, "0" * 64)

    def events(self, upto_seq=None, after_seq=None, types=None) -> Iterator[dict]:
        from sqlalchemy import bindparam, text

        clauses, params = [], {}
        if upto_seq is not None:
            clauses.append("seq <= :upto")
            params["upto"] = upto_seq
        if after_seq is not None:
            clauses.append("seq > :after")
            params["after"] = after_seq
        if types:
            clauses.append("event_type IN :types")
            params["types"] = list(types)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = text(
            "SELECT seq, event_type, entity_id, aggregate_id, aggregate_version, sale_id, payload, business_date,"
            " recorded_at, identity_user, identity_role, idempotency_key, prev_hash, hash FROM business.events"
            + where + " ORDER BY seq"
        )
        if types:
            sql = sql.bindparams(bindparam("types", expanding=True))
        with self.engine.connect() as c:
            for r in c.execution_options(stream_results=True).execute(sql, params):
                payload = r.payload if isinstance(r.payload, dict) else json.loads(r.payload)
                yield {
                    "seq": r.seq, "event_type": r.event_type, "entity_id": r.entity_id,
                    "aggregate_id": r.aggregate_id, "aggregate_version": r.aggregate_version, "sale_id": r.sale_id,
                    "payload": payload, "business_date": _iso(r.business_date), "recorded_at": _iso(r.recorded_at),
                    "identity": {"user": r.identity_user, "role": r.identity_role},
                    "idempotency_key": r.idempotency_key, "prev_hash": r.prev_hash, "hash": r.hash,
                }

    def postings(self, upto_seq=None) -> Iterator[dict]:
        from sqlalchemy import text

        where = " WHERE seq <= :upto" if upto_seq is not None else ""
        sql = text(
            "SELECT seq, line_no, entity_id, account, debit, credit, sale_id, source_event_type, business_date"
            " FROM business.postings" + where + " ORDER BY seq, line_no"
        )
        with self.engine.connect() as c:
            for r in c.execute(sql, {"upto": upto_seq}):
                yield {
                    "seq": r.seq, "line_no": r.line_no, "entity_id": r.entity_id, "account": str(r.account),
                    "debit": int(r.debit), "credit": int(r.credit), "sale_id": r.sale_id,
                    "source_event_type": r.source_event_type, "business_date": _iso(r.business_date),
                }


def open_business_store(source: str) -> BusinessStore:
    if source.startswith("fixture:"):
        return FixtureBusinessStore(source[len("fixture:"):])
    if source.startswith(("postgresql", "postgres", "sqlite")):
        return SqlBusinessStore(source.replace("postgres://", "postgresql+psycopg://", 1)
                                if source.startswith("postgres://") else source)
    if os.path.isdir(source):
        return FixtureBusinessStore(source)
    raise ValueError(f"Unrecognised business source: {source}")
