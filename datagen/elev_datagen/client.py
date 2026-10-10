"""Client-side operations in fixture mode: evidence uploads and changes after the snapshot.

Appends go through the local ledger emulator with the client identity, exactly
as the MCP client tools would append them (SD-9).
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from audit_engine.store.files import DirFileStore

from .emulator import LocalLedger
from .world import CLIENT


class FixtureClient:
    def __init__(self, dataset_dir: str | Path, start: dt.datetime = dt.datetime(2026, 7, 20, 10, 0)):
        self.dir = Path(dataset_dir)
        self.ledger = LocalLedger.load(self.dir / "fixture")
        self.files = DirFileStore(self.dir / "files")
        last = self.ledger.events[-1]["recorded_at"] if self.ledger.events else None
        last_ist = (dt.datetime.fromisoformat(last.rstrip("Z")) + dt.timedelta(hours=5, minutes=30)) if last else start
        self.clock = max(start, last_ist)
        self.n = len(self.ledger.events)

    def _tick(self, minutes: int = 3) -> dt.datetime:
        self.clock += dt.timedelta(minutes=minutes)
        return self.clock

    def append(self, event_type: str, aggregate_id: str, payload: dict, sale_id: str | None = None,
               business_date: str | None = None, entity_id: str = "E1") -> dict:
        t = self._tick()
        self.n += 1
        return self.ledger.append(
            event_type=event_type, entity_id=entity_id, aggregate_id=aggregate_id, sale_id=sale_id, payload=payload,
            business_date=business_date or t.date().isoformat(),
            recorded_at=(t - dt.timedelta(hours=5, minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ"), identity=CLIENT,
            idempotency_key=f"client-{t.isoformat()}-{self.n}")

    def upload_evidence(self, sample_id: str, request_id: str, document_type: str, data: bytes, file_name: str) -> dict:
        h = self.files.put(data)
        return self.append("EvidenceUploaded", f"evidence:{h}:{request_id}:{self.n}",
                           {"sample_id": sample_id, "request_id": request_id, "document_type": document_type,
                            "file_hash": h, "file_name": file_name})

    def flush(self) -> None:
        self.ledger.write(self.dir / "fixture")
