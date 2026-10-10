"""Related-party identification (PRD section 11, detectors D-02 and D-03).

Records (customers, vendors, officers, company entities and disclosed parties)
carry dated observations of identifiers. Pairs of records that share
identifiers produce signals. Strong, medium and weak signals combine into links
(11.3), links into clusters (union-find). A customer in a cluster with the
company, an officer or a disclosed party is a suggested related party from the
earliest date at which a chain of links reaches that anchor (RP-1, RP-2).
"""

from __future__ import annotations

import datetime as dt
import heapq
import re
from collections import defaultdict
from dataclasses import dataclass, field

from rapidfuzz.distance import JaroWinkler

from . import gstin as gst
from .repo import rp_tags
from .snapshot import d, normalise_account

EPOCH = dt.date(1900, 1, 1)
STRENGTH = {"same_pan": "strong", "shared_director": "strong", "shared_bank_account": "strong",
            "receipt_from_account": "strong", "disclosed_match": "strong", "shared_phone": "medium",
            "shared_email": "medium", "shared_address": "medium", "similar_name": "weak"}
LABEL = {"same_pan": "same PAN", "shared_director": "shared director", "shared_bank_account": "shared bank account",
         "receipt_from_account": "receipt paid from this party's account", "disclosed_match": "disclosed list entry",
         "shared_phone": "shared phone", "shared_email": "shared email", "shared_address": "shared address",
         "similar_name": "similar name"}


@dataclass
class Rec:
    key: str
    kind: str  # customer, vendor, officer, company, disclosed
    label: str
    party_id: str | None = None
    obs: dict[tuple[str, str], dt.date] = field(default_factory=dict)  # (signal kind, value) -> earliest date
    addresses: dict[str, dt.date] = field(default_factory=dict)
    names: dict[str, dt.date] = field(default_factory=dict)
    anchor_date: dt.date | None = None

    def see(self, kind: str, value, when: dt.date) -> None:
        if not value:
            return
        k = (kind, str(value))
        if k not in self.obs or when < self.obs[k]:
            self.obs[k] = when


def norm_phone(p) -> str | None:
    digits = re.sub(r"\D", "", str(p or ""))
    return digits[-10:] if len(digits) >= 10 else None


def norm_email(e) -> str | None:
    s = str(e or "").strip().lower()
    return s if "@" in s else None


def norm_address(a) -> str | None:
    if not a:
        return None
    if isinstance(a, dict):
        a = " ".join(str(a.get(k) or "") for k in ("line1", "line2", "city", "pincode"))
    s = str(a).lower()
    s = re.sub(r"\bplot\s*no\.?\b|\bplot\b|\bno\.?\b|\bgat\b|\bsurvey\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split()) or None


def address_match(a: str, b: str, threshold: float) -> bool:
    if a == b:
        return True
    if sorted(re.findall(r"\d+", a)) != sorted(re.findall(r"\d+", b)):
        return False
    return JaroWinkler.similarity(a, b) >= threshold


def norm_name(n, suffixes: list[str]) -> str:
    s = str(n or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = " " + " ".join(s.split()) + " "
    for suf in sorted(suffixes, key=len, reverse=True):
        suf_n = " " + " ".join(re.sub(r"[^a-z0-9 ]+", " ", suf.replace("&", " and ")).split()) + " "
        s = s.replace(suf_n, " ")
    return " ".join(s.split())


def _party_records(ctx, kind: str, book: dict) -> list[Rec]:
    out = []
    for pid, party in sorted(book.items()):
        r = Rec(f"{kind[0].upper()}:{pid}", kind, party.name, pid)
        for v in party.versions:
            st, when = v["state"], d(v["effective_from"]) or EPOCH
            r.see("entity_pan", gst.pan_of(st.get("gstin")), when)
            r.see("gstin", gst.normalise(st.get("gstin")), when)
            if gst.is_valid_pan(st.get("pan")):
                r.see("entity_pan", str(st["pan"]).upper(), when)
            for dr in st.get("directors") or []:
                if gst.is_valid_pan(dr.get("pan")):
                    r.see("director_pan", str(dr["pan"]).upper(), when)
                r.see("din", (dr.get("din") or "").strip(), when)
            for b in st.get("bank_accounts") or []:
                r.see("bank", normalise_account(b.get("account_no")), when)
            r.see("phone", norm_phone(st.get("phone")), when)
            r.see("email", norm_email(st.get("email")), when)
            for a in st.get("addresses") or []:
                na = norm_address(a)
                if na and (na not in r.addresses or when < r.addresses[na]):
                    r.addresses[na] = when
            nn = norm_name(st.get("name"), ctx.th["related_parties"]["legal_suffixes"])
            if nn and (nn not in r.names or when < r.names[nn]):
                r.names[nn] = when
        out.append(r)
    return out


def build_records(ctx) -> dict[str, Rec]:
    snap, start = ctx.snap, ctx.start
    recs: dict[str, Rec] = {}
    for r in _party_records(ctx, "customer", snap.customers) + _party_records(ctx, "vendor", snap.vendors):
        recs[r.key] = r
    for oid, o in sorted(snap.officers.items()):
        to = d(o.get("effective_to"))
        if to and to < start:
            continue
        when = d(o.get("effective_from")) or EPOCH
        r = Rec(f"O:{oid}", "officer", f"{o.get('name')} ({o.get('role')})", oid, anchor_date=when)
        if gst.is_valid_pan(o.get("pan")):
            r.see("entity_pan", o["pan"].upper(), when)
            r.see("director_pan", o["pan"].upper(), when)
        r.see("din", (o.get("din") or "").strip(), when)
        for b in o.get("bank_accounts") or []:
            r.see("bank", normalise_account(b.get("account_no")), when)
        r.see("phone", norm_phone(o.get("phone")), when)
        r.see("email", norm_email(o.get("email")), when)
        na = norm_address(o.get("address"))
        if na:
            r.addresses[na] = when
        recs[r.key] = r
    entities = dict((ctx.snap.company_profile.get("entities") or {}))
    for eid in set(snap.company_gstins) | set(snap.company_bank_accounts) | set(ctx.entities or []):
        entities.setdefault(eid, {})
    for eid, prof in sorted(entities.items()):
        r = Rec(f"CO:{eid}", "company", prof.get("name") or eid, eid, anchor_date=EPOCH)
        gstins = set(snap.company_gstins.get(eid) or []) | ({gst.normalise(prof["gstin"])} if prof.get("gstin") else set())
        for g in gstins:
            r.see("entity_pan", gst.pan_of(g), EPOCH)
        if prof.get("pan"):
            r.see("entity_pan", prof["pan"], EPOCH)
        accts = set(snap.company_bank_accounts.get(eid) or []) | {normalise_account(a) for a in prof.get("bank_accounts") or []}
        for a in accts:
            r.see("bank", a, EPOCH)
        r.see("phone", norm_phone(prof.get("phone")), EPOCH)
        r.see("email", norm_email(prof.get("email")), EPOCH)
        na = norm_address(prof.get("address"))
        if na:
            r.addresses[na] = EPOCH
        nn = norm_name(prof.get("name"), ctx.th["related_parties"]["legal_suffixes"])
        if nn:
            r.names[nn] = EPOCH
        recs[r.key] = r
    for i, p in enumerate(disclosed_parties(ctx)):
        when = d(p.get("effective_from")) or EPOCH
        r = Rec(f"DL:{i}", "disclosed", p.get("name") or f"Disclosed party {i + 1}", None, anchor_date=when)
        if gst.is_valid_pan(p.get("pan")):
            r.see("entity_pan", p["pan"].strip().upper(), when)
        r.see("entity_pan", gst.pan_of(p.get("gstin")), when)
        r.see("gstin", gst.normalise(p.get("gstin")), when)
        nn = norm_name(p.get("name"), ctx.th["related_parties"]["legal_suffixes"])
        if nn:
            r.names[nn] = when
        r.disclosed = p  # type: ignore[attr-defined]
        recs[r.key] = r
    return recs


def disclosed_parties(ctx) -> list[dict]:
    up = next((u for u in ctx.snap.rp_uploads if u["_seq"] == ctx.eng["rp_upload_seq"]), None)
    if up is None:
        return []
    if up.get("parties"):
        return list(up["parties"])
    try:
        import csv
        import io

        text = ctx.engine.files.get(up["file_hash"]).decode("utf-8-sig")
        out = []
        for row in csv.DictReader(io.StringIO(text)):
            low = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
            out.append({"name": low.get("name"), "pan": low.get("pan") or None, "gstin": low.get("gstin") or None,
                        "relationship": low.get("relationship") or "", "effective_from": low.get("effective from")
                        or low.get("effective_from") or None})
        return out
    except Exception:
        return []


class UnionFind:
    def __init__(self):
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            if rb < ra:
                ra, rb = rb, ra
            self.parent[rb] = ra


def _link_date(signals: list[dict]) -> dt.date | None:
    """Earliest date at which the signals satisfy the link rule (11.3)."""
    by = defaultdict(list)
    for s in signals:
        by[s["strength"]].append(d(s["effective_from"]) or EPOCH)
    options = []
    if by["strong"]:
        options.append(min(by["strong"]))
    med = sorted(by["medium"])
    if len(med) >= 2:
        options.append(med[1])
    if med and by["weak"]:
        options.append(max(med[0], min(by["weak"])))
    return min(options) if options else None


def resolve(ctx) -> dict:
    """Signals, links, clusters and paths to anchors. Cached on the snapshot."""
    cache_key = ("resolution", ctx.eid)
    if cache_key in ctx.snap.cache:
        return ctx.snap.cache[cache_key]
    cfg = ctx.th["related_parties"]
    recs = build_records(ctx)
    pair_signals: dict[tuple[str, str], list[dict]] = defaultdict(list)

    def add(a: str, b: str, signal: str, value: str, when: dt.date, detail: str = "") -> None:
        if a == b:
            return
        key = (a, b) if a < b else (b, a)
        for s in pair_signals[key]:
            if s["signal"] == signal and s["value"] == value:
                if when < d(s["effective_from"]):
                    s["effective_from"] = when.isoformat()
                return
        pair_signals[key].append({"signal": signal, "strength": STRENGTH[signal], "value": value,
                                  "effective_from": when.isoformat(), "detail": detail})

    index: dict[tuple[str, str], list[tuple[str, dt.date]]] = defaultdict(list)
    for r in recs.values():
        for (kind, value), when in r.obs.items():
            group = "person" if kind in ("director_pan", "din") else kind
            index[(group if kind != "entity_pan" else "entity_pan", value)].append((r.key, when, kind))
    for (group, value), holders in index.items():
        if len(holders) < 2:
            continue
        for i in range(len(holders)):
            for j in range(i + 1, len(holders)):
                (a, wa, ka), (b, wb, kb) = holders[i], holders[j]
                when = max(wa, wb)
                if group == "entity_pan":
                    add(a, b, "same_pan", value, when)
                elif group == "person":
                    add(a, b, "shared_director", value, when, "PAN" if "pan" in ka else "DIN")
                elif group == "bank":
                    add(a, b, "shared_bank_account", value, when)
                elif group == "phone":
                    add(a, b, "shared_phone", value, when)
                elif group == "email":
                    add(a, b, "shared_email", value, when)
                elif group == "gstin":
                    add(a, b, "same_pan", value, when)
    # Pairwise fuzzy signals: address and name.
    keys = sorted(recs)
    jw = cfg["jaro_winkler_min"]
    addr_items = [(k, a, w) for k in keys for a, w in recs[k].addresses.items()]
    for i in range(len(addr_items)):
        ka, aa, wa = addr_items[i]
        for j in range(i + 1, len(addr_items)):
            kb, ab, wb = addr_items[j]
            if ka != kb and address_match(aa, ab, jw):
                add(ka, kb, "shared_address", aa, max(wa, wb))
    name_items = [(k, n, w) for k in keys for n, w in recs[k].names.items() if recs[k].kind != "officer"]
    for i in range(len(name_items)):
        ka, na, wa = name_items[i]
        for j in range(i + 1, len(name_items)):
            kb, nb, wb = name_items[j]
            if ka != kb and JaroWinkler.similarity(na, nb) >= jw:
                add(ka, kb, "similar_name", f"{na} ~ {nb}", max(wa, wb))
    # Receipts paid from an account held by another party or an officer.
    owners: dict[str, list[str]] = defaultdict(list)
    for r in recs.values():
        for (kind, value) in r.obs:
            if kind == "bank":
                owners[value].append(r.key)
    for rc in ctx.snap.receipts:
        cust_key = f"C:{rc.get('customer_id')}"
        acct = normalise_account(rc.get("payer_account"))
        for holder in owners.get(acct, []):
            if holder != cust_key and cust_key in recs and recs[holder].kind != "company":
                add(cust_key, holder, "receipt_from_account", acct, d(rc.get("date")) or EPOCH,
                    f"receipt {rc.get('receipt_id')}")
    # Disclosed entries match customers by PAN, GSTIN or exact normalised name (11.2).
    disclosed_of: dict[str, list[str]] = defaultdict(list)
    for r in recs.values():
        if r.kind != "disclosed":
            continue
        for c in recs.values():
            if c.kind not in ("customer", "vendor"):
                continue
            how = None
            mine = {v for (k, v) in c.obs if k == "entity_pan"}
            mine_g = {v for (k, v) in c.obs if k == "gstin"}
            if {v for (k, v) in r.obs if k == "gstin"} & mine_g:
                how = "GSTIN"
            elif {v for (k, v) in r.obs if k == "entity_pan"} & mine:
                how = "PAN"
            elif set(r.names) & set(c.names):
                how = "name"
            if how:
                add(r.key, c.key, "disclosed_match", how, r.anchor_date or EPOCH)
                if c.kind == "customer":
                    disclosed_of[c.key].append(r.key)

    links: dict[tuple[str, str], dict] = {}
    uf = UnionFind()
    for pair, sigs in pair_signals.items():
        when = _link_date(sigs)
        if when is not None:
            links[pair] = {"effective_from": when.isoformat(), "signals": sigs}
            uf.union(*pair)
    clusters: dict[str, list[str]] = defaultdict(list)
    for k in recs:
        clusters[uf.find(k)].append(k)

    def bottleneck(anchor_keys: dict[str, dt.date]) -> tuple[dict[str, dt.date], dict[str, str]]:
        adj = defaultdict(list)
        for (a, b), ln in links.items():
            w = d(ln["effective_from"])
            adj[a].append((b, w))
            adj[b].append((a, w))
        dist = dict(anchor_keys)
        prev: dict[str, str] = {}
        heap = [(w, k) for k, w in anchor_keys.items()]
        heapq.heapify(heap)
        while heap:
            w, u = heapq.heappop(heap)
            if dist.get(u) != w:
                continue
            for v, ew in adj[u]:
                nw = max(w, ew)
                if v not in dist or nw < dist[v]:
                    dist[v] = nw
                    prev[v] = u
                    heapq.heappush(heap, (nw, v))
        return dist, prev

    base_anchors = {k: r.anchor_date or EPOCH for k, r in recs.items() if r.kind in ("company", "officer")}
    all_anchors = dict(base_anchors)
    for k, r in recs.items():
        if r.kind == "disclosed":
            all_anchors[k] = r.anchor_date or EPOCH
    dist_all, prev_all = bottleneck(all_anchors)
    dist_base, prev_base = bottleneck(base_anchors)
    result = {"records": recs, "links": links, "clusters": dict(clusters), "cluster_of": {k: uf.find(k) for k in recs},
              "dist_all": dist_all, "prev_all": prev_all, "dist_base": dist_base, "prev_base": prev_base,
              "disclosed_of": dict(disclosed_of)}
    ctx.snap.cache[cache_key] = result
    return result


def path_to_anchor(res: dict, key: str, which: str = "all") -> list[dict]:
    prev = res["prev_all" if which == "all" else "prev_base"]
    steps, cur, guard = [], key, 0
    while cur in prev and guard < 50:
        nxt = prev[cur]
        pair = (cur, nxt) if cur < nxt else (nxt, cur)
        ln = res["links"][pair]
        steps.append({"from": res["records"][cur].label, "to": res["records"][nxt].label,
                      "to_key": nxt, "effective_from": ln["effective_from"],
                      "signals": [{"signal": s["signal"], "strength": s["strength"], "value": s["value"],
                                   "effective_from": s["effective_from"]} for s in ln["signals"]]})
        cur, guard = nxt, guard + 1
    return steps


def describe(steps: list[dict]) -> str:
    parts = []
    for s in steps:
        sig = ", ".join(sorted({LABEL[x["signal"]] for x in s["signals"]}))
        parts.append(f"{s['from']} to {s['to']} ({sig}, from {s['effective_from']})")
    return "; ".join(parts)


def tag_related_parties(ctx) -> dict:
    res = resolve(ctx)
    recs = res["records"]
    snap = ctx.snap
    tags, findings = [], []
    period_invoices = snap.invoices_in_period(ctx.start, ctx.end, ctx.entities)
    by_cust = defaultdict(list)
    for inv in period_invoices:
        by_cust[inv.get("customer_id")].append(inv)
    for cid, party in sorted(snap.customers.items()):
        key = f"C:{cid}"
        dl_keys = res["disclosed_of"].get(key, [])
        disclosed_from = None
        relationship = None
        if dl_keys:
            dates = [recs[k].anchor_date or EPOCH for k in dl_keys]
            disclosed_from = min(dates)
            relationship = recs[dl_keys[dates.index(disclosed_from)]].disclosed.get("relationship")
        suggested_from = None
        steps: list[dict] = []
        if not dl_keys and key in res["dist_all"]:
            suggested_from = res["dist_all"][key]
            steps = path_to_anchor(res, key, "all")
        if dl_keys:
            tag = "disclosed"
        elif suggested_from is not None:
            tag = "suggested"
        else:
            tag = "non_related"
        resolved = res["dist_base"].get(key) if dl_keys else None
        eff_candidates = [x for x in (disclosed_from, suggested_from, resolved) if x is not None]
        effective = min(eff_candidates) if eff_candidates else None
        detail = {"name": party.name, "tag": tag,
                  "effective_from": effective.isoformat() if effective else None,
                  "disclosed_from": disclosed_from.isoformat() if disclosed_from else None,
                  "suggested_from": suggested_from.isoformat() if (suggested_from and tag == "suggested") else None,
                  "resolved_from": (res["dist_base"][key].isoformat() if key in res["dist_base"] else None),
                  "relationship": relationship, "path": steps, "explanation": describe(steps),
                  "cluster": res["cluster_of"].get(key)}
        tags.append({"engagement_id": ctx.eid, "customer_id": cid, "tag": tag, "detail": detail})
        invs = by_cust.get(cid, [])
        if tag == "suggested":
            since = suggested_from
            value = sum(i.get("taxable_value") or 0 for i in invs if (d(i.get("invoice_date")) or ctx.end) >= since)
            anchor = steps[-1]["to"] if steps else "the company"
            sigs = sorted({LABEL[s["signal"]] for st in steps for s in st["signals"]})
            findings.append(ctx.finding(
                category="RP_UNDISCLOSED", subtype="SUGGESTED_RELATED_PARTY", subject_type="customer",
                subject_id=cid, subject_label=party.name, related_party=True, amount_impact=value,
                title=f"{party.name} appears related to {anchor} but is not in the disclosed list",
                event_seqs=[v["seq"] for v in party.versions] + [i["_seq"] for i in invs],
                document_ids=[cid] + [i["invoice_no"] for i in invs],
                thresholds={"jaro_winkler_min": ctx.th["related_parties"]["jaro_winkler_min"]},
                facts={"signals": sigs, "path": steps, "since": since.isoformat(), "sales_value": value,
                       "invoice_count": len(invs)},
                reason=(f"{party.name} is linked to {anchor}: {describe(steps)}. It is not in the client's "
                        f"related-party list. In-period sales since {since}: Rs {_r(value)} over "
                        f"{sum(1 for i in invs if (d(i.get('invoice_date')) or ctx.end) >= since)} invoice(s).")))
        if effective is not None and ctx.start < effective <= ctx.end:
            before = [i for i in invs if (d(i.get("invoice_date")) or ctx.start) < effective]
            after = [i for i in invs if (d(i.get("invoice_date")) or ctx.start) >= effective]
            sub = "DISCLOSED_STARTS_IN_PERIOD" if (tag == "disclosed" and disclosed_from == effective) \
                else "LINK_STARTS_IN_PERIOD"
            vb = sum(i.get("taxable_value") or 0 for i in before)
            va = sum(i.get("taxable_value") or 0 for i in after)
            findings.append(ctx.finding(
                category="RP_MID_PERIOD", subtype=sub, subject_type="customer", subject_id=cid,
                subject_label=party.name, related_party=True, amount_impact=va,
                title=f"{party.name} becomes related on {effective}, partway through the period",
                event_seqs=[v["seq"] for v in party.versions], document_ids=[cid] + [i["invoice_no"] for i in invs],
                facts={"effective_from": effective.isoformat(), "sales_before": vb, "sales_after": va,
                       "invoices_before": len(before), "invoices_after": len(after), "path": steps,
                       "relationship": relationship},
                reason=(f"{party.name} is related only from {effective}"
                        f"{' (' + describe(steps) + ')' if steps else ' (disclosed list)'}. Sales before: Rs {_r(vb)} "
                        f"on {len(before)} invoice(s), treated as non-related. Sales from that date: Rs {_r(va)} "
                        f"on {len(after)} invoice(s), treated as related.")))
        if tag == "disclosed":
            base = res["dist_base"].get(key)
            if base is not None and disclosed_from is not None and base < disclosed_from:
                steps_b = path_to_anchor(res, key, "base")
                findings.append(ctx.finding(
                    category="RP_MID_PERIOD", subtype="LATE_DISCLOSURE", subject_type="customer", subject_id=cid,
                    subject_label=party.name, related_party=True,
                    amount_impact=sum(i.get("taxable_value") or 0 for i in invs
                                      if base <= (d(i.get("invoice_date")) or ctx.end) < disclosed_from),
                    title=f"{party.name} is disclosed from {disclosed_from} but linked from {base}",
                    event_seqs=[v["seq"] for v in party.versions], document_ids=[cid],
                    facts={"disclosed_from": disclosed_from.isoformat(), "linked_from": base.isoformat(),
                           "path": steps_b},
                    reason=(f"The disclosed list gives {disclosed_from} as the start of the relationship with "
                            f"{party.name}, but the records link it from {base}: {describe(steps_b)}.")))
    ctx.engine.repo.insert(rp_tags, tags)
    ctx.engine.save_findings(findings)
    counts = defaultdict(int)
    for t in tags:
        counts[t["tag"]] += 1
    return {"customers": len(tags), "by_tag": dict(counts), "findings_raised": len(findings),
            "suggested": [{"customer_id": t["customer_id"], "name": t["detail"]["name"],
                           "since": t["detail"]["suggested_from"], "explanation": t["detail"]["explanation"]}
                          for t in tags if t["tag"] == "suggested"]}


def base_keys(res: dict) -> set[str]:
    return {k for k, r in res["records"].items() if r.kind in ("company", "officer")}


def _r(p: int) -> str:
    from .money import rupees

    return rupees(p)
