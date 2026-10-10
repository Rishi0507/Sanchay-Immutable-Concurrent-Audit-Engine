"""Counterparty graph and cycles (PRD 13.4, D-04, get_counterparty_graph).

Nodes are resolved clusters (section 11.3), so a customer and a vendor under
common control are one node. Goods edges run seller to buyer, money edges payer
to payee. Cycles are searched separately in the goods graph and in the money
graph: strongly connected components (Tarjan) first, then elementary cycles
inside each component (Johnson) up to the configured length.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict

import networkx as nx

from .related_parties import resolve
from .snapshot import d, normalise_account


def build_graph(ctx) -> dict:
    key = ("graph", ctx.eid)
    if key in ctx.snap.cache:
        return ctx.snap.cache[key]
    res = resolve(ctx)
    recs, cluster_of = res["records"], res["cluster_of"]
    snap = ctx.snap
    window = dt.timedelta(days=ctx.th["d04"]["window_days"])
    lo, hi = ctx.start - window, ctx.end + window

    def node_of_party(kind: str, pid: str) -> str:
        k = f"{'C' if kind == 'customer' else 'V'}:{pid}"
        return cluster_of.get(k, k)

    def company_node(entity: str) -> str:
        k = f"CO:{entity}"
        return cluster_of.get(k, k)

    owners: dict[str, str] = {}
    for r in recs.values():
        for (kind, value) in r.obs:
            if kind == "bank":
                owners.setdefault(value, r.key)

    txns: list[dict] = []

    def add(kind, src, dst, value, day, doc, seq):
        if day is None or not (lo <= day <= hi) or src == dst:
            return
        txns.append({"type": kind, "from": src, "to": dst, "value": int(value), "date": day.isoformat(),
                     "doc": doc, "seq": seq})

    for inv in snap.invoices:
        if inv["_reversed"]:
            continue
        add("goods", company_node(inv["_entity_id"]), node_of_party("customer", inv.get("customer_id")),
            inv.get("taxable_value") or 0, d(inv.get("invoice_date")), inv.get("invoice_no"), inv["_seq"])
    for p in snap.purchases:
        add("goods", node_of_party("vendor", p.get("vendor_id")), company_node(p["_entity_id"]),
            p.get("taxable_value") or 0, d(p.get("date")), p.get("purchase_id"), p["_seq"])
    for r in snap.receipts:
        acct = normalise_account(r.get("payer_account"))
        holder = owners.get(acct)
        src = cluster_of.get(holder, holder) if holder else node_of_party("customer", r.get("customer_id"))
        add("money", src, company_node(r["_entity_id"]), r.get("amount") or 0, d(r.get("date")),
            r.get("receipt_id"), r["_seq"])
    for p in snap.payments:
        acct = normalise_account(p.get("payee_account"))
        holder = owners.get(acct)
        dst = cluster_of.get(holder, holder) if holder else node_of_party("vendor", p.get("vendor_id"))
        add("money", company_node(p["_entity_id"]), dst, p.get("amount") or 0, d(p.get("date")),
            p.get("payment_id"), p["_seq"])

    company_nodes = {company_node(k[3:]) for k in recs if k.startswith("CO:")}
    labels = {}
    for root, members in res["clusters"].items():
        names = [recs[m].label for m in sorted(members, key=lambda m: (recs[m].kind != "company", m))]
        kinds = sorted({recs[m].kind for m in members})
        labels[root] = {"label": names[0] + (f" (+{len(names) - 1})" if len(names) > 1 else ""), "kinds": kinds,
                        "members": [{"key": m, "label": recs[m].label, "kind": recs[m].kind} for m in sorted(members)]}

    cycles = []
    th = ctx.th["d04"]
    for kind in ("goods", "money"):
        G = nx.DiGraph()
        by_edge = defaultdict(list)
        for t in txns:
            if t["type"] == kind:
                by_edge[(t["from"], t["to"])].append(t)
                G.add_edge(t["from"], t["to"])
        for comp in nx.strongly_connected_components(G):
            if len(comp) < 2 or not (comp & company_nodes):
                continue
            sub = G.subgraph(comp)
            for cyc in nx.simple_cycles(sub, length_bound=th["max_cycle_length"]):
                if not set(cyc) & company_nodes:
                    continue
                k = next(i for i, n in enumerate(cyc) if n in company_nodes)
                cyc = cyc[k:] + cyc[:k]
                edges = [(cyc[i], cyc[(i + 1) % len(cyc)]) for i in range(len(cyc))]
                combo = _best_combo([by_edge[e] for e in edges], th)
                if combo:
                    cycles.append({"type": kind, "nodes": cyc, "labels": [labels.get(n, {"label": n})["label"] for n in cyc],
                                   "edges": combo, "min_value": min(t["value"] for t in combo),
                                   "max_value": max(t["value"] for t in combo),
                                   "first_date": min(t["date"] for t in combo), "last_date": max(t["date"] for t in combo)})
    cycles.sort(key=lambda c: (c["type"], c["nodes"]))

    agg = defaultdict(lambda: {"value": 0, "count": 0, "docs": []})
    for t in txns:
        a = agg[(t["type"], t["from"], t["to"])]
        a["value"] += t["value"]
        a["count"] += 1
        if len(a["docs"]) < 20:
            a["docs"].append(t["doc"])
    used = {n for (_, f, to) in agg for n in (f, to)}
    rp_customers = {f"C:{cid}" for cid, t in ctx.rp_tags().items() if t["tag"] != "non_related"}
    nodes = []
    for n in sorted(used):
        info = labels.get(n, {"label": n, "kinds": [], "members": []})
        members = {m["key"] for m in info["members"]}
        nodes.append({"id": n, "label": info["label"], "kinds": info["kinds"], "members": info["members"],
                      "is_company": n in company_nodes, "related_party": bool(members & rp_customers)})
    in_cycle = {(c["type"], e["from"], e["to"]) for c in cycles for e in c["edges"]}
    edges = [{"type": k[0], "from": k[1], "to": k[2], "value": v["value"], "count": v["count"], "docs": v["docs"],
              "in_cycle": k in in_cycle} for k, v in sorted(agg.items())]
    out = {"nodes": nodes, "edges": edges, "cycles": cycles}
    ctx.snap.cache[key] = out
    return out


def _best_combo(edge_txns: list[list[dict]], th: dict) -> list[dict] | None:
    """One transaction per edge, within the window and with min/max at or above the ratio."""
    window = th["window_days"]
    ratio = th["min_edge_ratio_bp"]
    pivot_i = min(range(len(edge_txns)), key=lambda i: len(edge_txns[i]))
    best, best_score = None, -1.0
    for pivot in sorted(edge_txns[pivot_i], key=lambda t: (t["date"], t["doc"] or "")):
        pd_, pv = dt.date.fromisoformat(pivot["date"]), pivot["value"]
        combo = []
        for i, txs in enumerate(edge_txns):
            if i == pivot_i:
                combo.append(pivot)
                continue
            near = [t for t in txs if abs((dt.date.fromisoformat(t["date"]) - pd_).days) <= window]
            if not near:
                combo = None
                break
            combo.append(min(near, key=lambda t: (abs(t["value"] - pv), t["date"], t["doc"] or "")))
        if not combo:
            continue
        dates = [dt.date.fromisoformat(t["date"]) for t in combo]
        vals = [t["value"] for t in combo]
        if (max(dates) - min(dates)).days > window or min(vals) <= 0:
            continue
        if min(vals) * 10000 < max(vals) * ratio:
            continue
        score = min(vals) / max(vals)
        if score > best_score:
            best, best_score = combo, score
    return best
