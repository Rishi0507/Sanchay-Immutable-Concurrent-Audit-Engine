// Illustrative data for the story page. Everything the 3D scene draws comes
// from this module, typed, so real figures can replace it later without
// touching the scene. It is generated from a fixed seed: the picture is the
// same on every visit.

export type Flag = "no_movement" | "cutoff" | "not_from_sale" | "documents_disagree";

export interface Sale {
  index: number;
  week: number; // 0 is the first week of the year, WEEKS - 1 the last
  customer: number; // row
  invoiceNo: string;
  value: number; // rupees
  height: number; // 0..1, the value on a log scale
  periodEnd: number; // 0..1, how close to the last day of the period
  relatedParty: boolean;
  flag: Flag | null;
  sampled: boolean;
  sampleReason: string | null;
}

export const flagLabel: Record<Flag, string> = {
  no_movement: "No dispatch, e-way bill or delivery behind it",
  cutoff: "Delivered after the period it was booked in",
  not_from_sale: "Revenue posted by a journal, not a sale",
  documents_disagree: "Invoice and e-way bill disagree",
};

// Small deterministic generator (mulberry32).
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Field {
  weeks: number;
  customers: number;
  sales: Sale[];
  relatedRows: number[];
}

export function makeField(weeks: number, customers: number, seed = 20250331): Field {
  const rand = rng(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  // Two customers are related parties; one of them is not disclosed.
  const relatedRows = [Math.floor(customers * 0.22), Math.floor(customers * 0.71)];
  const sales: Sale[] = [];
  for (let c = 0; c < customers; c++) {
    const size = Math.exp(gauss() * 0.45); // some customers are simply bigger
    for (let w = 0; w < weeks; w++) {
      const value = Math.round(Math.exp(11.4 + gauss() * 0.75) * size);
      const periodEnd = Math.max(0, (w - (weeks - 4)) / 3);
      const relatedParty = relatedRows.includes(c);
      let flag: Flag | null = null;
      const r = rand();
      const risk = (relatedParty ? 0.1 : 0.012) + periodEnd * 0.09;
      if (r < risk) {
        const pick = rand();
        flag = periodEnd > 0.3 && pick < 0.45 ? "cutoff" : pick < 0.6 ? "no_movement" : pick < 0.85 ? "documents_disagree" : "not_from_sale";
      }
      sales.push({
        index: sales.length,
        week: w,
        customer: c,
        invoiceNo: `G/${String(sales.length + 1).padStart(4, "0")}/24`,
        value,
        height: 0,
        periodEnd,
        relatedParty,
        flag,
        sampled: false,
        sampleReason: null,
      });
    }
  }
  const max = Math.max(...sales.map((s) => s.value));
  const min = Math.min(...sales.map((s) => s.value));
  for (const s of sales) s.height = (Math.log(s.value) - Math.log(min)) / (Math.log(max) - Math.log(min));

  // Thirty samples, chosen the way the engine is specified to choose them:
  // the largest items, related parties, detector hits, then spread.
  const pick = (s: Sale, reason: string) => {
    if (!s.sampled) {
      s.sampled = true;
      s.sampleReason = reason;
    }
  };
  [...sales].sort((a, b) => b.value - a.value).slice(0, 5).forEach((s) => pick(s, "One of the five largest by value"));
  sales.filter((s) => s.relatedParty && (s.flag || s.periodEnd > 0)).slice(0, 9).forEach((s) => pick(s, "Related party"));
  sales.filter((s) => s.flag && !s.sampled).slice(0, 8).forEach((s) => pick(s, "Detector hit"));
  for (let c = 0; sales.filter((s) => s.sampled).length < 30 && c < customers; c++) {
    const candidates = sales.filter((s) => s.customer === c && !s.sampled);
    pick(candidates[Math.floor(rand() * candidates.length)], "Value-weighted, for customer coverage");
  }
  return { weeks, customers, sales, relatedRows };
}

// The document trail behind a sale. A stack that lacks a document is a sale
// that cannot be proved from end to end.
export const documentNames = ["Enquiry", "Order", "Dispatch", "E-way bill", "Lorry receipt", "Delivery", "Invoice", "Receipt"] as const;

export interface Trail {
  missing: number[]; // indexes into documentNames
}

export const trails: Trail[] = [
  { missing: [] },
  { missing: [] },
  { missing: [7] },
  { missing: [] },
  { missing: [2, 3, 4, 5] }, // an invoice with nothing physical behind it
  { missing: [] },
  { missing: [0] },
  { missing: [] },
  { missing: [3] },
  { missing: [] },
  { missing: [] },
];

// Records for the in-browser proof. The hashes are computed for real.
export interface ProofRecord {
  seq: number;
  invoiceNo: string;
  customer: string;
  amount: number;
}

export const proofRecords: ProofRecord[] = [
  { seq: 1, invoiceNo: "G/0411/24", customer: "Konkan Shipyard", amount: 415000 },
  { seq: 2, invoiceNo: "G/0412/24", customer: "Deepak Chem Tech", amount: 165000 },
  { seq: 3, invoiceNo: "G/0413/24", customer: "Mel Power Systems", amount: 1179000 },
  { seq: 4, invoiceNo: "G/0414/24", customer: "Orbital Electromech", amount: 921000 },
  { seq: 5, invoiceNo: "G/0415/24", customer: "Hooghly Cochin Yard", amount: 914800 },
  { seq: 6, invoiceNo: "G/0416/24", customer: "SPX Flow Technology", amount: 120000 },
];
