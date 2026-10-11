// Works out what each column of a table means: a date, an amount, a party,
// a GSTIN, a state, a document number, a category. Every decision carries the
// reason it was made, so the page can show it and a reader can change it.

import type { Cell, Table } from "./read";

export type Role = "date" | "amount" | "number" | "party" | "gstin" | "pan" | "state" | "docno" | "category" | "text" | "empty";

export const roleNames: Record<Role, string> = {
  date: "Date",
  amount: "Amount",
  number: "Number",
  party: "Party",
  gstin: "GSTIN",
  pan: "PAN",
  state: "State",
  docno: "Document number",
  category: "Category",
  text: "Text",
  empty: "Empty",
};

export interface Column {
  index: number;
  name: string;
  role: Role;
  reason: string;
  filled: number;
  distinct: number;
  examples: string[];
  sum?: number;
}

export interface Profile {
  table: Table;
  columns: Column[];
  // Rows that hold data, by index into table.rows. Blank and total rows are left out.
  data: number[];
  // Total and subtotal rows, kept apart so they are not counted twice.
  totals: number[];
  // The columns the rest of the page leans on.
  date?: number;
  amount?: number;
  party?: number;
  docno?: number;
  gstin?: number;
  state?: number;
}

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function toNumber(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,₹\s]|Rs\.?/gi, "").replace(/^\((.*)\)$/, "-$1");
  if (!s || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// A day as YYYY-MM-DD, read from a Date, an ISO string, or day-month-year.
export function toDay(v: Cell): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{4})$/);
  if (m) {
    const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase());
    if (mi >= 0) return valid(+m[3], mi + 1, +m[1]);
  }
  return null;
}

function valid(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function text(v: Cell): string {
  if (v === null) return "";
  if (v instanceof Date) return toDay(v) ?? "";
  return String(v).trim();
}

const money = /amount|amt|value|total|gross|net|cost|price|rate|tax|gst|cgst|sgst|igst|tcs|tds|cess|discount|freight|packing|insurance|round|debit|credit|balance|charges|fee|paid|receipt|payment|revenue|sales|turnover|₹|rs\b|inr/i;
const countish = /qty|quantity|count|units|pcs|nos|days|age|year|percent|%|score/i;
const partyish = /customer|party|vendor|supplier|buyer|client|consignee|payee|payer|debtor|creditor|name|account holder/i;
const docish = /bill|invoice|voucher|doc|receipt no|ref|number|no\.?$|#/i;
const stateish = /state|place of supply|pos\b/i;
const idish = /\bid\b|\bcode\b|\bno\b|number|#/i;
const placeish = /country|region|city|zone|territory|district|branch|location/i;

// Reads every column and decides its role. `overrides` replaces a decision.
export function profile(table: Table, overrides: Record<number, Role> = {}): Profile {
  // A row whose first filled text cell says total, or that is entirely blank, is not data.
  const data: number[] = [];
  const totals: number[] = [];
  table.rows.forEach((r, i) => {
    const filled = r.filter((c) => c !== null && c !== "");
    if (!filled.length) return;
    const label = r.find((c) => typeof c === "string" && c.trim()) as string | undefined;
    if (label && /^(grand\s+)?(sub\s*)?total\b/i.test(label.trim())) totals.push(i);
    else data.push(i);
  });

  const columns: Column[] = table.columns.map((name, index) => {
    const values = data.map((i) => table.rows[i][index]).filter((c) => c !== null && c !== "");
    const strs = values.map(text);
    const distinct = new Set(strs).size;
    const examples = [...new Set(strs)].slice(0, 3);
    const base = { index, name, filled: values.length, distinct, examples };
    if (overrides[index]) return { ...base, role: overrides[index], reason: "Set by you." };
    if (!values.length) return { ...base, role: "empty" as Role, reason: "Every cell is blank." };
    const n = values.length;
    const share = (test: (c: Cell, s: string) => boolean) => values.filter((c, i) => test(c, strs[i])).length / n;

    const nums = values.map(toNumber);
    const numShare = nums.filter((x) => x !== null).length / n;
    const dateShare = share((c, s) => c instanceof Date || (typeof c === "string" && !!toDay(s)));
    const sum = nums.reduce<number>((t, x) => t + (x ?? 0), 0);

    if (dateShare >= 0.9) return { ...base, role: "date" as Role, reason: `${pct(dateShare)} of cells read as dates.` };
    if (share((_, s) => GSTIN_RE.test(s.toUpperCase())) >= 0.6 || (/gst/i.test(name) && share((_, s) => s.length === 15) >= 0.8))
      return { ...base, role: "gstin" as Role, reason: "Cells are 15 characters shaped like a GSTIN: state code, PAN, entity, Z, check." };
    if (share((_, s) => PAN_RE.test(s.toUpperCase())) >= 0.8) return { ...base, role: "pan" as Role, reason: "Cells are shaped like a PAN: five letters, four digits, a letter." };
    if (stateish.test(name) && share((_, s) => /^\d{1,2}$/.test(s) && +s >= 1 && +s <= 38) >= 0.9)
      return { ...base, role: "state" as Role, reason: "Named like a state, holding GST state codes from 01 to 38." };
    const unique = distinct / n;
    if (numShare >= 0.9) {
      // Identifiers written as numbers, such as a customer ID or an invoice
      // number, are never money however large they are.
      const whole = nums.every((x) => x === null || Number.isInteger(x));
      if (whole && !money.test(name) && (idish.test(name) || docish.test(name) || partyish.test(name))) {
        if (partyish.test(name) && unique < 0.9) return { ...base, role: "party" as Role, reason: `Named like a party, with ${distinct.toLocaleString("en-IN")} different numbers that repeat.` };
        if (unique >= 0.97) return { ...base, role: "docno" as Role, reason: "Whole numbers named like a document number, almost all different." };
        return { ...base, role: "number" as Role, reason: "Whole numbers named like an identifier, so not money." };
      }
      if (countish.test(name) && !money.test(name)) return { ...base, role: "number" as Role, reason: "Numbers, named like a count or a quantity.", sum };
      if (money.test(name)) return { ...base, role: "amount" as Role, reason: "Numbers, named like money.", sum };
      const decimals = nums.filter((x) => x !== null && Math.round(x * 100) % 100 !== 0).length / n;
      const big = nums.filter((x) => x !== null && Math.abs(x) >= 1000).length / n;
      if (decimals > 0.2 || big > 0.5) return { ...base, role: "amount" as Role, reason: "Large numbers or paise, so treated as money.", sum };
      return { ...base, role: "number" as Role, reason: "Numbers that do not look like money.", sum };
    }
    if (unique >= 0.97 && (docish.test(name) || share((_, s) => /\d{3,}/.test(s) && /[A-Za-z/\-]/.test(s)) >= 0.8))
      return { ...base, role: "docno" as Role, reason: "Almost every value is different and carries a running number." };
    if (partyish.test(name) && unique < 0.9) return { ...base, role: "party" as Role, reason: `Named like a party, with ${distinct.toLocaleString("en-IN")} different names that repeat.` };
    if (placeish.test(name) && unique <= 0.5) return { ...base, role: "category" as Role, reason: `Named like a place, with ${distinct} different values repeated across rows.` };
    if (distinct <= 40 && unique <= 0.5) return { ...base, role: "category" as Role, reason: `Only ${distinct} different values, repeated across rows.` };
    if (unique < 0.6 && share((_, s) => /[A-Za-z]{3,}/.test(s)) >= 0.9) return { ...base, role: "party" as Role, reason: "Names that repeat across rows, like a customer or vendor." };
    if (unique >= 0.97) return { ...base, role: "docno" as Role, reason: "Almost every value is different, like a reference." };
    return { ...base, role: "text" as Role, reason: "Free text." };
  });

  const of = (role: Role) => columns.filter((c) => c.role === role);
  const pick = (role: Role, prefer: RegExp) => {
    const list = of(role);
    return (list.find((c) => prefer.test(c.name)) ?? list[0])?.index;
  };
  // The amount the page leans on: the invoice total, not a tax line.
  // A running balance is never the amount of a row, unless it is the only money column.
  const amounts = of("amount").filter((c, _, all) => all.length === 1 || !/balance|closing|opening/i.test(c.name));
  const amount =
    (amounts.find((c) => /gross|invoice (value|amount)|total amount|grand total|net amount|bill amount/i.test(c.name)) ??
      amounts.find((c) => /amount|amt|value|total/i.test(c.name) && !/tax|gst|tcs|tds|cess/i.test(c.name)) ??
      [...amounts].sort((a, b) => Math.abs(b.sum ?? 0) - Math.abs(a.sum ?? 0))[0])?.index;

  return {
    table,
    columns,
    data,
    totals,
    date: pick("date", /invoice|bill|voucher|^date$/i),
    amount,
    party: pick("party", /customer|buyer|party|client/i),
    docno: pick("docno", /bill|invoice|voucher|doc/i),
    gstin: pick("gstin", /gst/i),
    state: pick("state", /state/i),
  };
}

function pct(x: number) {
  return `${Math.round(x * 100)}%`;
}

// Values of one column for the data rows, in row order.
export function col(p: Profile, index: number | undefined): Cell[] {
  if (index === undefined) return [];
  return p.data.map((i) => p.table.rows[i][index]);
}
