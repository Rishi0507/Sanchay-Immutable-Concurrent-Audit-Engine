"""Generation pipeline: world, plants, compile, register, load (SD-1 to SD-6)."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from audit_engine.chain import sha256_hex
from audit_engine.store.files import DirFileStore

from . import register
from .compile import Compiler
from .emulator import LocalLedger
from .world import CLIENT, FY_END, FY_START, UPLOAD_AT, World, utc


class FixtureSink:
    """Appends through the local ledger emulator and stores files by hash."""

    def __init__(self, out_dir: Path):
        self.out = Path(out_dir)
        self.ledger = LocalLedger()
        self.files = DirFileStore(self.out / "files")

    def put_file(self, data: bytes, name: str) -> str:
        return self.files.put(data)

    def append(self, intent: dict, idem: str) -> dict:
        return self.ledger.append(
            event_type=intent["event_type"], entity_id=intent["entity_id"], aggregate_id=intent["aggregate_id"],
            sale_id=intent["sale_id"], payload=intent["payload"], business_date=intent["business_date"],
            recorded_at=utc(intent["t"]), identity=CLIENT, idempotency_key=idem)

    def close(self) -> None:
        self.ledger.write(self.out / "fixture")


def build_world(dataset: str, seed: int, scale: float) -> tuple[World, Compiler, object]:
    planted = dataset == "planted"
    w = World(seed=seed, scale=scale, planted=planted)
    w.build_masters()
    planter = None
    if planted:
        from .planted import Planter

        planter = Planter(w)
        planter.parties()
    w.plan_regular_sales()
    if planter:
        planter.sales()
    w.guard_cutoff()
    w.settle_regular()
    w.regular_credit_notes()
    w.regular_purchases()
    w.regular_journals()
    w.assign_vehicles()
    if planter:
        planter.after_vehicles()
    c = Compiler(w)
    c.number_invoices()
    c.compile_masters()
    c.compile_sales()
    c.compile_credit_notes()
    c.compile_receipts()
    c.compile_purchases()
    c.compile_gstr1()
    c.compile_bank()
    c.compile_extra()
    if planter:
        planter.register()
    return w, c, planter


def generate(out_dir: str | Path, dataset: str = "clean", seed: int = 7, scale: float = 1.0, sink=None) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    w, c, planter = build_world(dataset, seed, scale)
    sink = sink or FixtureSink(out)

    rows = register.build_rows(w)
    reg_bytes = register.register_xlsx(rows)
    rp_bytes = register.related_party_csv(w.disclosed)
    uploads = out / "uploads"
    uploads.mkdir(exist_ok=True)
    (uploads / "sales_register_FY2025-26.xlsx").write_bytes(reg_bytes)
    (uploads / "related_parties.csv").write_bytes(rp_bytes)
    reg_hash = sink.put_file(reg_bytes, "sales_register_FY2025-26.xlsx")
    rp_hash = sink.put_file(rp_bytes, "related_parties.csv")
    c.emit(UPLOAD_AT, "SalesRegisterUploaded", f"upload:{reg_hash}",
           {"file_hash": reg_hash, "file_name": "sales_register_FY2025-26.xlsx", "row_count": len(rows),
            "period_start": FY_START.isoformat(), "period_end": FY_END.isoformat()}, UPLOAD_AT.date())
    c.emit(UPLOAD_AT + dt.timedelta(minutes=5), "RelatedPartyListUploaded", f"upload:{rp_hash}",
           {"file_hash": rp_hash, "file_name": "related_parties.csv", "parties": w.disclosed}, UPLOAD_AT.date())

    ordered = c.ordered()
    for i, intent in enumerate(ordered, 1):
        sink.append(intent, f"seed-{dataset}-{seed}-{i}")
    sink.close()

    answer = planter.answer_key() if planter else []
    meta = {"dataset": dataset, "seed": seed, "scale": scale, "events": len(ordered),
            "sales": len(w.sales), "customers": len(w.customers), "vendors": len(w.vendors),
            "register_rows": len(rows), "register_hash": reg_hash, "related_party_hash": rp_hash,
            "period_start": FY_START.isoformat(), "period_end": FY_END.isoformat()}
    # The answer key sits outside the fixture and file store, so no tool can read it (SD-5).
    (out / "answer_key.json").write_text(json.dumps({"meta": meta, "items": answer}, indent=2), encoding="utf-8")
    (out / "company.toml").write_text(company_toml(w), encoding="utf-8")
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def company_toml(w: World) -> str:
    lines = []
    for eid, c in w.company.items():
        lines.append(f"[entities.{eid}]")
        lines.append(f'name = "{c["name"]}"')
        lines.append(f'gstin = "{c["gstin"]}"')
        lines.append(f'pan = "{c["pan"]}"')
        lines.append(f'phone = "{c["phone"]}"')
        lines.append(f'email = "{c["email"]}"')
        a = c["address"]
        lines.append(f'address = {{ line1 = "{a["line1"]}", city = "{a["city"]}", state_code = "{a["state_code"]}", '
                     f'pincode = "{a["pincode"]}" }}')
        accts = ", ".join(f'"{b["account_no"]}"' for b in c["bank_accounts"])
        lines.append(f"bank_accounts = [{accts}]")
        lines.append("")
    return "\n".join(lines)
