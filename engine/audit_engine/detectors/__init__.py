"""Population-level detectors (PRD section 13) and the runner.

Each detector is a pure function of the engagement context (DT-2). They run
in parallel threads over the same frozen snapshot (DT-5) and their findings
are stored with stable IDs, so a second run adds nothing (DT-4).
"""

from __future__ import annotations

import importlib
import time
from concurrent.futures import ThreadPoolExecutor

REGISTRY = {
    "D-04": "cycles",
    "D-05": "movement",
    "D-06": "cutoff",
    "D-08": "tax",
    "D-09": "revenue",
    "D-11": "credit_notes",
    "D-07": "concentration",
    "D-12": "promotions",
    "D-13": "settlement",
    "D-14": "integrity_docs",
}


def detector(det_id: str):
    return importlib.import_module(f"audit_engine.detectors.{REGISTRY[det_id]}").detect


def run_detectors(ctx, only: list[str] | None = None) -> dict:
    ids = [i for i in REGISTRY if not only or i in only]
    # Warm shared caches before threads start so that no detector writes to them concurrently.
    _ = ctx.revenue
    ctx.rp_tags()
    from .common import period_invoices

    period_invoices(ctx)
    from ..graph import build_graph
    from ..related_parties import resolve

    resolve(ctx)
    build_graph(ctx)

    def run(det_id):
        t = time.perf_counter()
        found = detector(det_id)(ctx)
        return det_id, found, round(time.perf_counter() - t, 3)

    workers = ctx.engine.settings.detector_workers or min(8, len(ids))
    results = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for det_id, found, secs in pool.map(run, ids):
            results[det_id] = (found, secs)
    all_findings = [f for det_id in ids for f in results[det_id][0]]
    ctx.engine.save_findings(all_findings)
    indicators = {}
    from .indicators import compute_indicators

    indicators = compute_indicators(ctx)
    return {"by_detector": {k: len(v[0]) for k, v in results.items()},
            "seconds": {k: v[1] for k, v in results.items()},
            "findings_raised": len(all_findings), "indicators": indicators}
