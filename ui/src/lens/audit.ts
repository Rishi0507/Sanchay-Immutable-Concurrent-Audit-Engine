// The audit Sanchay runs in the browser on any register: it seals every row
// into a SHA-256 chain, runs plain tests that need no model, and picks
// samples with a seed that comes from the seal, so nobody chooses them.

import { GSTIN_RE, Profile, col, text, toDay, toNumber } from "./profile";
import type { Table } from "./read";

export type Verdict = "pass" | "flag" | "note" | "skip";

export interface Check {
  id: string;
  title: string;
  // The question the test answers, in plain words.
  asks: string;
  verdict: Verdict;
  // One sentence with the result.
  result: string;
  rows: number[]; // indexes into profile.data
  amount: number;
  // Why each row was caught, by row.
  why?: Map<number, string>;
}

export interface Sample {
  row: number;
  reason: string;
  score: number;
}

export interface Seal {
  head: string;
  rows: number;
  // A few links of the chain to show: row, hash.
  links: { row: number; hash: string }[];
}

export interface Period {
  start: string;
  end: string;
  label: string;
  // Read from the file name rather than the dates.
  named: boolean;
}

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// The GSTIN check character, the same rule as the audit engine (engine/audit_engine/gstin.py).
export function gstinCheck(first14: string): string {
  let total = 0;
  for (let i = 0; i < first14.length; i++) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    total += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (total % 36)) % 36];
}

export function gstinProblem(raw: string): string | null {
  const g = raw.toUpperCase().replace(/\s/g, "");
  if (!g) return "no GSTIN";
  if (g.length !== 15) return `GSTIN has ${g.length} characters, not 15`;
  if (!GSTIN_RE.test(g)) return "GSTIN is not in the legal pattern";
  const st = +g.slice(0, 2);
  if (!((st >= 1 && st <= 38) || st === 97 || st === 99)) return `state code ${g.slice(0, 2)} does not exist`;
  if (gstinCheck(g.slice(0, 14)) !== g[14]) return `check character ${g[14]} should be ${gstinCheck(g.slice(0, 14))}`;
  return null;
}

// The financial year the file covers: from its name ("FY2025-26"), or the
// April to March year that holds most of its dates.
export function periodOf(p: Profile): Period | null {
  const m = p.table.name.match(/FY\s?(\d{4})\s?-\s?(\d{2,4})/i);
  if (m) {
    const y = +m[1];
    return { start: `${y}-04-01`, end: `${y + 1}-03-31`, label: `FY ${y}-${String(y + 1).slice(2)}`, named: true };
  }
  const days = col(p, p.date).map(toDay).filter(Boolean) as string[];
  if (!days.length) return null;
  const years = new Map<number, number>();
  for (const d of days) {
    const [y, mo] = d.split("-").map(Number);
    const fy = mo >= 4 ? y : y - 1;
    years.set(fy, (years.get(fy) ?? 0) + 1);
  }
  const fy = [...years.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { start: `${fy}-04-01`, end: `${fy + 1}-03-31`, label: `FY ${fy}-${String(fy + 1).slice(2)}`, named: false };
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Each row's hash covers the one before it, so changing any row changes
// every hash after it. `onProgress` is called as rows are sealed.
export async function seal(p: Profile, onProgress?: (done: number, hash: string) => void): Promise<Seal> {
  const enc = new TextEncoder();
  let prev = "0".repeat(64);
  const links: Seal["links"] = [];
  const step = Math.max(1, Math.floor(p.data.length / 60));
  for (let k = 0; k < p.data.length; k++) {
    const row = p.table.rows[p.data[k]].map(text);
    prev = hex(await crypto.subtle.digest("SHA-256", enc.encode(prev + JSON.stringify(row))));
    if (k < 3 || k % step === 0 || k === p.data.length - 1) {
      links.push({ row: k, hash: prev });
      onProgress?.(k + 1, prev);
    }
  }
  return { head: prev, rows: p.data.length, links };
}

const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

// Every test the browser can run on this table. A test whose columns are
// missing says so instead of passing.
export function runChecks(p: Profile, related?: Table | null): Check[] {
  const n = p.data.length;
  const amt = col(p, p.amount).map(toNumber);
  const amountOf = (k: number) => Math.abs(amt[k] ?? 0);
  const days = col(p, p.date).map(toDay);
  const docs = col(p, p.docno).map(text);
  const parties = col(p, p.party).map(text);
  const out: Check[] = [];
  const make = (c: Omit<Check, "amount"> & { amount?: number }): Check => ({ ...c, amount: c.amount ?? sum(c.rows.map(amountOf)) });
  const skip = (id: string, title: string, asks: string, need: string): Check => ({ id, title, asks, verdict: "skip", result: `Needs ${need}, which this file does not have.`, rows: [], amount: 0 });
  const plural = (x: number, one: string, many = one + "s") => `${x.toLocaleString("en-IN")} ${x === 1 ? one : many}`;
  const period = periodOf(p);

  // 1. Duplicate document numbers.
  if (p.docno !== undefined) {
    const seen = new Map<string, number[]>();
    docs.forEach((d, k) => d && seen.set(d, [...(seen.get(d) ?? []), k]));
    const rows = [...seen.values()].filter((l) => l.length > 1).flat();
    out.push(make({ id: "dupes", title: "Duplicate numbers", asks: "Is any document number used twice?", verdict: rows.length ? "flag" : "pass", result: rows.length ? `${plural(rows.length, "row")} share a number with another row.` : "Every number is used once.", rows }));
  } else out.push(skip("dupes", "Duplicate numbers", "Is any document number used twice?", "a document number column"));

  // 2. Gaps and numbers outside the series.
  if (p.docno !== undefined) {
    const parsed = docs.map((d, k) => {
      const m = d.match(/^(.*?)(\d+)\D*$/);
      return m ? { k, prefix: m[1], no: +m[2] } : null;
    }).filter(Boolean) as { k: number; prefix: string; no: number }[];
    const prefixes = new Map<string, number>();
    parsed.forEach((x) => prefixes.set(x.prefix, (prefixes.get(x.prefix) ?? 0) + 1));
    const main = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const series = parsed.filter((x) => x.prefix === main).sort((a, b) => a.no - b.no);
    // The series breaks wherever numbers jump far more than they usually step.
    // The body runs from the first to the last stretch that holds at least 1% of
    // the numbers, so a real series with a few wide gaps stays whole. Numbers in
    // small stretches before or after the body are strays.
    const steps = series.slice(1).map((x, i) => x.no - series[i].no).filter((d) => d > 0).sort((a, b) => a - b);
    const usual = steps[Math.floor(steps.length / 2)] ?? 1;
    const jump = Math.max(50, usual * 40);
    const runs: (typeof series)[] = [[]];
    series.forEach((x, i) => {
      if (i && x.no - series[i - 1].no > jump) runs.push([]);
      runs[runs.length - 1].push(x);
    });
    const big = Math.max(1, Math.floor(series.length / 100));
    let first = runs.findIndex((r) => r.length >= big);
    let last = runs.length - 1 - [...runs].reverse().findIndex((r) => r.length >= big);
    if (first < 0) first = last = runs.indexOf(runs.reduce((a, b) => (b.length > a.length ? b : a)));
    const outside = runs.filter((_, i) => i < first || i > last).flat();
    const inside = runs.slice(first, last + 1).flat();
    let gaps = 0;
    const gapAfter: number[] = [];
    for (let i = 1; i < inside.length; i++) {
      const g = inside[i].no - inside[i - 1].no - 1;
      if (g > 0) {
        gaps += g;
        gapAfter.push(inside[i].k);
      }
    }
    const rows = [...outside.map((x) => x.k), ...gapAfter];
    const why = new Map<number, string>();
    outside.forEach((x) => why.set(x.k, `Number ${x.no} sits far outside the run of ${main}…`));
    gapAfter.forEach((k) => why.set(k, "Numbers are missing just before this one"));
    out.push(
      make({
        id: "series",
        title: "Number series",
        asks: "Do the document numbers run without gaps or strays?",
        verdict: rows.length ? "flag" : "pass",
        result: rows.length ? `${outside.length ? `${plural(outside.length, "number")} outside the series` : "No strays"}${gaps ? `, ${plural(gaps, "missing number")} inside it` : ", no gaps"}.` : `${plural(inside.length, "number")} run from ${inside[0]?.no ?? "?"} to ${inside[inside.length - 1]?.no ?? "?"} without a break.`,
        rows,
        why,
      }),
    );
  } else out.push(skip("series", "Number series", "Do the document numbers run without gaps or strays?", "a document number column"));

  // 3. Rows that do not add up: the total against its parts.
  const amountCols = p.columns.filter((c) => c.role === "amount" && c.index !== p.amount);
  if (p.amount !== undefined && amountCols.length >= 3) {
    // A discount is either taken off the total or already netted into the cost.
    // Both readings are tried, and the one most rows agree with is kept.
    const deduction = (name: string) => /discount|rebate|less|deduct|tds/i.test(name);
    const parts0 = amountCols.filter((c) => !/rate|%|percent/i.test(c.name));
    const vals0 = parts0.map((c) => ({ c, d: deduction(c.name), v: col(p, c.index).map(toNumber) }));
    const deductions = vals0.filter((x) => x.d).slice(0, 3);
    let best: { off: number[]; why: Map<number, string>; signs: Map<typeof vals0[number], number> } | null = null;
    for (let mask = 0; mask < 1 << deductions.length; mask++) {
      const signs = new Map(vals0.map((x) => [x, x.d ? (mask & (1 << deductions.indexOf(x)) ? 0 : -1) : 1] as const));
      const off: number[] = [];
      const why = new Map<number, string>();
      amt.forEach((total, k) => {
        if (total === null) return;
        const built = vals0.reduce((t, x) => t + (signs.get(x) ?? 1) * (x.v[k] ?? 0), 0);
        if (Math.abs(total - built) > 1) {
          off.push(k);
          why.set(k, `Parts add to ${built.toLocaleString("en-IN", { maximumFractionDigits: 2 })}, the total says ${total.toLocaleString("en-IN")}`);
        }
      });
      if (!best || off.length < best.off.length) best = { off, why, signs };
    }
    const { off, why, signs } = best!;
    const parts = vals0.filter((x) => signs.get(x) !== 0).map((x) => x.c);
    const sign = (name: string) => (deduction(name) ? -1 : 1);
    // If most rows miss, the guess at how the columns add up is wrong, not the rows.
    if (off.length / n > 0.2)
      out.push({ id: "foot", title: "Rows add up", asks: "Does each row's total equal its parts?", verdict: "skip", result: "Could not tell how the columns add up, so this test did not run.", rows: [], amount: 0 });
    else
      out.push(
        make({
          id: "foot",
          title: "Rows add up",
          asks: `Does ${p.columns[p.amount].name} equal ${parts.map((c) => (sign(c.name) < 0 ? "less " : "") + c.name).join(", ")}?`,
          verdict: off.length ? "flag" : "pass",
          result: off.length ? `${plural(off.length, "row")} do not add up, by more than a rupee.` : `All ${plural(n, "row")} add up to the rupee.`,
          rows: off,
          why,
        }),
      );
  } else out.push(skip("foot", "Rows add up", "Does each row's total equal its parts?", "a total and at least three parts"));

  // 4. GSTIN structure and check character.
  const gstins = col(p, p.gstin).map(text);
  if (p.gstin !== undefined) {
    const why = new Map<number, string>();
    gstins.forEach((g, k) => {
      const problem = g ? gstinProblem(g) : null;
      if (problem) why.set(k, problem);
    });
    const rows = [...why.keys()];
    out.push(make({ id: "gstin", title: "GSTINs are real", asks: "Does every GSTIN pass the government's check character?", verdict: rows.length ? "flag" : "pass", result: rows.length ? `${plural(rows.length, "row")} carry a GSTIN that cannot exist.` : `Every GSTIN passes its check character.`, rows, why }));
  } else out.push(skip("gstin", "GSTINs are real", "Does every GSTIN pass the government's check character?", "a GSTIN column"));

  // 5. State column against the GSTIN's own state.
  const states = col(p, p.state).map((v) => text(v).padStart(2, "0"));
  if (p.gstin !== undefined && p.state !== undefined) {
    const why = new Map<number, string>();
    gstins.forEach((g, k) => {
      if (g.length >= 2 && states[k] && states[k] !== "00" && g.slice(0, 2) !== states[k]) why.set(k, `State ${states[k]}, but the GSTIN belongs to state ${g.slice(0, 2)}`);
    });
    const rows = [...why.keys()];
    out.push(make({ id: "state", title: "State matches GSTIN", asks: "Is the state on each row the state of the customer's GSTIN?", verdict: rows.length ? "flag" : "pass", result: rows.length ? `${plural(rows.length, "row")} name a state the GSTIN does not belong to.` : "Every row's state matches its GSTIN.", rows, why }));
  }

  // 6. Tax type against place of supply: CGST and SGST inside the home state, IGST outside it.
  const find = (re: RegExp) => p.columns.find((c) => c.role === "amount" && re.test(c.name))?.index;
  const igst = find(/igst/i);
  const cgst = find(/cgst/i);
  const sgst = find(/sgst|utgst/i);
  const place = p.state !== undefined ? states : gstins.map((g) => g.slice(0, 2));
  if (igst !== undefined && cgst !== undefined && (p.state !== undefined || p.gstin !== undefined)) {
    const count = new Map<string, number>();
    place.forEach((s) => s && count.set(s, (count.get(s) ?? 0) + 1));
    const home = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const iv = col(p, igst).map(toNumber);
    const cv = col(p, cgst).map(toNumber);
    const sv = sgst !== undefined ? col(p, sgst).map(toNumber) : cv;
    const why = new Map<number, string>();
    place.forEach((s, k) => {
      if (!s) return;
      const i = iv[k] ?? 0;
      const c = (cv[k] ?? 0) + (sv[k] ?? 0);
      if (i === 0 && c === 0) return;
      if (s === home && i > 0) why.set(k, `A sale inside state ${home} charged IGST`);
      else if (s !== home && c > 0) why.set(k, `A sale to state ${s} charged CGST and SGST`);
    });
    const rows = [...why.keys()];
    out.push(make({ id: "taxtype", title: "Right kind of GST", asks: `Is IGST charged outside state ${home}, and CGST with SGST inside it?`, verdict: rows.length ? "flag" : "pass", result: rows.length ? `${plural(rows.length, "row")} charge the wrong kind of GST for where the goods went.` : "Every row charges the right kind of GST.", rows, why }));
  }

  // 7. Dates outside the period.
  if (p.date !== undefined && period) {
    const rows = days.map((d, k) => (d && (d < period.start || d > period.end) ? k : -1)).filter((k) => k >= 0);
    out.push(make({ id: "outside", title: "Inside the year", asks: `Is every row dated within ${period.label}?`, verdict: rows.length ? "flag" : "pass", result: rows.length ? `${plural(rows.length, "row")} fall outside ${period.label}.` : `Every row falls within ${period.label}.`, rows }));
  }

  // 8. Sales booked in the last days of the year, against the rest of the year.
  if (p.date !== undefined && p.amount !== undefined && period) {
    const end = new Date(period.end + "T00:00:00").getTime();
    const windows = new Map<number, number>();
    days.forEach((d, k) => {
      if (!d || d < period.start || d > period.end) return;
      const w = Math.floor((end - new Date(d + "T00:00:00").getTime()) / 864e5 / 10);
      windows.set(w, (windows.get(w) ?? 0) + amountOf(k));
    });
    const last = windows.get(0) ?? 0;
    const rest = [...windows.entries()].filter(([w]) => w > 0).map(([, v]) => v);
    const mean = sum(rest) / Math.max(1, rest.length);
    const sd = Math.sqrt(sum(rest.map((v) => (v - mean) ** 2)) / Math.max(1, rest.length - 1));
    const z = sd ? (last - mean) / sd : 0;
    const rows = days.map((d, k) => (d && d <= period.end && (end - new Date(d + "T00:00:00").getTime()) / 864e5 < 10 ? k : -1)).filter((k) => k >= 0);
    out.push(
      make({
        id: "yearend",
        title: "Year-end rush",
        asks: "Were the last ten days of the year far busier than usual?",
        verdict: z >= 3 ? "flag" : z >= 2 ? "note" : "pass",
        result: `The last ten days booked ${(mean ? last / mean : 0).toFixed(1)} times an ordinary ten days, ${z.toFixed(1)} standard deviations ${z >= 0 ? "above" : "below"} the year.`,
        rows: z >= 2 ? rows : [],
        amount: last,
      }),
    );
  }

  // 9. Benford's law on the first digit of each amount.
  const firsts = amt.filter((x): x is number => x !== null && Math.abs(x) >= 10).map((x) => +String(Math.floor(Math.abs(x))).replace(/^0+/, "")[0]);
  // Benford's law holds for figures that span several orders of magnitude. Invoices
  // that all fall between, say, ₹50,000 and ₹5 lakh are not expected to follow it.
  const sorted = amt.filter((x): x is number => x !== null && x > 0).sort((a, b) => a - b);
  const span = sorted.length ? Math.log10((sorted[Math.floor(sorted.length * 0.95)] || 1) / (sorted[Math.floor(sorted.length * 0.05)] || 1)) : 0;
  if (firsts.length >= 300 && span < 2) {
    out.push({ id: "benford", title: "Benford's law", asks: "Do the first digits of the amounts fall the way natural figures do?", verdict: "note", result: `The middle nine tenths of amounts span only ${span.toFixed(1)} orders of magnitude, too narrow for Benford's law to apply. The chart below shows the digits anyway.`, rows: [], amount: 0 });
  } else if (firsts.length >= 300) {
    const counts = Array(10).fill(0);
    firsts.forEach((d) => counts[d]++);
    let mad = 0;
    for (let d = 1; d <= 9; d++) mad += Math.abs(counts[d] / firsts.length - Math.log10(1 + 1 / d));
    mad /= 9;
    // Nigrini's first-digit bands.
    const band = mad <= 0.006 ? "close conformity" : mad <= 0.012 ? "acceptable conformity" : mad <= 0.015 ? "marginal conformity" : "nonconformity";
    out.push({ id: "benford", title: "Benford's law", asks: "Do the first digits of the amounts fall the way natural figures do?", verdict: mad <= 0.012 ? "pass" : mad <= 0.015 ? "note" : "flag", result: `Mean absolute deviation ${mad.toFixed(4)}: ${band}.`, rows: [], amount: 0 });
  } else out.push(skip("benford", "Benford's law", "Do the first digits of the amounts fall the way natural figures do?", "at least 300 amounts"));

  // 10. Round figures: whole lakhs and ten-thousands are rare in real invoices.
  if (amountCols.length || p.amount !== undefined) {
    const watch = [p.amount, ...amountCols.map((c) => c.index)].filter((i): i is number => i !== undefined);
    const why = new Map<number, string>();
    for (const i of watch) {
      col(p, i).map(toNumber).forEach((v, k) => {
        if (v !== null && Math.abs(v) >= 50000 && v % 10000 === 0 && !why.has(k)) why.set(k, `${p.columns[i].name} is a round ₹${v.toLocaleString("en-IN")}`);
      });
    }
    const rows = [...why.keys()];
    out.push(make({ id: "round", title: "Round figures", asks: "Are there suspiciously round amounts, like exactly ₹6,40,000?", verdict: rows.length > n * 0.02 ? "flag" : rows.length ? "note" : "pass", result: rows.length ? `${plural(rows.length, "row")} carry a round figure of ₹50,000 or more.` : "No suspiciously round amounts.", rows, why }));
  }

  // 11. Sunday bills.
  if (p.date !== undefined) {
    const rows = days.map((d, k) => (d && new Date(d + "T00:00:00").getDay() === 0 ? k : -1)).filter((k) => k >= 0);
    out.push(make({ id: "sunday", title: "Sunday bills", asks: "Were bills raised on a Sunday, when the office is shut?", verdict: rows.length ? "note" : "pass", result: rows.length ? `${plural(rows.length, "row")} dated on a Sunday.` : "No bill is dated on a Sunday.", rows }));
  }

  // 12. Blank cells in columns that are otherwise always filled.
  {
    const why = new Map<number, string>();
    for (const c of p.columns) {
      if (c.role === "empty" || c.filled === n || c.filled < n * 0.95) continue;
      p.data.forEach((ri, k) => {
        const v = p.table.rows[ri][c.index];
        if ((v === null || v === "") && !why.has(k)) why.set(k, `${c.name} is blank`);
      });
    }
    const rows = [...why.keys()];
    out.push(make({ id: "blank", title: "Missing details", asks: "Is any row missing a detail every other row has, such as its order?", verdict: rows.length ? "flag" : "pass", result: rows.length ? `${plural(rows.length, "row")} leave out a detail the rest always carry.` : "No row leaves out a detail.", rows, why }));
  }

  // 13. Amounts far above the rest.
  if (p.amount !== undefined) {
    const sorted = amt.filter((x): x is number => x !== null).map(Math.abs).sort((a, b) => a - b);
    const q = (f: number) => sorted[Math.floor((sorted.length - 1) * f)] ?? 0;
    const fence = q(0.75) + 3 * (q(0.75) - q(0.25));
    const rows = amt.map((v, k) => (v !== null && Math.abs(v) > fence ? k : -1)).filter((k) => k >= 0);
    out.push(make({ id: "outlier", title: "Unusually large", asks: "Are some amounts far above the rest?", verdict: rows.length ? "note" : "pass", result: rows.length ? `${plural(rows.length, "row")} above ₹${Math.round(fence).toLocaleString("en-IN")}, three spreads over the usual range.` : "No amount stands far above the rest.", rows }));
  }

  // 14. Sales to related parties, when the related-party list was dropped too.
  if (related && (p.party !== undefined || p.gstin !== undefined)) {
    const norm = (s: string) => s.toLowerCase().replace(/\b(private|pvt|limited|ltd|llp|co|company|and|&)\b|[^a-z0-9]/g, "");
    const head = related.columns.map((c) => c.toLowerCase());
    const ni = head.findIndex((c) => /name|party/.test(c));
    const gi = head.findIndex((c) => /gst/.test(c));
    const pi = head.findIndex((c) => /^pan/.test(c));
    const fi = head.findIndex((c) => /effective|from|since/.test(c));
    const list = related.rows.map((r) => ({ name: ni >= 0 ? text(r[ni]) : "", gstin: gi >= 0 ? text(r[gi]).toUpperCase() : "", pan: pi >= 0 ? text(r[pi]).toUpperCase() : "", from: fi >= 0 ? toDay(r[fi]) : null })).filter((x) => x.name || x.gstin);
    const why = new Map<number, string>();
    parties.forEach((name, k) => {
      const g = (gstins[k] ?? "").toUpperCase();
      const hit = list.find((r) => (r.gstin && r.gstin === g) || (r.pan && g.slice(2, 12) === r.pan) || (r.name && norm(r.name) === norm(name)));
      if (hit) why.set(k, `${hit.name || hit.gstin} is on the related-party list${hit.from && days[k] && days[k]! < hit.from ? `, but only from ${hit.from}` : ""}`);
    });
    const rows = [...why.keys()];
    out.push(make({ id: "related", title: "Related parties", asks: "Are sales made to parties on the client's related-party list?", verdict: rows.length ? "note" : "pass", result: rows.length ? `${plural(rows.length, "sale")} to ${new Set(rows.map((k) => parties[k])).size} related parties.` : "No sale goes to a party on the list.", rows, why }));
  }

  return out;
}

// A small seeded generator, so the same seal always draws the same samples.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Thirty samples: the five largest, rows caught by the tests, then value-weighted
// draws. The seed is the first eight characters of the seal.
export function pickSamples(p: Profile, checks: Check[], head: string, target = 30): Sample[] {
  const amt = col(p, p.amount).map(toNumber).map((x) => Math.abs(x ?? 0));
  const chosen = new Map<number, Sample>();
  const add = (row: number, reason: string, score: number) => {
    if (chosen.size < target && !chosen.has(row)) chosen.set(row, { row, reason, score });
  };
  const byValue = p.data.map((_, k) => k).sort((a, b) => amt[b] - amt[a]);
  byValue.slice(0, 5).forEach((k) => add(k, "Among the five largest", 3));
  for (const c of checks.filter((c) => c.verdict === "flag")) {
    c.rows
      .slice()
      .sort((a, b) => amt[b] - amt[a])
      .slice(0, 3)
      .forEach((k) => add(k, `Caught by ${c.title.toLowerCase()}`, 2));
  }
  const rand = mulberry32(parseInt(head.slice(0, 8), 16));
  const total = amt.reduce((t, x) => t + x, 0) || 1;
  let guard = 0;
  while (chosen.size < Math.min(target, p.data.length) && guard++ < 5000) {
    let r = rand() * total;
    let k = 0;
    while (k < amt.length - 1 && r > amt[k]) r -= amt[k++];
    add(k, "Value-weighted draw", 1);
  }
  return [...chosen.values()];
}
