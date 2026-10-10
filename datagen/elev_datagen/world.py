"""Synthetic mid-size manufacturer (SD-1, SD-3).

The generator first builds plain Python records for the whole year (sales with
their document chains, receipts, credit notes, purchases, payments, journals),
lets the planted scenarios mutate them, then compiles everything into client
events in time order. The clean baseline must produce zero findings, so every
regular record here follows the rules the detectors test.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import math
import random
from dataclasses import dataclass, field
from typing import Any

from audit_engine import gstin as gst
from audit_engine.money import apply_bp, div_round

from . import names

FY_START = dt.date(2025, 4, 1)
FY_END = dt.date(2026, 3, 31)
DATA_END = dt.date(2026, 7, 10)
UPLOAD_AT = dt.datetime(2026, 7, 10, 18, 0)
IST = dt.timedelta(hours=5, minutes=30)
COMPANY_STATE = "27"
CLIENT = {"user": "client.ops", "role": "client_employee"}


def utc(t: dt.datetime) -> str:
    return (t - IST).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S")


def at(day: dt.date, hour: int = 10, minute: int = 0) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(hour, minute))


@dataclass
class Party:
    pid: str
    kind: str  # customer or vendor
    name: str
    pan: str
    gstin: str
    state: str
    city: str
    distance: int
    address: dict
    phone: str
    email: str
    bank: dict
    directors: list[dict]
    segment: str = "industrial"
    weight: float = 0.0
    terms: str = "EX_WORKS"
    pay_days: int = 40
    regular: bool = True
    created: dt.date = FY_START
    entity: str = "E1"
    items: list[str] = field(default_factory=list)
    order_value: int = 0  # paise

    def master_payload(self) -> dict:
        return {
            f"{self.kind}_id": self.pid, "name": self.name, "gstin": self.gstin, "pan": self.pan,
            "addresses": [dict(self.address, kind="billing")], "phone": self.phone, "email": self.email,
            "bank_accounts": [dict(self.bank)], "directors": [dict(x) for x in self.directors],
            "effective_from": self.created.isoformat(),
        }


@dataclass
class Sale:
    sale_id: str
    cust: Party
    dispatch_at: dt.datetime
    items: list[dict]  # item, qty, rate, discount_bp
    terms: str
    scheme_id: str | None = None
    approver: str | None = names.APPROVERS[0]
    bu: str = "Industrial"
    unit: str = "Unit-1 Bhosari"
    entity: str = "E1"
    enquiry_lag: int = 3
    order_lag: int = 4
    has_enquiry: bool = True
    has_order: bool = True
    has_dispatch: bool = True
    has_lr: bool = True
    has_delivery: bool = True
    has_ewb: bool | None = None  # None means by threshold
    delivered_at: dt.datetime | None = None
    distance: int = 0
    vehicle: str | None = None
    transporter: str = names.TRANSPORTERS[0]
    dispatch_qty_factor_bp: int = 10000
    lr_vehicle: str | None = None
    ewb_no: str | None = None
    ewb_value_delta: int = 0
    ewb_valid_days: int | None = None
    force_tax: str | None = None
    gstin_override: str | None = None
    invoice_date_shift: int = 0  # days the stated invoice date is moved from the dispatch date
    record_delay_days: int = 0  # invoice appended this many days after its stated date
    gstr1_omit: bool = False
    gstr1_taxable_delta: int = 0
    dup_of: "Sale | None" = None
    skip_number_before: bool = False
    auto_settle: bool = True
    plant: bool = False
    reversed_on: dt.date | None = None
    reverse_reason: str = ""
    invoice_no: str | None = None
    invoice: dict | None = None
    link_to: "Sale | None" = None  # a reissued invoice that uses the original sale's order and dispatch
    ewb_from: "Sale | None" = None  # reuse another sale's e-way bill number
    reissue_at: dt.datetime | None = None
    lr_no: str | None = None
    key: str = ""  # document key; differs from sale_id for a reissued invoice
    packing: int = 0
    freight: int = 0
    insurance: int = 0
    seq_hint: int = 0

    @property
    def invoice_at(self) -> dt.datetime:
        if self.reissue_at is not None:
            return self.reissue_at
        base = self.dispatch_at + dt.timedelta(minutes=5)
        return base + dt.timedelta(days=self.invoice_date_shift + self.record_delay_days)

    @property
    def invoice_date(self) -> dt.date:
        if self.reissue_at is not None:
            return self.reissue_at.date()
        return (self.dispatch_at + dt.timedelta(days=self.invoice_date_shift)).date()

    @property
    def order_date(self) -> dt.date:
        return self.dispatch_at.date() - dt.timedelta(days=self.order_lag)

    @property
    def enquiry_date(self) -> dt.date:
        return self.order_date - dt.timedelta(days=self.enquiry_lag)

    def short(self) -> str:
        return self.key or self.sale_id[2:]


class World:
    def __init__(self, seed: int = 7, scale: float = 1.0, planted: bool = False):
        self.seed = seed
        self.scale = scale
        self.planted = planted
        self.rng = random.Random(seed)
        self.used_pans: set[str] = set()
        self.used_accounts: set[str] = set()
        self.used_phones: set[str] = set()
        self.used_dins: set[str] = set()
        self.address_no = 100
        self.customers: list[Party] = []
        self.vendors: list[Party] = []
        self.officers: list[dict] = []
        self.sales: list[Sale] = []
        self.receipts: list[dict] = []  # {t, payload, sale, no_bank, entity}
        self.credit_notes: list[dict] = []  # {t, payload, sale, return: {t, payload} | None}
        self.purchases: list[dict] = []  # {t, payload, grn_t, entity}
        self.payments: list[dict] = []  # {t, payload, entity, no_bank}
        self.journals: list[dict] = []  # {t, payload, sale_id}
        self.extra_events: list[dict] = []  # raw intents
        self.extra_gstr1: list[dict] = []
        self.promotions: list[dict] = []
        self.prices: list[dict] = []
        self.disclosed: list[dict] = []
        self.answer: list[dict] = []
        self.register_plants: dict[str, Any] = {}
        self.counter = 0
        self.utr_no = 0
        self.company = self._company()

    # Identifiers

    def next_id(self, prefix: str) -> str:
        self.counter += 1
        return f"{prefix}{self.counter:06d}"

    def utr(self) -> str:
        self.utr_no += 1
        return f"UTR{self.seed:02d}{self.utr_no:09d}"

    def pan(self, kind: str = "C", initial: str = "A") -> str:
        while True:
            letters = "".join(self.rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(3))
            p = f"{letters}{kind}{initial.upper()[0]}{self.rng.randint(1000, 9999)}{self.rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')}"
            if p not in self.used_pans:
                self.used_pans.add(p)
                return p

    def account(self) -> dict:
        while True:
            no = "".join(str(self.rng.randint(0, 9)) for _ in range(12))
            if no not in self.used_accounts and no[0] != "0":
                self.used_accounts.add(no)
                bank, ifsc = self.rng.choice(names.BANKS)
                return {"account_no": no, "ifsc": f"{ifsc}{self.rng.randint(100, 999)}"[:11]}

    def phone(self) -> str:
        while True:
            p = f"+91{self.rng.choice('6789')}{self.rng.randint(100000000, 999999999)}"
            if p not in self.used_phones:
                self.used_phones.add(p)
                return p

    def din(self) -> str:
        while True:
            d = f"0{self.rng.randint(1000000, 9999999)}"
            if d not in self.used_dins:
                self.used_dins.add(d)
                return d

    def person(self, name: str | None = None) -> dict:
        name = name or f"{self.rng.choice(names.FIRST_NAMES)} {self.rng.choice(names.LAST_NAMES)}"
        return {"name": name, "pan": self.pan("P", name.split()[-1][0]), "din": self.din()}

    def address(self, city: str, state: str) -> dict:
        self.address_no += self.rng.randint(1, 9)
        area = self.rng.choice(names.AREAS)
        pin = names.PINCODES.get(city, "4110") + f"{self.rng.randint(10, 99)}"
        return {"line1": f"Plot No. {self.address_no}, {area}", "city": city, "state_code": state, "pincode": pin}

    # Company and masters

    def _company(self) -> dict:
        pan = self.pan("C", "S")
        e2_pan = self.pan("C", "S")
        return {
            "E1": {"name": "Shreeji Precision Components Pvt Ltd", "gstin": gst.make_gstin(COMPANY_STATE, pan),
                   "pan": pan, "address": {"line1": "Plot No. 7, MIDC Bhosari", "city": "Pune", "state_code": "27",
                                           "pincode": "411026"},
                   "phone": "+912027120000", "email": "accounts@shreejiprecision.in",
                   "bank_accounts": [{"account_no": "50200012345678", "ifsc": "HDFC0000123"}]},
            "E2": {"name": "Shreeji Castings Pvt Ltd", "gstin": gst.make_gstin(COMPANY_STATE, e2_pan), "pan": e2_pan,
                   "address": {"line1": "Gat No. 410, Chakan Industrial Area", "city": "Chakan", "state_code": "27",
                               "pincode": "410501"},
                   "phone": "+912135250000", "email": "accounts@shreejicastings.in",
                   "bank_accounts": [{"account_no": "50200087654321", "ifsc": "HDFC0000123"}]},
        }

    def make_party(self, kind: str, name: str, state: str, city: str, distance: int, segment: str = "industrial",
                   regular: bool = True, pan: str | None = None, gstin: str | None = None, bank: dict | None = None,
                   phone: str | None = None, address: dict | None = None, directors: list[dict] | None = None,
                   email: str | None = None, entity: str = "E1", created: dt.date = FY_START) -> Party:
        pan = pan or self.pan("C" if "Ltd" in name or "Limited" in name else "F", name[0])
        slug = "".join(ch for ch in name.lower() if ch.isalnum())[:18]
        pid = f"{'C' if kind == 'customer' else 'V'}{len(self.customers if kind == 'customer' else self.vendors) + 1:04d}"
        if entity != "E1":
            pid = f"{entity}-{pid}"
        p = Party(
            pid=pid, kind=kind, name=name, pan=pan, gstin=gstin or gst.make_gstin(state, pan), state=state, city=city,
            distance=distance, address=address or self.address(city, state), phone=phone or self.phone(),
            email=email or f"accounts@{slug}.in", bank=bank or self.account(),
            directors=directors if directors is not None else [self.person() for _ in range(self.rng.randint(1, 2))],
            segment=segment, regular=regular, entity=entity, created=created,
        )
        p.terms = "DELIVERED" if (distance > 300 and self.rng.random() < 0.7) or self.rng.random() < 0.25 else "EX_WORKS"
        p.pay_days = self.rng.randint(25, 55)
        candidates = [i[0] for i in names.ITEMS if segment in i[3]]
        p.items = self.rng.sample(candidates, k=min(len(candidates), self.rng.randint(2, 4)))
        p.order_value = int(math.exp(self.rng.gauss(math.log(150000), 0.55))) * 100
        (self.customers if kind == "customer" else self.vendors).append(p)
        return p

    def _unique_name(self, used: set[str], cores: list[str]) -> str:
        """Prefer an unused first word. Once the pool is spent, accept any unused full name.

        A shared first word is at most a weak name signal, which never links two parties on its own.
        """
        for attempt in range(400):
            n = f"{self.rng.choice(names.PREFIXES)} {self.rng.choice(cores)} {self.rng.choice(names.SUFFIXES)}"
            key = n.split()[0]
            if n in used or (attempt < 200 and key in used):
                continue
            used.add(n)
            used.add(key)
            return n
        raise RuntimeError("name pool exhausted")

    def build_masters(self) -> None:
        self.used_names: set[str] = set()
        self.officers = [
            self._officer("O1", "Rajesh Mehta", "Managing Director", dt.date(2012, 6, 1)),
            self._officer("O2", "Sunita Mehta", "Whole-time Director", dt.date(2014, 4, 1)),
            self._officer("O3", "Anil Kulkarni", "Chief Financial Officer", dt.date(2018, 9, 1), din=False),
            self._officer("O4", "Priya Deshpande", "Company Secretary", dt.date(2019, 1, 15), din=False),
            self._officer("O5", "Vikram Shah", "Independent Director", dt.date(2020, 7, 1)),
        ]
        o = {x["officer_id"]: x for x in self.officers}
        # Disclosed related parties, genuine and disclosed from before the period.
        rp1 = self.make_party("customer", "Mehta Auto Components Pvt Ltd", "27", "Pune", 18, "auto",
                              directors=[{"name": "Sunita Mehta", "pan": o["O2"]["pan"], "din": o["O2"]["din"]},
                                         self.person()])
        rp2 = self.make_party("customer", "Shreeji Forgings LLP", "27", "Chakan", 22, "industrial",
                              directors=[{"name": "Rajesh Mehta", "pan": o["O1"]["pan"], "din": o["O1"]["din"]}])
        rp3 = self.make_party("customer", "Deshpande Hydraulics", "27", "Satara", 110, "industrial",
                              directors=[{"name": "Mohan Deshpande", "pan": self.pan("P", "D"), "din": self.din()}])
        for p, rel in ((rp1, "Director is a director of the party"), (rp2, "Managing Director is a partner"),
                       (rp3, "Relative of Company Secretary")):
            self.disclosed.append({"name": p.name, "pan": p.pan, "gstin": p.gstin, "relationship": rel,
                                   "effective_from": "2020-04-01"})
        self.rp_customers = [rp1, rp2, rp3]
        for x in (rp1, rp2, rp3):
            self.used_names.add(x.name.split()[0])

        n_customers = max(30, int(round(147 * min(self.scale, 1.0)))) if self.scale < 1 else 147
        weights_total = sum(w for *_, w in names.PLACES)
        for i in range(n_customers):
            r, acc = self.rng.uniform(0, weights_total), 0
            for state, city, dist, w in names.PLACES:
                acc += w
                if r <= acc:
                    break
            segment = self.rng.choices(["auto", "industrial", "aftermarket"], weights=[45, 35, 20])[0]
            name = self._unique_name(self.used_names, names.CUSTOMER_CORES[segment])
            jitter = self.rng.randint(-5, 15) if dist > 30 else self.rng.randint(0, 10)
            self.make_party("customer", name, state, city, max(5, dist + jitter), segment)
        n_vendors = 40 if self.scale >= 1 else max(10, int(40 * self.scale))
        for i in range(n_vendors):
            state, city, dist, _ = self.rng.choice(names.PLACES[:12])
            name = self._unique_name(self.used_names, names.VENDOR_CORES)
            self.make_party("vendor", name, state, city, dist, "vendor")
        # Volume weights: a long tail, as for a real customer base.
        regular = [c for c in self.customers]
        self.rng.shuffle(regular)
        for rank, c in enumerate(regular):
            c.weight = 1.0 / (rank + 2) ** 0.75
        for c in self.rp_customers:
            c.weight = max(c.weight, 0.02)

        self.items = {code: {"code": code, "desc": desc, "rate": rate} for code, desc, rate, _ in names.ITEMS}
        for code, item in self.items.items():
            self.prices.append({"item": code, "rate": item["rate"], "effective_from": "2025-04-01"})
            self.prices.append({"item": code, "rate": div_round(item["rate"] * 104, 100),
                                "effective_from": "2025-10-01"})
        autos = sorted([c for c in self.customers if c.segment == "auto"], key=lambda c: -c.weight)[:5]
        after = [c.pid for c in self.customers if c.segment == "aftermarket"]
        self.promotions = [
            {"scheme_id": "FESTIVE-25", "discount_bp": 500, "valid_from": "2025-10-01", "valid_to": "2025-11-15",
             "eligible_customers": None, "approver": "R. Iyer (Sales Head)", "_created": dt.date(2025, 9, 25)},
            {"scheme_id": "VOL-AUTO-25", "discount_bp": 300, "valid_from": "2025-04-01", "valid_to": "2026-03-31",
             "eligible_customers": [c.pid for c in autos], "approver": "Rajesh Mehta (MD)",
             "_created": dt.date(2025, 4, 1)},
            {"scheme_id": "WINTER-AM-26", "discount_bp": 400, "valid_from": "2026-01-01", "valid_to": "2026-02-28",
             "eligible_customers": after, "approver": "R. Iyer (Sales Head)", "_created": dt.date(2025, 12, 26)},
        ]

    def _officer(self, oid: str, name: str, role: str, since: dt.date, din: bool = True) -> dict:
        city, state = "Pune", "27"
        return {"officer_id": oid, "name": name, "pan": self.pan("P", name.split()[-1][0]),
                "din": self.din() if din else None, "role": role, "phone": self.phone(),
                "email": f"{name.split()[0].lower()}.{name.split()[-1].lower()}@gmail.com",
                "address": self.address(city, state), "bank_accounts": [self.account()],
                "effective_from": since.isoformat(), "effective_to": None}

    def officer(self, oid: str) -> dict:
        return next(o for o in self.officers if o["officer_id"] == oid)

    # Pricing and promotions

    def price_on(self, item: str, day: dt.date) -> int:
        rate = None
        for p in self.prices:
            if p["item"] == item and (rate is None or dt.date.fromisoformat(p["effective_from"]) <= day):
                rate = p["rate"]
        return rate

    def scheme_for(self, cust: Party, day: dt.date) -> tuple[str | None, int]:
        best = (None, 0)
        for pr in self.promotions:
            if pr.get("_planted"):
                continue
            if not (dt.date.fromisoformat(pr["valid_from"]) <= day <= dt.date.fromisoformat(pr["valid_to"])):
                continue
            if pr["eligible_customers"] is not None and cust.pid not in pr["eligible_customers"]:
                continue
            if pr["discount_bp"] > best[1]:
                best = (pr["scheme_id"], pr["discount_bp"])
        return best

    # Sales

    def new_sale(self, cust: Party, dispatch_at: dt.datetime, value: int | None = None,
                 terms: str | None = None, items: list[str] | None = None, plant: bool = False) -> Sale:
        terms = terms or cust.terms
        if value is None:
            value = min(int(cust.order_value * math.exp(self.rng.gauss(0, 0.25))), 2_200_000_00)
        chosen = items or self.rng.sample(cust.items, k=min(len(cust.items), self.rng.randint(1, 3)))
        order_lag = self.rng.randint(2, 6)
        order_date = dispatch_at.date() - dt.timedelta(days=order_lag)
        scheme_id, disc = self.scheme_for(cust, order_date)
        lines = []
        for code in chosen:
            rate = self.price_on(code, order_date)
            qty = max(1, int(value / len(chosen) / rate))
            lines.append({"item": code, "qty": qty, "rate": rate, "discount_bp": disc})
        sale = Sale(sale_id=self.next_id("S-"), cust=cust, dispatch_at=dispatch_at, items=lines, terms=terms,
                    scheme_id=scheme_id, approver=self.rng.choice(names.APPROVERS),
                    bu={"auto": "Automotive", "industrial": "Industrial", "aftermarket": "Aftermarket"}.get(
                        cust.segment, "Industrial"),
                    unit="Unit-1 Bhosari" if self.rng.random() < 0.65 else "Unit-2 Chakan", entity=cust.entity,
                    enquiry_lag=self.rng.randint(1, 4), order_lag=order_lag, distance=cust.distance,
                    transporter=self.rng.choice(names.TRANSPORTERS), plant=plant)
        hours = cust.distance / 40.0 + 2 + self.rng.random() * 2
        sale.delivered_at = dispatch_at + dt.timedelta(hours=hours)
        self.sales.append(sale)
        return sale

    def plan_regular_sales(self) -> None:
        total = 7000 * self.scale
        wsum = sum(c.weight for c in self.customers if c.regular)
        for c in self.customers:
            if not c.regular or c.kind != "customer":
                continue
            n = max(4, round(total * c.weight / wsum))
            cadence = 365.0 / n
            day = FY_START + dt.timedelta(days=7 + int(self.rng.uniform(0, cadence)))
            while day <= DATA_END - dt.timedelta(days=2):
                hour, minute = self.rng.randint(9, 16), self.rng.choice([0, 10, 20, 30, 40, 50])
                if day >= c.created:
                    self.new_sale(c, at(day, hour, minute))
                day = day + dt.timedelta(days=max(1, round(cadence * self.rng.uniform(0.8, 1.2))))

    def guard_cutoff(self) -> None:
        """Clean data must not straddle the period end: hold delivered-terms dispatches that would arrive later."""
        for s in self.sales:
            if s.plant or not s.has_dispatch or s.delivered_at is None:
                continue
            if s.terms == "DELIVERED" and s.dispatch_at.date() <= FY_END < s.delivered_at.date():
                shift = (FY_END + dt.timedelta(days=1)) - s.dispatch_at.date()
                s.dispatch_at += shift
                s.delivered_at += shift

    # Settlement and credit notes

    def settle_regular(self) -> None:
        for s in self.sales:
            if not s.auto_settle:
                continue
            pay_day = s.invoice_date + dt.timedelta(days=s.cust.pay_days + self.rng.randint(0, 7))
            if pay_day > DATA_END:
                continue
            self.add_receipt(s, pay_day)

    def add_receipt(self, s: Sale, day: dt.date, amount: int | None = None, payer_name: str | None = None,
                    payer_account: str | None = None, no_bank: bool = False, hour: int = 15) -> dict:
        rec = {"t": at(day, hour, self.rng.randint(0, 59)), "sale": s, "no_bank": no_bank, "entity": s.entity,
               "amount": amount, "payer_name": payer_name or s.cust.name,
               "payer_account": payer_account or s.cust.bank["account_no"], "rid": self.next_id("RCPT-"),
               "utr": self.utr()}
        self.receipts.append(rec)
        return rec

    def regular_credit_notes(self) -> None:
        rp = {c.pid for c in self.rp_customers}
        for s in self.sales:
            if s.plant or s.cust.pid in rp or self.rng.random() > 0.015:
                continue
            d = s.invoice_date
            if not (d <= dt.date(2026, 2, 10) or dt.date(2026, 4, 1) <= d <= dt.date(2026, 6, 1)):
                continue
            cn_day = d + dt.timedelta(days=self.rng.randint(12, 28))
            self.add_credit_note(s, cn_day, self.rng.randint(1000, 3500), reason="Quality rejection at customer end")

    def add_credit_note(self, s: Sale, day: dt.date, pct_bp: int, reason: str, approver: str | None = "default",
                        with_return: bool = True, return_lag: int = 2) -> dict:
        line = s.items[0]
        qty = max(1, apply_bp(line["qty"], pct_bp))
        rows = [{"item": line["item"], "qty": qty}]
        taxable = sum(div_round(r["qty"] * line["rate"] * (10000 - line["discount_bp"]), 10000) for r in rows)
        cn = {"t": at(day, 12, self.rng.randint(0, 59)), "sale": s, "pct_bp": pct_bp, "reason": reason,
              "approver": self.rng.choice(names.CN_APPROVERS) if approver == "default" else approver,
              "taxable": taxable, "rows": rows, "with_return": with_return, "return_lag": return_lag,
              "cid": self.next_id("cn:")}
        self.credit_notes.append(cn)
        return cn

    # Purchases

    def regular_purchases(self) -> None:
        mats = ["Steel billets", "MS rounds", "Grey iron castings", "Packing crates", "Cutting oil", "Alloy bars"]
        for v in self.vendors:
            if not v.regular or v.entity != "E1":
                continue
            day = FY_START + dt.timedelta(days=self.rng.randint(0, 20))
            while day <= DATA_END - dt.timedelta(days=5):
                value = int(math.exp(self.rng.gauss(math.log(400000), 0.5))) * 100
                p = self.add_purchase(v, day, value, self.rng.choice(mats))
                pay = day + dt.timedelta(days=self.rng.randint(30, 45))
                if pay <= DATA_END:
                    self.add_payment(v, pay, p["payload"]["gross"], [p["payload"]["purchase_id"]])
                day += dt.timedelta(days=self.rng.randint(20, 40))

    def add_purchase(self, v: Party, day: dt.date, value: int, desc: str = "Raw material",
                     entity: str = "E1") -> dict:
        pid = self.next_id("PUR-")
        rate = 5500_00
        qty = max(1, value // rate)
        taxable = qty * rate
        tax = apply_bp(taxable, 1800)
        own_state = gst.state_of(self.company[entity]["gstin"])
        cgst = sgst = igst = 0
        if v.state == own_state:
            cgst = tax // 2
            sgst = tax - cgst
        else:
            igst = tax
        payload = {"purchase_id": pid, "vendor_id": v.pid, "invoice_no": f"{v.name.split()[0][:3].upper()}/{pid[-5:]}",
                   "date": day.isoformat(), "items": [{"item": desc, "qty": qty, "rate": rate, "amount": taxable}],
                   "taxable_value": taxable, "cgst": cgst, "sgst": sgst, "igst": igst,
                   "gross": taxable + cgst + sgst + igst}
        rec = {"t": at(day, 11, self.rng.randint(0, 59)), "payload": payload, "entity": entity, "vendor": v,
               "grn": {"purchase_id": pid, "date": day.isoformat(), "items": [{"item": desc, "qty": qty}],
                       "vehicle_no": self.vehicle_no()}}
        self.purchases.append(rec)
        return rec

    def add_payment(self, v: Party, day: dt.date, amount: int, refs: list[str], entity: str = "E1",
                    payee_account: str | None = None) -> dict:
        payload = {"payment_id": self.next_id("PAY-"), "vendor_id": v.pid, "amount": amount, "date": day.isoformat(),
                   "payee_account": payee_account or v.bank["account_no"], "utr": self.utr(), "purchase_refs": refs}
        rec = {"t": at(day, 16, self.rng.randint(0, 59)), "payload": payload, "entity": entity, "vendor": v,
               "no_bank": False}
        self.payments.append(rec)
        return rec

    def add_journal(self, day: dt.date, narration: str, lines: list[tuple[str, int, int]], approver: str | None,
                    sale_id: str | None = None, ref: str | None = None) -> dict:
        jid = self.next_id("JV-")
        payload = {"journal_id": jid, "date": day.isoformat(), "narration": narration,
                   "lines": [{"account": a, "debit": d, "credit": c, "ref": ref} for a, d, c in lines],
                   "approver": approver}
        rec = {"t": at(day, 18, self.rng.randint(0, 50)), "payload": payload, "sale_id": sale_id}
        self.journals.append(rec)
        return rec

    def regular_journals(self) -> None:
        day = dt.date(2025, 5, 10)
        while day < DATA_END:
            amount = self.rng.randint(5, 25) * 100000_00 // 10
            self.add_journal(day, f"GST input credit set off against output CGST for {day:%b %Y}",
                             [("2100", amount, 0), ("1300", 0, amount)], "A. Kulkarni (CFO)")
            m = day.month + 1
            day = dt.date(day.year + (m > 12), (m - 1) % 12 + 1, 10)

    # Vehicles

    def vehicle_no(self) -> str:
        return (f"{self.rng.choice(names.VEHICLE_SERIES)}{self.rng.choice('ABCDEFGHJKLMNPRSTUVWXYZ')}"
                f"{self.rng.choice('ABCDEFGHJKLMNPRSTUVWXYZ')}{self.rng.randint(1000, 9999)}")

    def assign_vehicles(self) -> None:
        pool = []
        seen = set()
        while len(pool) < 220:
            v = self.vehicle_no()
            if v not in seen:
                seen.add(v)
                pool.append(v)
        free_at = {v: dt.datetime.min for v in pool}
        for s in sorted(self.sales, key=lambda x: x.dispatch_at):
            if s.vehicle or not s.has_dispatch:
                continue
            end = (s.delivered_at or s.dispatch_at) + dt.timedelta(hours=s.distance / 40.0 + 6)
            order = pool[:]
            self.rng.shuffle(order)
            for v in order:
                if free_at[v] <= s.dispatch_at:
                    s.vehicle = v
                    free_at[v] = end
                    break
            else:
                v = self.vehicle_no()
                pool.append(v)
                s.vehicle = v
                free_at[v] = end
