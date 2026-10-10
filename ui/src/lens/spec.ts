// The generative part: from what the columns mean, Sanchay decides which
// views this file deserves and writes them down as a spec. The page is drawn
// from the spec, and the spec can be read, so every chart says why it is there.

import type { Profile } from "./profile";

interface Base {
  id: string;
  title: string;
  why: string;
  // Wide views span the page; the rest sit two to a row.
  wide?: boolean;
}

export type Widget =
  | (Base & { kind: "field"; date: number; amount: number })
  | (Base & { kind: "timeline"; date: number; amount?: number })
  | (Base & { kind: "calendar"; date: number; amount?: number })
  | (Base & { kind: "map"; state?: number; gstin?: number; amount?: number })
  | (Base & { kind: "pareto"; party: number; amount?: number })
  | (Base & { kind: "category"; column: number; amount?: number })
  | (Base & { kind: "benford"; amount: number })
  | (Base & { kind: "histogram"; amount: number })
  | (Base & { kind: "city"; date: number; party: number; amount: number });

export function buildSpec(p: Profile): Widget[] {
  const name = (i?: number) => (i === undefined ? "" : `"${p.columns[i].name}"`);
  const out: Widget[] = [];
  const n = p.data.length;
  const { date, amount, party, gstin, state } = p;

  if (date !== undefined && amount !== undefined)
    out.push({ id: "field", kind: "field", title: "Every row, as a point", why: `${name(date)} is a date and ${name(amount)} is money, so each row can stand where and how large it is. Rows the tests caught are marked.`, date, amount, wide: true });
  if (date !== undefined)
    out.push({
      id: "timeline",
      kind: "timeline",
      title: amount !== undefined ? "Money by month" : "Rows by month",
      why: amount !== undefined ? `${name(date)} gives each row a month; ${name(amount)} gives it a size.` : `${name(date)} gives each row a month. With no money column, rows are counted.`,
      date,
      amount,
    });

  if (party !== undefined)
    out.push({ id: "pareto", kind: "pareto", title: amount !== undefined ? "Who the money comes from" : "Who appears most", why: `${name(party)} names a party, repeated across rows. A few parties usually carry most of the value.`, party, amount });
  if (date !== undefined && party !== undefined && amount !== undefined)
    out.push({ id: "city", kind: "city", title: "The register as a city", why: `${name(date)}, ${name(party)} and ${name(amount)} give three dimensions: when, who and how much. Each tower is one party in one month.`, date, party, amount, wide: true });
  if (date !== undefined)
    out.push({ id: "calendar", kind: "calendar", title: "Day by day", why: `${name(date)} spans the year, so every day gets a square. Busy days and Sundays stand out.`, date, amount, wide: true });
  if (state !== undefined || gstin !== undefined)
    out.push({ id: "map", kind: "map", title: "Where the sales went", why: state !== undefined ? `${name(state)} holds GST state codes, and each code is a state of India.` : `The first two characters of every GSTIN in ${name(gstin)} name a state of India.`, state, gstin, amount, wide: true });
  // Categories with a handful of values: each gets its own breakdown.
  const cats = p.columns.filter((c) => c.role === "category" && c.distinct >= 2 && c.distinct <= 12).slice(0, 3);
  for (const c of cats)
    out.push({ id: `cat-${c.index}`, kind: "category", title: `By ${c.name}`, why: `${name(c.index)} takes only ${c.distinct} values, so it splits the file cleanly.`, column: c.index, amount });

  if (amount !== undefined && n >= 300)
    out.push({ id: "benford", kind: "benford", title: "Benford's law", why: `${n.toLocaleString("en-IN")} amounts in ${name(amount)} are enough to test whether their first digits fall the way natural figures do.`, amount });
  if (amount !== undefined && n >= 50)
    out.push({ id: "histogram", kind: "histogram", title: "How large the amounts are", why: `${name(amount)} ranges widely, so its sizes are counted on a scale of tens.`, amount });

  return out;
}
