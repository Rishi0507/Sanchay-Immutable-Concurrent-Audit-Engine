"""Engine service core: engagements, snapshot context, plan and automatic prerequisites."""

from __future__ import annotations

import datetime as dt
import hashlib
import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

from . import chain
from .config import Settings, load_thresholds
from .findings import make_finding
from .repo import AuditRepo, engagements
from .snapshot import Snapshot, d
from .store import open_business_store, open_file_store


class EngineError(Exception):
    STATUS = {"PERMISSION_DENIED": 403, "NO_ENGAGEMENT": 409, "NOT_FOUND": 404, "VALIDATION_FAILED": 422,
              "EVIDENCE_PENDING": 409, "MISSING_UPLOAD": 409, "ENGAGEMENT_CLOSED": 409}

    def __init__(self, code: str, message: str, next_step: str = ""):
        super().__init__(message)
        self.code, self.message, self.next_step = code, message, next_step

    @property
    def status(self) -> int:
        return self.STATUS.get(self.code, 400)

    def body(self) -> dict:
        return {"code": self.code, "message": self.message, "next_step": self.next_step}


# Ordered audit plan (PRD 9.4). Each entry: step key, tool, purpose, prerequisites.
STEPS = [
    ("open_engagement", "open_engagement", "Freeze the snapshot for a period and seed.", []),
    ("import_register", "import_register", "Copy the client register into the workpaper as provided.",
     ["open_engagement"]),
    ("reconcile_register", "reconcile_register", "Compare register and system of record.", ["import_register"]),
    ("tag_related_parties", "tag_related_parties", "Tag customers and suggest undisclosed related parties.",
     ["open_engagement"]),
    ("run_detectors", "run_detectors", "Run population-level detectors on the snapshot.", ["tag_related_parties"]),
    ("select_sales_tod", "select_sales_tod", "Select 25 to 35 risk-weighted samples.",
     ["reconcile_register", "run_detectors"]),
    ("select_cutoff_tod", "select_cutoff_tod", "Select invoices around the period end.", ["run_detectors"]),
    ("select_credit_note_tod", "select_credit_note_tod", "Select credit notes, weighted after period end.",
     ["tag_related_parties", "run_detectors"]),
    ("get_evidence_status", "get_evidence_status", "See which requested documents are uploaded.", []),
    ("verify_evidence", "verify_evidence", "Test uploaded evidence.", []),
    ("check_post_testing_changes", "check_post_testing_changes", "List client changes after the snapshot.", []),
    ("verify_ledger_integrity", "verify_ledger_integrity", "Recompute both chains.", []),
    ("get_findings", "get_findings", "Review findings.", []),
    ("explain_finding", "explain_finding", "Lineage and reason for one finding.", []),
    ("draft_findings_memo", "draft_findings_memo", "Produce the findings memo.", []),
    ("export_workpaper", "export_workpaper", "Produce the .xlsx workpaper.", []),
]
STEP_KEYS = [s[0] for s in STEPS]


@dataclass
class Ctx:
    engine: "Engine"
    eng: dict
    snap: Snapshot
    th: dict
    identity: dict = field(default_factory=dict)
    cache: dict = field(default_factory=dict)

    @property
    def eid(self) -> str:
        return self.eng["engagement_id"]

    @property
    def start(self) -> dt.date:
        v = self.eng["period_start"]
        return v if isinstance(v, dt.date) else d(v)

    @property
    def end(self) -> dt.date:
        v = self.eng["period_end"]
        return v if isinstance(v, dt.date) else d(v)

    @property
    def entities(self) -> set[str] | None:
        return set(self.eng["entity_ids"]) if self.eng.get("entity_ids") else None

    def in_scope(self, doc: dict) -> bool:
        ents = self.entities
        return not ents or doc.get("_entity_id") in ents

    def in_period(self, day: dt.date | str | None) -> bool:
        day = d(day) if isinstance(day, str) else day
        return day is not None and self.start <= day <= self.end

    @property
    def revenue(self) -> int:
        if "revenue" not in self.cache:
            self.cache["revenue"] = sum(i.get("taxable_value") or 0
                                        for i in self.snap.invoices_in_period(self.start, self.end, self.entities))
        return self.cache["revenue"]

    @property
    def snapshot_date(self) -> dt.date:
        ev = self.snap.events[-1] if self.snap.events else None
        return d(ev["recorded_at"]) if ev else self.end

    def finding(self, **kw) -> dict:
        return make_finding(engagement_id=self.eid, revenue=self.revenue, severity_cfg=self.th["severity"], **kw)

    def rp_tags(self) -> dict[str, dict]:
        from .repo import rp_tags

        if "rp_tags" not in self.cache:
            self.cache["rp_tags"] = {r["customer_id"]: r for r in self.engine.repo.select(rp_tags, engagement_id=self.eid)}
        return self.cache["rp_tags"]

    def is_related(self, customer_id: str | None, on: dt.date | None = None) -> str | None:
        """Return 'disclosed', 'suggested' or None for a sale dated ``on`` (RP-2)."""
        tag = self.rp_tags().get(customer_id or "")
        if not tag or tag["tag"] == "non_related":
            return None
        det = tag.get("detail") or {}
        for kind in ("disclosed", "suggested"):
            since = d(det.get(f"{kind}_from"))
            if det.get(f"{kind}_from") and (on is None or since is None or on >= since):
                return kind
        return None

    def disclosed(self, customer_id: str | None) -> bool:
        tag = self.rp_tags().get(customer_id or "")
        return bool(tag and (tag.get("detail") or {}).get("disclosed_from"))


class Engine:
    def __init__(self, settings: Settings | None = None, business=None, files=None, repo: AuditRepo | None = None):
        self.settings = settings or Settings.from_env()
        self.business = business or open_business_store(self.settings.business_source)
        self.files = files or open_file_store(self.settings.files)
        self.repo = repo or AuditRepo(self.settings.audit_db_url)
        self.repo.create_all()
        self.th = load_thresholds()
        self._snapshots: OrderedDict[int, Snapshot] = OrderedDict()
        self._lock = threading.RLock()
        self._step_locks: dict[tuple[str, str], threading.Lock] = {}

    # Snapshots

    def snapshot(self, seq: int) -> Snapshot:
        with self._lock:
            if seq in self._snapshots:
                self._snapshots.move_to_end(seq)
                return self._snapshots[seq]
        snap = Snapshot(self.business.events(upto_seq=seq), self.business.postings(upto_seq=seq), seq,
                        company=self.company_profile())
        with self._lock:
            self._snapshots[seq] = snap
            while len(self._snapshots) > 3:
                self._snapshots.popitem(last=False)
        return snap

    def company_profile(self) -> dict:
        """Company and group entity identifiers. From ENGINE_COMPANY_FILE, or the newest company.toml in the file store."""
        if self.settings.company:
            return self.settings.company
        root = getattr(self.files, "root", None)
        if root is None:
            return {}
        import json
        import tomllib

        best = None
        for meta in root.glob("*/*.json"):
            try:
                m = json.loads(meta.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if m.get("file_name") == "company.toml" and (best is None or meta.stat().st_mtime > best[0]):
                best = (meta.stat().st_mtime, m["file_hash"])
        if best:
            try:
                return tomllib.loads(self.files.get(best[1]).decode("utf-8"))
            except Exception:
                return {}
        return {}

    # Engagements

    def resolve(self, engagement_id: str | None) -> dict:
        if engagement_id:
            eng = self.repo.first(engagements, engagement_id=engagement_id)
            if not eng:
                raise EngineError("NOT_FOUND", f"Engagement {engagement_id} does not exist.",
                                  "Call get_engagement_status with no engagement_id to see open engagements.")
            return eng
        open_ = self.repo.open_engagements()
        if not open_:
            raise EngineError("NO_ENGAGEMENT", "No engagement is open.",
                              "Call open_engagement with period_start and period_end.")
        if len(open_) > 1:
            ids = ", ".join(e["engagement_id"] for e in open_)
            raise EngineError("NO_ENGAGEMENT", f"Several engagements are open: {ids}.",
                              "Pass engagement_id.")
        return open_[0]

    def ctx(self, engagement_id: str | None = None, identity: dict | None = None,
            allow_closed: bool = True) -> Ctx:
        eng = self.resolve(engagement_id)
        if not allow_closed and self.repo.is_closed(eng["engagement_id"]):
            raise EngineError("ENGAGEMENT_CLOSED", "The engagement is signed off.", "Open a new engagement.")
        return Ctx(self, eng, self.snapshot(eng["snapshot_seq"]), self.th, identity or {})

    def open_engagement(self, period_start: str, period_end: str, seed: str | None = None,
                        entity_ids: list[str] | None = None, client_name: str | None = None,
                        identity: dict | None = None) -> dict:
        ps, pe = d(period_start), d(period_end)
        if not ps or not pe or ps > pe:
            raise EngineError("VALIDATION_FAILED", "period_start and period_end must be dates with start <= end.",
                              "Pass dates as YYYY-MM-DD.")
        head_seq, head_hash = self.business.head()
        if head_seq == 0:
            raise EngineError("MISSING_UPLOAD", "The business chain is empty.",
                              "Ask the client to record the business and upload the register.")
        uploads = list(self.business.events(upto_seq=head_seq,
                                            types=("SalesRegisterUploaded", "RelatedPartyListUploaded")))
        reg = [e for e in uploads if e["event_type"] == "SalesRegisterUploaded"]
        rpl = [e for e in uploads if e["event_type"] == "RelatedPartyListUploaded"]
        missing = [n for n, lst in (("sales register (upload_sales_register)", reg),
                                    ("related-party list (upload_related_parties)", rpl)) if not lst]
        if missing:
            raise EngineError("MISSING_UPLOAD", "Missing client upload: " + " and ".join(missing) + ".",
                              "Ask the client to upload it, then call open_engagement again.")
        if not entity_ids:
            entity_ids = [reg[-1]["entity_id"]]
        seed = str(seed) if seed not in (None, "") else secrets.token_hex(8)
        raw = f"{ps}|{pe}|{','.join(sorted(entity_ids))}|{head_seq}|{seed}"
        eid = "eng_" + hashlib.sha256(raw.encode()).hexdigest()[:16]
        existing = self.repo.first(engagements, engagement_id=eid)
        if existing:
            return self._engagement_view(existing)
        leaves = [e["hash"] for e in self.business.events(upto_seq=head_seq)]
        row = {
            "engagement_id": eid, "client_name": client_name or self._client_name(entity_ids[0]),
            "period_start": ps, "period_end": pe, "seed": seed, "entity_ids": entity_ids,
            "snapshot_seq": head_seq, "snapshot_hash": head_hash, "merkle_root": chain.merkle_root(leaves),
            "register_upload_seq": reg[-1]["seq"], "rp_upload_seq": rpl[-1]["seq"],
            "opened_by": (identity or {}).get("user"),
            "opened_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        }
        self.repo.insert(engagements, row)
        from .repo import SHARED_ENGAGEMENT_SQL

        self.repo.mirror(SHARED_ENGAGEMENT_SQL, {
            "engagement_id": eid, "entity_ids": list(entity_ids), "period_start": ps, "period_end": pe, "seed": seed,
            "snapshot_seq": head_seq, "snapshot_hash": head_hash, "merkle_root": row["merkle_root"],
            "opened_by": (identity or {}).get("user") or "engine"})
        self.repo.mark_step(eid, "open_engagement", {"snapshot_seq": head_seq}, (identity or {}).get("user"))
        return self._engagement_view(self.repo.first(engagements, engagement_id=eid))

    def _client_name(self, entity_id: str) -> str:
        prof = (self.company_profile().get("entities") or {}).get(entity_id) or {}
        return prof.get("name") or entity_id

    @staticmethod
    def _engagement_view(e: dict) -> dict:
        return {"engagement_id": e["engagement_id"], "client_name": e["client_name"],
                "period_start": str(e["period_start"]), "period_end": str(e["period_end"]), "seed": e["seed"],
                "entity_ids": e["entity_ids"], "snapshot_seq": e["snapshot_seq"], "snapshot_hash": e["snapshot_hash"],
                "merkle_root": e["merkle_root"]}

    # Steps and prerequisites (TC-6)

    def step_lock(self, eid: str, step: str) -> threading.Lock:
        with self._lock:
            return self._step_locks.setdefault((eid, step), threading.Lock())

    def run_step(self, ctx: Ctx, step: str, fn: Callable[[Ctx], dict], auto_ran: list[str] | None = None) -> dict:
        """Run a deterministic step once. A second call returns the stored result (SM-7, DT-4)."""
        auto_ran = auto_ran if auto_ran is not None else []
        for pre in dict((s[0], s[3]) for s in STEPS).get(step, []):
            if pre not in self.repo.steps_done(ctx.eid):
                self.run_step(ctx, pre, self.step_fn(pre), auto_ran)
                auto_ran.append(pre)
        with self.step_lock(ctx.eid, step):
            done = self.repo.steps_done(ctx.eid)
            if step in done:
                return dict(done[step]["detail"] or {}, already_done=True, auto_ran=auto_ran)
            result = fn(ctx)
            self.repo.mark_step(ctx.eid, step, result, ctx.identity.get("user"))
            ctx.cache.clear()
        return dict(result, auto_ran=auto_ran)

    def step_fn(self, step: str) -> Callable[[Ctx], dict]:
        import importlib

        table = {
            "import_register": "register_recon:import_register",
            "reconcile_register": "register_recon:reconcile_register",
            "tag_related_parties": "related_parties:tag_related_parties",
            "run_detectors": "detectors:run_detectors",
            "select_sales_tod": "sampling:select_sales_tod",
            "select_cutoff_tod": "sampling:select_cutoff_tod",
            "select_credit_note_tod": "sampling:select_credit_note_tod",
        }
        if step not in table:
            raise EngineError("VALIDATION_FAILED", f"{step} is not an automatic step.", "")
        module, fn = table[step].split(":")
        return getattr(importlib.import_module(f"audit_engine.{module}"), fn)

    def step(self, step: str, engagement_id: str | None = None, identity: dict | None = None) -> dict:
        ctx = self.ctx(engagement_id, identity, allow_closed=False)
        return self.run_step(ctx, step, self.step_fn(step))

    # Plan and status

    def plan(self, engagement_id: str | None = None) -> dict:
        try:
            eng = self.resolve(engagement_id)
        except EngineError as e:
            if e.code != "NO_ENGAGEMENT":
                raise
            eng = None
        done = self.repo.steps_done(eng["engagement_id"]) if eng else {}
        steps, next_tool = [], None
        for i, (key, tool, purpose, pre) in enumerate(STEPS):
            status = "done" if key in done else "pending"
            if status == "pending" and next_tool is None and key in (
                    "open_engagement", "import_register", "reconcile_register", "tag_related_parties",
                    "run_detectors", "select_sales_tod", "select_cutoff_tod", "select_credit_note_tod",
                    "verify_evidence", "check_post_testing_changes", "verify_ledger_integrity",
                    "draft_findings_memo", "export_workpaper"):
                next_tool = tool
            steps.append({"step": i, "tool": tool, "purpose": purpose, "status": status,
                          "requires": pre, "detail": (done.get(key) or {}).get("detail")})
        return {"engagement_id": eng["engagement_id"] if eng else None, "steps": steps, "next_tool": next_tool,
                "note": "Steps that depend on earlier deterministic steps run them automatically (TC-6)."}

    def status(self, engagement_id: str | None = None) -> dict:
        ctx = self.ctx(engagement_id)
        counts = {"High": 0, "Medium": 0, "Low": 0}
        for f in self.repo.findings(ctx.eid):
            counts[f["severity"]] += 1
        plan = self.plan(ctx.eid)
        return dict(self._engagement_view(ctx.eng),
                    steps_completed=[s["tool"] for s in plan["steps"] if s["status"] == "done"],
                    next_tool=plan["next_tool"], finding_counts=counts, closed=self.repo.is_closed(ctx.eid))

    # Findings helper

    def save_findings(self, records: list[dict]) -> int:
        return self.repo.add_findings(records)
