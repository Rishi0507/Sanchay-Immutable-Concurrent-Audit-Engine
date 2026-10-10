"""Planted irregularities and answer key (SD-3, SD-4, SD-5, SD-6).

Each scenario changes the world records before they are compiled, and adds
one answer-key item per planted subject. Shapes vary within a category so
that detectors are tested as rule families, not single patterns (PRD 28).
"""

from __future__ import annotations

import copy
import datetime as dt
from typing import Any, Callable

from audit_engine import gstin as gst
from audit_engine.money import apply_bp

from .world import DATA_END, FY_END, FY_START, Party, Sale, World, at


def D(y: int, m: int, d: int) -> dt.date:
    return dt.date(y, m, d)


class Planter:
    def __init__(self, world: World):
        self.w = world
        self.items: list[dict] = []
        self.special: set[str] = set()

    # Answer key

    def key(self, detector: str, category: str, subtype: str, subject_type: str, subject: Any, note: str) -> None:
        self.items.append({"detector": detector, "category": category, "subtype": subtype,
                           "subject_type": subject_type, "subject": subject, "note": note})

    def answer_key(self) -> list[dict]:
        out = []
        for i, it in enumerate(self.items, 1):
            subj = it["subject"]
            if isinstance(subj, Sale):
                sid = subj.invoice_no
            elif isinstance(subj, Party):
                sid = subj.pid
            elif isinstance(subj, dict) and "no" in subj:
                sid = subj["no"]
            elif isinstance(subj, dict) and "payload" in subj and "journal_id" in subj["payload"]:
                sid = subj["payload"]["journal_id"]
            elif callable(subj):
                sid = subj()
            else:
                sid = str(subj)
            out.append({"id": f"P-{i:03d}", "detector": it["detector"], "category": it["category"],
                        "subtype": it["subtype"], "subject_type": it["subject_type"], "subject_id": sid,
                        "note": it["note"]})
        return out

    # Helpers

    def customer(self, name: str, state: str = "27", city: str = "Pune", distance: int = 25,
                 segment: str = "industrial", weight: float = 0.03, regular: bool = True, **kw) -> Party:
        p = self.w.make_party("customer", name, state, city, distance, segment, regular=regular, **kw)
        p.weight = weight
        self.special.add(p.pid)
        return p

    def vendor(self, name: str, state: str = "27", city: str = "Pune", distance: int = 25, **kw) -> Party:
        p = self.w.make_party("vendor", name, state, city, distance, "vendor", regular=False, **kw)
        self.special.add(p.pid)
        return p

    def pick(self, start: dt.date, end: dt.date, pred: Callable[[Sale], bool] = lambda s: True,
             nth: int = 0) -> Sale:
        """Choose a regular sale in a window. The window widens if the dataset is small."""
        rp = {c.pid for c in self.w.rp_customers}
        for widen in (0, 7, 21, 45, 120):
            a, b = start - dt.timedelta(days=widen), end + dt.timedelta(days=widen)
            if b > FY_END >= end:
                b = FY_END
            cands = [s for s in self.w.sales
                     if not s.plant and s.entity == "E1" and a <= s.dispatch_at.date() <= b
                     and s.cust.pid not in self.special and s.cust.pid not in rp and pred(s)]
            if cands:
                cands.sort(key=lambda s: s.sale_id)
                s = cands[(len(cands) // 3 + nth * 7) % len(cands)]
                s.plant = True
                return s
        raise RuntimeError(f"no candidate sale between {start} and {end}")

    @staticmethod
    def stays_in_period(s: Sale) -> bool:
        return s.terms == "EX_WORKS" or (s.delivered_at is not None and s.delivered_at.date() <= FY_END)

    def plant_sale(self, cust: Party, when: dt.datetime, value: int | None = None, terms: str | None = None,
                   **flags) -> Sale:
        s = self.w.new_sale(cust, when, value=value, terms=terms, plant=True)
        for k, v in flags.items():
            setattr(s, k, v)
        return s

    def regular_customer(self, rank_from: int, rank_to: int, segment: str | None = None, state: str | None = None,
                         nth: int = 0) -> Party:
        rp = {c.pid for c in self.w.rp_customers}
        ranked = sorted([c for c in self.w.customers if c.pid not in self.special and c.pid not in rp
                         and (segment is None or c.segment == segment) and (state is None or c.state == state)],
                        key=lambda c: (-c.weight, c.pid))
        if not ranked and state is not None:
            # Small datasets may have no customer in that state. Any other-state customer keeps the shape.
            ranked = sorted([c for c in self.w.customers if c.pid not in self.special and c.pid not in rp
                             and (c.state != "27") == (state != "27")], key=lambda c: (-c.weight, c.pid))
        pool = ranked[rank_from:rank_to] or ranked[len(ranked) // 2:] or ranked
        chosen = pool[nth % len(pool)]
        self.special.add(chosen.pid)
        return chosen

    # Parties (before regular sales are planned)

    def parties(self) -> None:
        w = self.w
        o1, o2, o3, o4 = (w.officer(x) for x in ("O1", "O2", "O3", "O4"))

        # D-02 shared bank account with the Managing Director.
        self.vertex = self.customer("Vertex Industrial Supplies", bank=copy.deepcopy(o1["bank_accounts"][0]))
        self.key("D-02", "RP_UNDISCLOSED", "SHARED_BANK_ACCOUNT", "customer", self.vertex,
                 "Customer bank account is the MD's personal account.")
        # D-02 shared director: CFO's PAN among the customer's directors.
        self.omsai = self.customer("Om Sai Auto Traders", segment="aftermarket",
                                   directors=[{"name": o3["name"], "pan": o3["pan"], "din": "09912345"}])
        self.key("D-02", "RP_UNDISCLOSED", "SHARED_DIRECTOR", "customer", self.omsai,
                 "CFO is a director of the customer.")
        # D-02 two medium signals: same phone and same address as the Company Secretary (address re-typed).
        a = o4["address"]
        variant = {"line1": a["line1"].replace("Plot No.", "Plot no").upper(), "city": a["city"].upper(),
                   "state_code": a["state_code"], "pincode": a["pincode"]}
        self.nexa = self.customer("Nexa Engineering Solutions", phone=o4["phone"].replace("+91", "0"),
                                  address=variant)
        self.key("D-02", "RP_UNDISCLOSED", "SHARED_CONTACT", "customer", self.nexa,
                 "Customer phone and address belong to the Company Secretary.")
        # D-02 receipt paid from the bank account of a disclosed related party.
        self.gajanan = self.customer("Gajanan Steel Mart", segment="aftermarket")
        self.key("D-02", "RP_UNDISCLOSED", "THIRD_PARTY_PAYER", "customer", self.gajanan,
                 "A receipt for this customer came from Mehta Auto Components' account.")

        # D-03 officer appointed partway through the period, already a director of a customer.
        kiran = {"name": "Kiran Joshi", "pan": w.pan("P", "J"), "din": w.din()}
        self.joshi = self.customer("Joshi Precision Tools Pvt Ltd", directors=[dict(kiran), w.person()])
        o6 = {"officer_id": "O6", "name": kiran["name"], "pan": kiran["pan"], "din": kiran["din"],
              "role": "Additional Director", "phone": w.phone(), "email": "kiran.joshi@gmail.com",
              "address": w.address("Pune", "27"), "bank_accounts": [w.account()], "effective_from": "2025-10-01",
              "effective_to": None, "_recorded": True}
        w.officers.append(o6)
        w.extra_events.append({"t": at(D(2025, 10, 1), 10, 0), "event_type": "CompanyOfficerRecorded",
                               "aggregate_id": "O6", "payload": {k: v for k, v in o6.items() if k[0] != "_"},
                               "business_date": "2025-10-01"})
        self.key("D-03", "RP_MID_PERIOD", "LINK_STARTS_IN_PERIOD", "customer", self.joshi,
                 "Director appointed 1 Oct 2025 is a director of the customer.")
        self.key("D-02", "RP_UNDISCLOSED", "SHARED_DIRECTOR", "customer", self.joshi,
                 "Not in the disclosed list.")
        # D-03 customer master updated mid-period to add the MD as a director.
        self.apex = self.customer("Apex Drives Pvt Ltd", segment="auto")
        apex_dirs = self.apex.directors + [{"name": o1["name"], "pan": o1["pan"], "din": o1["din"]}]
        w.extra_events.append({"t": at(D(2025, 12, 1), 11, 0), "event_type": "CustomerUpdated",
                               "aggregate_id": self.apex.pid,
                               "payload": {"customer_id": self.apex.pid, "changes": {"directors": apex_dirs},
                                           "effective_from": "2025-12-01"}, "business_date": "2025-12-01"})
        self.key("D-03", "RP_MID_PERIOD", "LINK_STARTS_IN_PERIOD", "customer", self.apex,
                 "MD added as director of the customer on 1 Dec 2025.")
        self.key("D-02", "RP_UNDISCLOSED", "SHARED_DIRECTOR", "customer", self.apex, "Not in the disclosed list.")
        # D-03 disclosed relationship that begins inside the period.
        self.saiganesh = self.customer("Sai Ganesh Enterprises", segment="aftermarket")
        w.disclosed.append({"name": self.saiganesh.name, "pan": self.saiganesh.pan, "gstin": self.saiganesh.gstin,
                            "relationship": "Entity controlled by a relative of the MD",
                            "effective_from": "2025-11-15"})
        self.key("D-03", "RP_MID_PERIOD", "DISCLOSED_STARTS_IN_PERIOD", "customer", self.saiganesh,
                 "Disclosed relationship begins 15 Nov 2025.")
        # D-03 late disclosure (RP-4): link exists from the start, disclosure says 1 Jan 2026.
        self.mehtabros = self.customer("Mehta Brothers Trading Co", segment="aftermarket",
                                       directors=[{"name": o2["name"], "pan": o2["pan"], "din": o2["din"]}])
        w.disclosed.append({"name": self.mehtabros.name.upper(), "pan": None, "gstin": self.mehtabros.gstin,
                            "relationship": "Director is a partner", "effective_from": "2026-01-01"})
        self.key("D-03", "RP_MID_PERIOD", "LATE_DISCLOSURE", "customer", self.mehtabros,
                 "Director link from 1 Apr 2025, disclosed only from 1 Jan 2026.")

        # D-04 parties.
        pan_n = w.pan("F", "N")
        self.nirmal_c = self.customer("Nirmal Metal Traders", regular=False, pan=pan_n)
        self.nirmal_v = self.vendor("Nirmal Metals", state="24", city="Ahmedabad", distance=660, pan=pan_n,
                                    gstin=gst.make_gstin("24", pan_n, "2"))
        self.trident = self.vendor("Trident Alloys")
        self.sapphire = self.customer("Sapphire Components", regular=False, state="29", city="Bengaluru",
                                      distance=840)
        self.orbit = self.customer("Orbit Auto Ltd", regular=False, segment="auto")
        self.orbit_e2 = self.w.make_party("vendor", "Orbit Auto Ltd", "27", "Pune", 25, "vendor", regular=False,
                                          pan=self.orbit.pan, gstin=self.orbit.gstin,
                                          bank=copy.deepcopy(self.orbit.bank), entity="E2")
        e2 = w.company["E2"]
        self.castings = self.vendor("Shreeji Castings Pvt Ltd", city="Chakan", pan=e2["pan"], gstin=e2["gstin"],
                                    bank={"account_no": e2["bank_accounts"][0]["account_no"],
                                          "ifsc": e2["bank_accounts"][0]["ifsc"]})
        # D-13 linked party for the receipt then payment pattern.
        pan_z = w.pan("C", "Z")
        self.zenith_c = self.customer("Zenith Polymers Pvt Ltd", regular=False, pan=pan_z)
        self.zenith_v = self.vendor("Zenith Polymer Solutions", state="24", city="Vadodara", distance=560,
                                    pan=pan_z, gstin=gst.make_gstin("24", pan_z, "3"))
        # D-08 customer with a GSTIN whose checksum is wrong.
        pan_b = w.pan("F", "B")
        good = gst.make_gstin("27", pan_b)
        bad = good[:-1] + ("A" if good[-1] != "A" else "B")
        self.bharat = self.customer("Bharat Fabricators", pan=pan_b, gstin=bad, weight=0.02)
        self.key("D-08", "DOC_TAX_MISMATCH", "INVALID_GSTIN", "customer", self.bharat,
                 "Customer GSTIN fails the checksum.")
        # D-07 customers chosen from the regular base.
        self.k_cust = self.regular_customer(15, 40, segment="auto")
        self.d_cust = self.regular_customer(30, 60, segment="industrial")
        w.promotions.append({"scheme_id": "YE-PUSH-26", "discount_bp": 1200, "valid_from": "2026-03-20",
                             "valid_to": "2026-03-31", "eligible_customers": [self.k_cust.pid, self.d_cust.pid],
                             "approver": "Rajesh Mehta (MD)", "_created": D(2026, 3, 20), "_planted": True})

    # Sales and money (after regular sales are planned)

    def sales(self) -> None:
        self._movement()
        self._cutoff()
        self._concentration()
        self._tax()
        self._non_sale_revenue()
        self._credit_notes()
        self._promotions()
        self._settlement()
        self._integrity()
        self._cycles()
        self._related_receipts()
        self._reversals()

    def _movement(self) -> None:
        bogus = self.plant_sale(self.vertex, at(D(2026, 3, 27), 16, 10), value=12_00_000_00,
                                has_enquiry=False, has_order=False, has_dispatch=False, auto_settle=False)
        self.key("D-05", "NO_MOVEMENT", "NO_ORDER_NO_DISPATCH", "invoice", bogus,
                 "Invoice to an undisclosed related party with no order, dispatch, LR or delivery.")
        self.key("D-13", "SETTLEMENT", "UNPAID_PERIOD_END", "invoice", bogus, "Never paid.")
        noship = self.plant_sale(self.regular_customer(60, 90), at(D(2025, 9, 14), 11, 30), has_dispatch=False,
                                 auto_settle=True)
        self.key("D-05", "NO_MOVEMENT", "NO_DISPATCH", "invoice", noship, "Order exists, goods never dispatched.")
        s = self.pick(D(2026, 1, 15), D(2026, 1, 25))
        s.has_delivery = False
        self.key("D-05", "NO_MOVEMENT", "NO_DELIVERY", "invoice", s, "Dispatched, no proof of delivery.")
        s = self.pick(D(2025, 7, 1), D(2025, 7, 31), lambda x: x.cust.order_value > 1_00_000_00)
        s.has_ewb = False
        self.key("D-05", "NO_MOVEMENT", "NO_EWAY_BILL", "invoice", s, "Consignment above Rs 50,000, no e-way bill.")
        s = self.pick(D(2025, 10, 20), D(2025, 10, 31))
        s.dispatch_qty_factor_bp = 6000
        self.key("D-05", "NO_MOVEMENT", "QTY_MISMATCH", "invoice", s, "Dispatched 60 percent of invoiced quantity.")
        s = self.pick(D(2025, 5, 10), D(2025, 5, 25))
        s.lr_vehicle = "MH43ZZ9911"
        self.key("D-05", "NO_MOVEMENT", "VEHICLE_CONTRADICTION", "invoice", s,
                 "LR vehicle differs from the dispatch vehicle.")

    def _cutoff(self) -> None:
        far = self.regular_customer(20, 120, state="33")
        s = self.plant_sale(far, at(D(2026, 3, 29), 10, 0), terms="DELIVERED")
        s.delivered_at = at(D(2026, 4, 3), 14, 0)
        self.key("D-06", "CUTOFF", "RECOGNISED_EARLY", "invoice", s,
                 "Delivered terms, invoiced 29 Mar, delivered 3 Apr.")
        far2 = self.regular_customer(20, 120, state="06")
        s = self.plant_sale(far2, at(D(2026, 3, 31), 15, 0), terms="DELIVERED")
        s.delivered_at = at(D(2026, 4, 2), 11, 0)
        self.key("D-06", "CUTOFF", "RECOGNISED_EARLY", "invoice", s,
                 "Delivered terms, invoiced 31 Mar, delivered 2 Apr.")
        near = self.regular_customer(10, 80, state="27", nth=1)
        s = self.plant_sale(near, at(D(2026, 3, 30), 12, 0), terms="EX_WORKS", invoice_date_shift=3)
        self.key("D-06", "CUTOFF", "RECOGNISED_LATE", "invoice", s,
                 "Ex-works, dispatched 30 Mar, invoiced 2 Apr.")

    def _concentration(self) -> None:
        k, d = self.k_cust, self.d_cust
        k_sales = []
        for i, day in enumerate((22, 24, 26, 28, 30, 31)):
            s = self.plant_sale(k, at(D(2026, 3, day), 11 + i % 4, 0), value=2 * k.order_value, terms="EX_WORKS")
            for ln in s.items:
                ln["discount_bp"] = 1200
            s.scheme_id = "YE-PUSH-26"
            k_sales.append(s)
        self.key("D-07", "PERIOD_END_CONCENTRATION", "CUSTOMER_SALES_SPIKE", "customer", k,
                 "Six large invoices in the last 10 days at 12 percent discount.")
        for s in k_sales[3:5]:
            cn = self.w.add_credit_note(s, s.invoice_date + dt.timedelta(days=12), 4000,
                                        reason="Customer returned excess stock")
            self.key("D-11", "CREDIT_NOTE", "POST_PERIOD", "credit_note", cn,
                     "Year-end push reversed after the period end.")
        for i, day in enumerate((23, 27, 30)):
            s = self.plant_sale(d, at(D(2026, 3, day), 10 + i, 30), terms="EX_WORKS")
            for ln in s.items:
                ln["discount_bp"] = 1500
            s.scheme_id = "YE-PUSH-26"
            if i == 0:
                self.key("D-12", "PROMOTION_DISCOUNT", "ABOVE_SCHEME", "invoice", s,
                         "15 percent against a 12 percent scheme.")
        self.key("D-07", "PERIOD_END_CONCENTRATION", "CUSTOMER_DISCOUNT_SPIKE", "customer", d,
                 "Discount rises to 15 percent in the last 10 days.")

    def _tax(self) -> None:
        for nth, (a, b) in enumerate(((D(2025, 6, 1), D(2025, 6, 30)), (D(2026, 2, 1), D(2026, 2, 20)))):
            s = self.pick(a, b, nth=nth)
            s.gstr1_omit = True
            self.key("D-08", "DOC_TAX_MISMATCH", "MISSING_IN_GSTR1", "invoice", s, "Invoice left out of GSTR-1.")
        some = self.w.customers[10]
        self.w.extra_gstr1.append({"invoice_no": "SPC/25-26/09999", "invoice_date": "2025-12-15",
                                   "gstin": some.gstin, "taxable_value": 4_75_000_00, "cgst": 42_750_00,
                                   "sgst": 42_750_00, "igst": 0, "place_of_supply": some.state})
        self.key("D-08", "DOC_TAX_MISMATCH", "GSTR1_WITHOUT_INVOICE", "gstr1_line", "SPC/25-26/09999",
                 "GSTR-1 line with no invoice behind it.")
        s = self.pick(D(2025, 8, 1), D(2025, 8, 31), lambda x: x.cust.state == "27")
        s.force_tax = "IGST"
        self.key("D-08", "DOC_TAX_MISMATCH", "WRONG_TAX_TYPE", "invoice", s, "IGST on an intra-state supply.")
        s = self.pick(D(2025, 11, 20), D(2025, 12, 20), lambda x: x.cust.state != "27")
        s.force_tax = "CGST_SGST"
        self.key("D-08", "DOC_TAX_MISMATCH", "WRONG_TAX_TYPE", "invoice", s, "CGST and SGST on an inter-state supply.")
        s = self.pick(D(2025, 9, 1), D(2025, 9, 30), lambda x: x.cust.order_value > 1_00_000_00, nth=2)
        s.ewb_value_delta = 1_50_000_00
        self.key("D-08", "DOC_TAX_MISMATCH", "EWAY_BILL_VALUE", "invoice", s,
                 "E-way bill value Rs 1.5 lakh higher than the invoice.")
        s = self.pick(D(2026, 1, 5), D(2026, 1, 25), nth=1)
        s.gstr1_taxable_delta = -50_000_00
        self.key("D-08", "DOC_TAX_MISMATCH", "GSTR1_VALUE", "invoice", s,
                 "GSTR-1 taxable value Rs 50,000 lower than the invoice.")
        self.key("D-08", "DOC_TAX_MISMATCH", "GSTR1_TOTAL", "period", "2025-12",
                 "December GSTR-1 total differs from the ledger.")

    def _non_sale_revenue(self) -> None:
        w = self.w
        j1 = w.add_journal(D(2026, 3, 31), "Year-end sales accrual pending invoicing",
                           [("9000", 15_00_000_00, 0), ("4000", 0, 15_00_000_00)], "Rajesh Mehta (MD)")
        self.key("D-09", "NON_SALE_REVENUE", "CREDIT_FROM_SUSPENSE", "journal", j1, "Suspense to Sales.")
        j2 = w.add_journal(D(2026, 2, 27), f"Sales booked for {self.vertex.name}",
                           [("1100", 8_00_000_00, 0), ("4000", 0, 8_00_000_00)], None)
        self.key("D-09", "NON_SALE_REVENUE", "MANUAL_RECEIVABLE", "journal", j2,
                 "Receivable and Sales raised by journal with no sale and no approver.")
        j3 = w.add_journal(D(2025, 12, 15), "Miscellaneous receipts reclassified",
                           [("1000", 3_00_000_00, 0), ("4000", 0, 3_00_000_00)], "A. Kulkarni (CFO)")
        self.key("D-09", "NON_SALE_REVENUE", "CREDIT_FROM_BANK", "journal", j3, "Bank credit routed to Sales.")

    def _credit_notes(self) -> None:
        w = self.w
        s = self.pick(D(2026, 3, 12), D(2026, 3, 20), self.stays_in_period)
        cn = w.add_credit_note(s, D(2026, 4, 8), 2000, reason="Price difference")
        self.key("D-11", "CREDIT_NOTE", "POST_PERIOD", "credit_note", cn, "Credit note after the period end.")
        s = self.pick(D(2026, 3, 26), D(2026, 3, 30), self.stays_in_period)
        s.auto_settle = False
        cn = w.add_credit_note(s, D(2026, 4, 12), 9000, reason="Order cancelled by customer", with_return=False)
        self.key("D-11", "CREDIT_NOTE", "MOST_OF_PERIOD_END_INVOICE", "credit_note", cn,
                 "90 percent of a period-end invoice credited after the period end, no goods returned.")
        s = self.pick(D(2025, 11, 25), D(2025, 12, 5))
        cn = w.add_credit_note(s, D(2025, 12, 15), 1500, reason="Rate difference", approver=None)
        self.key("D-11", "CREDIT_NOTE", "NO_APPROVER", "credit_note", cn, "Credit note without an approver.")
        rp1 = w.rp_customers[0]
        rp_sales = [x for x in w.sales if x.cust is rp1 and D(2025, 10, 15) <= x.dispatch_at.date() <= D(2025, 11, 30)]
        if not rp_sales:
            rp_sales = [self.plant_sale(rp1, at(D(2025, 11, 4), 12, 0))]
        s = sorted(rp_sales, key=lambda x: x.sale_id)[0]
        s.plant = True
        cn = w.add_credit_note(s, s.invoice_date + dt.timedelta(days=18), 2500, reason="Quality rejection")
        self.key("D-11", "CREDIT_NOTE", "RELATED_PARTY", "credit_note", cn, "Credit note to a disclosed related party.")
        s = self.pick(D(2026, 1, 2), D(2026, 1, 12))
        cn = w.add_credit_note(s, D(2026, 1, 28), 2000, reason="Short supply adjustment", with_return=False)
        self.key("D-11", "CREDIT_NOTE", "NO_RETURN", "credit_note", cn, "No sales return recorded.")

    def _promotions(self) -> None:
        w = self.w
        s = self.pick(D(2025, 8, 1), D(2025, 8, 31), lambda x: x.scheme_id is None, nth=3)
        for ln in s.items:
            ln["discount_bp"] = 800
        self.key("D-12", "PROMOTION_DISCOUNT", "NO_SCHEME", "invoice", s, "8 percent discount with no scheme.")
        s = self.pick(D(2025, 10, 10), D(2025, 11, 10), lambda x: x.scheme_id == "FESTIVE-25")
        for ln in s.items:
            ln["discount_bp"] = 1200
        self.key("D-12", "PROMOTION_DISCOUNT", "ABOVE_SCHEME", "invoice", s, "12 percent against a 5 percent scheme.")
        s = self.pick(D(2026, 1, 10), D(2026, 1, 31), lambda x: x.scheme_id is None)
        s.scheme_id = "FESTIVE-25"
        for ln in s.items:
            ln["discount_bp"] = 500
        self.key("D-12", "PROMOTION_DISCOUNT", "OUTSIDE_SCHEME_DATES", "invoice", s,
                 "Festive scheme applied in January.")
        eligible = set(next(p for p in w.promotions if p["scheme_id"] == "VOL-AUTO-25")["eligible_customers"])
        s = self.pick(D(2025, 6, 1), D(2025, 6, 30), lambda x: x.scheme_id is None and x.cust.pid not in eligible,
                      nth=1)
        s.scheme_id = "VOL-AUTO-25"
        for ln in s.items:
            ln["discount_bp"] = 300
        self.key("D-12", "PROMOTION_DISCOUNT", "INELIGIBLE_CUSTOMER", "invoice", s,
                 "Volume scheme for a customer not on the scheme list.")
        s = self.pick(D(2025, 7, 1), D(2025, 7, 31), lambda x: x.scheme_id is None, nth=4)
        for ln in s.items:
            ln["rate"] = apply_bp(ln["rate"], 8500)
        s.approver = None
        self.key("D-12", "PROMOTION_DISCOUNT", "BELOW_PRICE_LIST", "invoice", s,
                 "Rate 15 percent below the price list with no approver.")

    def _settlement(self) -> None:
        w = self.w
        s = self.pick(D(2025, 10, 1), D(2025, 10, 15))
        s.auto_settle = False
        w.add_receipt(s, s.invoice_date + dt.timedelta(days=35), no_bank=True)
        self.key("D-13", "SETTLEMENT", "NO_BANK_LINE", "invoice", s, "Receipt not on any bank statement.")
        for nth in range(2):
            s = self.pick(D(2026, 3, 22), D(2026, 3, 29), self.stays_in_period, nth=nth)
            s.auto_settle = False
            self.key("D-13", "SETTLEMENT", "UNPAID_PERIOD_END", "invoice", s,
                     "Period-end invoice unpaid more than 90 days later.")
        # Receipt from customer, then a similar payment to a linked vendor within 7 days.
        z = self.plant_sale(self.zenith_c, at(D(2026, 1, 20), 11, 0), value=15_00_000_00, auto_settle=False)
        self.zenith_sale = z
        self.zenith_receipt = w.add_receipt(z, D(2026, 2, 10))
        self.key("D-13", "SETTLEMENT", "ROUND_TRIP_PAYMENT", "invoice", z,
                 "Receipt followed four days later by a similar payment to a vendor with the same PAN.")

    def _integrity(self) -> None:
        w = self.w
        s = self.pick(D(2025, 9, 10), D(2025, 9, 20))
        s.skip_number_before = True
        self.key("D-14", "DOCUMENT_INTEGRITY", "NUMBER_GAP", "invoice", s, "One invoice number skipped before this one.")
        orig = self.pick(D(2025, 12, 9), D(2025, 12, 9))
        dup = self.plant_sale(self.regular_customer(40, 100), at(D(2025, 12, 10), 15, 0), dup_of=orig)
        self.key("D-14", "DOCUMENT_INTEGRITY", "DUPLICATE_NUMBER", "invoice", dup, "Invoice number used twice.")
        late = self.plant_sale(self.regular_customer(40, 100, nth=1), at(D(2026, 3, 25), 10, 0), terms="EX_WORKS",
                               record_delay_days=12)
        self.key("D-14", "DOCUMENT_INTEGRITY", "BACKDATED", "invoice", late,
                 "Invoice dated 25 Mar 2026 recorded 6 Apr 2026.")
        s = self.pick(D(2025, 8, 18), D(2025, 8, 26), lambda x: x.terms == "EX_WORKS")
        s.invoice_date_shift = -6
        s.record_delay_days = 6
        self.key("D-14", "DOCUMENT_INTEGRITY", "OUT_OF_DATE_ORDER", "invoice", s,
                 "Invoice dated six days before the invoices numbered just before it.")
        a = self.pick(D(2025, 11, 3), D(2025, 11, 8), lambda x: x.cust.order_value > 1_00_000_00)
        b = self.pick(D(2025, 11, 12), D(2025, 11, 18), lambda x: x.cust.order_value > 1_00_000_00)
        a.has_ewb = True
        b.has_ewb = True
        b.ewb_from = a
        self.key("D-14", "DOCUMENT_INTEGRITY", "EWAY_BILL_REUSED", "invoice", b,
                 "E-way bill number of another invoice.")
        s = self.pick(D(2025, 6, 1), D(2025, 6, 30), lambda x: x.distance >= 200)
        s.delivered_at = s.dispatch_at + dt.timedelta(minutes=max(30, s.distance * 60 // 150))
        self.key("D-14", "DOCUMENT_INTEGRITY", "IMPOSSIBLE_DELIVERY", "invoice", s,
                 "Delivered at an average of about 150 km per hour.")
        self.overlap = (self.pick(D(2026, 2, 2), D(2026, 2, 6), lambda x: x.distance >= 100),
                        self.pick(D(2026, 2, 9), D(2026, 2, 13), lambda x: x.distance >= 100))

    def _cycles(self) -> None:
        w = self.w
        # Goods cycle through a customer and a vendor sharing a PAN.
        s = self.plant_sale(self.nirmal_c, at(D(2025, 11, 10), 11, 0), value=25_00_000_00)
        p = w.add_purchase(self.nirmal_v, D(2025, 11, 28), 23_00_000_00, "MS rounds")
        w.add_payment(self.nirmal_v, D(2026, 1, 5), p["payload"]["gross"], [p["payload"]["purchase_id"]])
        self.key("D-04", "CIRCULAR_TRADING", "GOODS_CYCLE", "invoice", s,
                 "Sale to Nirmal Metal Traders returns as a purchase from Nirmal Metals (same PAN).")
        # Money cycle: company pays a vendor, the vendor pays a customer's invoice.
        p = w.add_purchase(self.trident, D(2026, 1, 25), 30_00_000_00, "Alloy bars")
        w.add_payment(self.trident, D(2026, 2, 5), p["payload"]["gross"], [p["payload"]["purchase_id"]])
        s2 = self.plant_sale(self.sapphire, at(D(2026, 1, 28), 12, 0), value=30_00_000_00, auto_settle=False)
        w.add_receipt(s2, D(2026, 2, 20), payer_name=self.trident.name,
                      payer_account=self.trident.bank["account_no"])
        self.key("D-04", "CIRCULAR_TRADING", "MONEY_CYCLE", "invoice", s2,
                 "Company pays Trident Alloys, Trident pays Sapphire's invoice.")
        self.key("D-13", "SETTLEMENT", "THIRD_PARTY_PAYER", "invoice", s2, "Paid from Trident Alloys' account.")
        # Three-party goods cycle through group entity E2.
        s3 = self.plant_sale(self.orbit, at(D(2026, 1, 5), 11, 0), value=20_00_000_00)
        w.add_purchase(self.orbit_e2, D(2026, 1, 20), 19_00_000_00, "Machined components", entity="E2")
        p = w.add_purchase(self.castings, D(2026, 2, 10), 18_50_000_00, "Grey iron castings")
        w.add_payment(self.castings, D(2026, 3, 10), p["payload"]["gross"], [p["payload"]["purchase_id"]])
        self.key("D-04", "CIRCULAR_TRADING", "GOODS_CYCLE", "invoice", s3,
                 "Company to Orbit, Orbit to group entity E2, E2 back to the company.")

    def _related_receipts(self) -> None:
        w = self.w
        g = [x for x in w.sales if x.cust is self.gajanan and D(2025, 9, 1) <= x.dispatch_at.date() <= D(2025, 12, 31)]
        s = sorted(g, key=lambda x: x.sale_id)[0] if g else self.plant_sale(self.gajanan, at(D(2025, 10, 7), 11, 0))
        s.plant = True
        s.auto_settle = False
        rp1 = w.rp_customers[0]
        w.add_receipt(s, s.invoice_date + dt.timedelta(days=30), payer_name=rp1.name,
                      payer_account=rp1.bank["account_no"])
        self.key("D-13", "SETTLEMENT", "THIRD_PARTY_PAYER", "invoice", s,
                 "Paid from the account of Mehta Auto Components.")

    def _reversals(self) -> None:
        w = self.w
        self.reversed = []
        for nth, (a, b) in enumerate(((D(2025, 6, 10), D(2025, 6, 20)), (D(2025, 11, 17), D(2025, 11, 22)))):
            orig = self.pick(a, b, lambda x: x.terms == "EX_WORKS", nth=nth)
            orig.reversed_on = orig.invoice_date + dt.timedelta(days=2)
            orig.reverse_reason = "Wrong rate charged. Reissued."
            orig.auto_settle = False
            re = self.plant_sale(orig.cust, orig.dispatch_at, has_enquiry=False, has_order=False,
                                 has_dispatch=False)
            re.items = [dict(x) for x in orig.items]
            re.terms, re.bu, re.unit, re.scheme_id = orig.terms, orig.bu, orig.unit, orig.scheme_id
            re.link_to = orig
            re.key = re.sale_id[2:]
            re.sale_id = orig.sale_id
            re.reissue_at = at(orig.reversed_on, 17, 45)
            self.reversed.append(orig)
            self.key("D-01", "REGISTER_MISMATCH", "REVERSED_IN_SYSTEM", "invoice", orig,
                     "Reversed invoice still listed in the register.")

    # After vehicle allocation

    def after_vehicles(self) -> None:
        from .compile import compute_invoice

        a, b = self.overlap
        shift = (a.dispatch_at + dt.timedelta(hours=2)) - b.dispatch_at
        b.dispatch_at += shift
        b.delivered_at = b.dispatch_at + dt.timedelta(hours=b.distance / 40.0 + 2)
        b.vehicle = a.vehicle
        self.key("D-14", "DOCUMENT_INTEGRITY", "VEHICLE_OVERLAP", "invoice", b,
                 "Same vehicle on two trips at the same time.")
        # Payment to the linked vendor four days after the customer's receipt, about the same amount.
        gross = compute_invoice(self.w, self.zenith_sale)["gross"]
        self.w.add_payment(self.zenith_v, D(2026, 2, 14), gross + gross // 100, [])

    # After compile

    def register(self) -> None:
        w = self.w
        rp = {c.pid for c in w.rp_customers}
        pool = [s for s in w.sales if not s.plant and s.entity == "E1" and FY_START <= s.invoice_date <= FY_END
                and s.cust.pid not in self.special and s.cust.pid not in rp]
        pool.sort(key=lambda s: s.sale_id)
        step = max(1, len(pool) // 23)
        chosen = [pool[i * step] for i in range(1, 12)]
        for s in chosen:
            s.plant = True
        plants: dict[str, Any] = {"keep_reversed": True, "drop": chosen[0:2], "dup": chosen[2:4],
                                  "field": [], "arith": [], "fake": []}
        for s in chosen[0:2]:
            self.key("D-01", "REGISTER_MISMATCH", "MISSING_IN_REGISTER", "invoice", s, "Left out of the register.")
        for s in chosen[2:4]:
            self.key("D-01", "REGISTER_MISMATCH", "DUPLICATE_ROW", "invoice", s, "Listed twice in the register.")
        s = chosen[4]
        plants["field"] += [(s, "Total Cost", round(s.invoice["taxable_value"] / 100 + 100000, 2)),
                            (s, "Gross Amt.", round(s.invoice["gross"] / 100 + 100000, 2))]
        self.key("D-01", "REGISTER_MISMATCH", "FIELD_DIFFERENCE", "invoice", s,
                 "Register taxable value and gross Rs 1 lakh higher than the invoice.")
        s = chosen[5]
        other = next(c for c in w.customers if c.pid != s.cust.pid and c.state == s.cust.state)
        plants["field"].append((s, "GST No.", other.gstin))
        self.key("D-01", "REGISTER_MISMATCH", "FIELD_DIFFERENCE", "invoice", s, "Register GSTIN of another customer.")
        s = chosen[6]
        plants["field"].append((s, "Date", dt.datetime.combine(s.invoice_date + dt.timedelta(days=9), dt.time())))
        self.key("D-01", "REGISTER_MISMATCH", "FIELD_DIFFERENCE", "invoice", s, "Register date nine days later.")
        for s in chosen[7:9]:
            plants["arith"].append((s, "Freight", 500.0))
            self.key("D-01", "REGISTER_MISMATCH", "ROW_ARITHMETIC", "invoice", s,
                     "Freight changed so the row does not foot.")
        c1, c2 = w.customers[20], w.customers[33]
        for no, cust, day, taxable in (("SPC/25-26/09901", c1, D(2026, 3, 30), 640000.0),
                                       ("SPC/25-26/09902", c2, D(2026, 2, 14), 215500.0)):
            intra = cust.state == "27"
            tax = round(taxable * 0.18, 2)
            plants["fake"].append({
                "Bill no.": no, "Date": dt.datetime.combine(day, dt.time()), "Job No.": "", "Customer": cust.name,
                "Ledger Account": "Sales Revenue", "State Code": cust.state, "GST No.": cust.gstin,
                "Total Cost": taxable, "Discount": 0.0, "Packing": 0.0, "Freight": 0.0, "Insurance": 0.0,
                "IGST": 0.0 if intra else tax, "CGST": round(tax / 2, 2) if intra else 0.0,
                "SGST": round(tax / 2, 2) if intra else 0.0, "TCS Collection": 0.0, "Round": 0.0,
                "Gross Amt.": round(taxable + tax, 2), "Tax": "GST 18%", "BU": "Industrial", "E Invoice": "Generated"})
            self.key("D-01", "REGISTER_MISMATCH", "NOT_IN_SYSTEM", "register_row", no, "Register row with no invoice.")
        self.key("D-01", "REGISTER_MISMATCH", "TOTAL_NOT_AGREED_TO_LEDGER", "period", "FY2025-26",
                 "Register total differs from Sales in the ledger.")
        w.register_plants = plants
