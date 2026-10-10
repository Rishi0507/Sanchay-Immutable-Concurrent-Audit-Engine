// A client's document, held to the light. The paper the client uploaded is
// drawn as it is, a beam passes down it, and every value on it is compared
// with the books: what agrees lights up green, and what the engine's evidence
// checks caught lights up pink with the figure the books hold beside it.
//
// Nothing here is drawn in advance. The marks come from the text of that one
// document, the records of that one sale and the findings the engine raised
// on it, so two documents never light up the same way. A document in Hindi or
// Marathi is treated like any other: its figures and numbers are what is
// compared, and those are written the same in every language.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { callTool, getToken, money } from "../api";
import { Mark, cx } from "../ui";
import type { FindingLite } from "./kit";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface EvidenceDoc {
  document_type: string;
  status: string;
  file_hash: string | null;
}

interface SampleRef {
  sample_id: string;
  invoice_no?: string;
  credit_note_no?: string;
  customer?: string;
  taxable_value?: number;
  detail?: Record<string, any>;
}

const DOC: Record<string, string> = { invoice: "Invoice", eway_bill: "E-way bill", lr_copy: "Lorry receipt", proof_of_delivery: "Proof of delivery", credit_note: "Credit note", sales_return: "Goods return note" };
const STAGE: Record<string, string> = { invoice: "invoice", eway_bill: "eway_bill", lr_copy: "lorry_receipt", proof_of_delivery: "delivery", credit_note: "credit_note", sales_return: "sales_return" };
const STAGE_NAME: Record<string, string> = { enquiry: "Enquiry", order: "Order", dispatch: "Dispatch", eway_bill: "E-way bill", lorry_receipt: "Lorry receipt", delivery: "Delivery", invoice: "Invoice", receipt: "Payment", credit_note: "Credit note", sales_return: "Goods return" };
const NAME: Record<string, string> = {
  invoice_no: "Invoice number", order_no: "Order number", lr_no: "Lorry receipt number", ewb_no: "E-way bill number", credit_note_no: "Credit note number",
  vehicle_no: "Vehicle number", customer_gstin: "Buyer's GSTIN", recipient_gstin: "Buyer's GSTIN", supplier_gstin: "Seller's GSTIN", gross: "Invoice total",
  value: "Invoice value", igst: "IGST", cgst: "CGST", sgst: "SGST", freight: "Freight", insurance: "Insurance", packing: "Packing", distance_km: "Distance in km",
  qty: "Quantity", rate: "Rate", item_code: "Item", transporter: "Transporter", consignee: "Buyer", payer_name: "Payer", pod_reference: "Proof of delivery reference",
  amount: "Amount", valid_until: "Valid until", dispatched_at: "Dispatch date", delivered_at: "Delivery date", from_address: "Dispatched from", to_address: "Delivered to",
  job_no: "Order number", irn: "E-invoice number (IRN)", utr: "Bank reference", round_off: "Rounding", taxable: "Taxable value",
};

// One thing the books hold about this sale, in the forms a document may write it.
interface Fact {
  name: string;
  stage: string;
  number?: number;
  date?: string;
  id?: string;
  text?: string;
}

interface Word {
  text: string;
  x: number;
  y: number; // top
  w: number;
  h: number;
  base: number;
}

interface Reading {
  key: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  agrees: boolean;
  // An amount printed on the paper that no record of the sale holds, and that no check named.
  odd?: boolean;
  name: string;
  note?: string;
}

const asNumber = (t: string) => {
  const m = t.replace(/^Rs\.?/i, "").replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(m) ? Number(m) : null;
};
const asDate = (t: string) => {
  const m = t.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};
const asId = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");
const bare = (t: string) => t.replace(/^[(]+|[),.;:]+$/g, "");

// The records of one sale as facts. A date and time kept in UTC is turned to the Indian date a document prints.
function factsOf(events: { type: string; data: Record<string, any> }[], sample: SampleRef, first: string): Fact[] {
  const out: Fact[] = [];
  const add = (stage: string, key: string, v: unknown) => {
    const name = key === "date" ? `${STAGE_NAME[stage] ?? stage} date` : (NAME[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
    if (typeof v === "number") out.push({ name, stage, number: v });
    else if (typeof v === "string" && v) {
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) out.push({ name, stage, date: new Date(Date.parse(v) + 19_800_000).toISOString().slice(0, 10) });
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) out.push({ name, stage, date: v });
      else out.push({ name, stage, id: asId(v), text: v.toLowerCase() });
    }
  };
  for (const e of events) {
    for (const [k, v] of Object.entries(e.data ?? {})) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === "object") {
            for (const [ik, iv] of Object.entries(item)) add(e.type, ik, iv);
            if (typeof item.qty === "number" && typeof item.rate === "number") out.push({ name: "Line amount", stage: e.type, number: Math.round(item.qty * item.rate * 100) / 100 });
          }
        }
      } else add(e.type, k, v);
    }
  }
  if (sample.taxable_value !== undefined) out.push({ name: "Taxable value", stage: "invoice", number: Number(sample.taxable_value) });
  if (sample.customer) out.push({ name: "Buyer", stage: "invoice", id: asId(sample.customer), text: sample.customer.toLowerCase() });
  // What the document's own stage holds is preferred when two records carry the same value.
  return out.sort((a, b) => Number(b.stage === first) - Number(a.stage === first));
}

// The engine's findings on this document: the sentence after "Sample ..., invoice:" in each reason.
function caughtOn(findings: FindingLite[], type: string) {
  const words = type.replace(/_/g, " ");
  return findings
    .filter((f) => f.category === "EVIDENCE_SUSPECT")
    .map((f) => ({ f, said: (f.reason ?? "").match(new RegExp(`\\), ${words}: (.*?)(?: \\(SA [^)]*\\))?\\.?$`))?.[1] }))
    .filter((x): x is { f: FindingLite; said: string } => !!x.said);
}

function read(lines: Word[][], facts: Fact[], caught: { said: string }[]): Reading[] {
  const flagged = new Map<string, string>();
  for (const c of caught) for (const t of c.said.split(/\s+/).map(bare)) if (t.length >= 4 && /\d/.test(t)) flagged.set(t, c.said);
  const find = (t: string): Fact | undefined => {
    const d = asDate(t);
    if (d) return facts.find((f) => f.date === d);
    const n = asNumber(t);
    if (n !== null && (t.includes(".") || t.replace(/\D/g, "").length >= 3)) {
      const hit = facts.find((f) => f.number !== undefined && Math.abs(f.number - n) < 0.006);
      if (hit) return hit;
    }
    const id = asId(t);
    return id.length >= 6 && /\d/.test(id) ? facts.find((f) => f.id === id) : undefined;
  };
  const box = (ws: Word[]) => {
    const x = Math.min(...ws.map((w) => w.x));
    const y = Math.min(...ws.map((w) => w.y));
    return { x, y, w: Math.max(...ws.map((w) => w.x + w.w)) - x, h: Math.max(...ws.map((w) => w.y + w.h)) - y };
  };
  const out: Reading[] = [];
  lines.forEach((line, li) => {
    // What follows the label is one value, which may be several words: a name, or a number printed in groups.
    const colon = line.findIndex((w) => w.text.endsWith(":"));
    const run = colon >= 0 ? line.slice(colon + 1).filter((w) => !/^Rs\.?$/i.test(w.text)) : [];
    if (run.length > 1) {
      const whole = run.map((w) => w.text).join(" ");
      const id = asId(whole);
      const hit = facts.find((f) => (f.text && f.text === whole.toLowerCase()) || (id.length >= 6 && f.id === id));
      if (hit) {
        out.push({ key: `${li}`, text: whole, ...box(run), agrees: true, name: hit.name });
        return;
      }
    }
    line.forEach((w, wi) => {
      const t = bare(w.text);
      const hit = find(t);
      if (hit) out.push({ key: `${li}-${wi}`, text: t, ...box([w]), agrees: true, name: hit.name });
      else if (flagged.has(t)) out.push({ key: `${li}-${wi}`, text: t, ...box([w]), agrees: false, name: "Not what the books hold", note: flagged.get(t) });
      // Money is always in the books. An amount with paise that matches no record of this sale is shown as such.
      else if (/^-?[\d,]+\.\d{2}$/.test(t) && Math.abs(asNumber(t) ?? 0) >= 100) out.push({ key: `${li}-${wi}`, text: t, ...box([w]), agrees: false, odd: true, name: "Not in the records of this sale" });
    });
  });
  return out;
}

interface Page {
  width: number;
  height: number;
  lines: Word[][];
  devanagari: boolean;
  producer?: string;
}

// The paper is drawn as large as the window allows, so it can be read from the back of a room.
const WIDTH = typeof window !== "undefined" && window.innerWidth >= 1500 ? 860 : typeof window !== "undefined" && window.innerWidth >= 1280 ? 720 : 600;

export default function Lamp({ sample, docs, start, onClose, onFinding }: { sample: SampleRef; docs: EvidenceDoc[]; start: number; onClose: () => void; onFinding: (id: string) => void }) {
  const [at, setAt] = useState(start);
  const [page, setPage] = useState<Page | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [sweep, setSweep] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [chain, setChain] = useState<{ type: string; data: Record<string, any> }[] | null>(null);
  const [findings, setFindings] = useState<FindingLite[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const doc = docs[at];
  const number = sample.credit_note_no ?? sample.invoice_no ?? "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setAt((i) => Math.min(docs.length - 1, i + 1));
      if (e.key === "ArrowLeft") setAt((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, docs.length]);

  // The books' side: every record of this sale, and what the engine raised on the sample.
  useEffect(() => {
    let live = true;
    if (sample.invoice_no)
      callTool<{ events: { type: string; data: Record<string, any> }[] }>("get_sale_chain", { invoice_no: sample.invoice_no })
        .then((c) => live && setChain(c.events ?? []))
        .catch(() => live && setChain([]));
    else setChain([]);
    callTool<{ findings: FindingLite[] }>("get_findings", { sample_id: sample.sample_id, limit: 100 })
      .then((f) => live && setFindings(f.findings ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sample.sample_id, sample.invoice_no]);

  // The paper: fetched as the client uploaded it, drawn, and its words placed.
  useEffect(() => {
    let live = true;
    let url = "";
    setPage(null);
    setImage(null);
    setError("");
    (async () => {
      if (!doc?.file_hash) return setError("The client has not sent this document.");
      const res = await fetch(`/api/files/${doc.file_hash}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) return setError("The file could not be fetched.");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") {
        url = URL.createObjectURL(new Blob([bytes]));
        if (live) setImage(url);
        return;
      }
      const pdf = await pdfjs.getDocument({ data: bytes }).promise;
      const first = await pdf.getPage(1);
      const scale = WIDTH / first.getViewport({ scale: 1 }).width;
      const viewport = first.getViewport({ scale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cv = canvas.current;
      if (!live || !cv) return;
      cv.width = Math.round(viewport.width * dpr);
      cv.height = Math.round(viewport.height * dpr);
      const ctx = cv.getContext("2d")!;
      // The drawing and the reading go on side by side: the marks do not wait for the last stroke of the page.
      first.render({ canvasContext: ctx, canvas: cv, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] } as any).promise.catch(() => {});
      const content = await first.getTextContent();
      const meta = await pdf.getMetadata().catch(() => null);
      const measure = document.createElement("canvas").getContext("2d")!;
      const words: Word[] = [];
      for (const item of content.items as any[]) {
        if (!item.str?.trim()) continue;
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(tx[2], tx[3]);
        // Words are placed inside their run by measuring them in a face of the same kind as the document's.
        measure.font = `${size}px ${(content.styles as any)?.[item.fontName]?.fontFamily ?? "sans-serif"}`;
        const fit = (item.width * scale) / (measure.measureText(item.str).width || 1);
        let offset = 0;
        for (const part of item.str.split(/(\s+)/)) {
          const w = measure.measureText(part).width * fit;
          if (part.trim()) words.push({ text: part, x: tx[4] + offset, y: tx[5] - size * 0.84, w, h: size * 1.14, base: tx[5] });
          offset += w;
        }
      }
      words.sort((a, b) => a.base - b.base || a.x - b.x);
      const lines: Word[][] = [];
      for (const w of words) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line[0].base - w.base) < w.h * 0.45) line.push(w);
        else lines.push([w]);
      }
      lines.forEach((l) => l.sort((a, b) => a.x - b.x));
      const bottom = Math.max(0, ...words.map((w) => w.y + w.h));
      if (live) {
        setPage({ width: viewport.width, height: Math.min(viewport.height, bottom + 56), lines, devanagari: words.some((w) => /[ऀ-ॿ]/.test(w.text)), producer: (meta?.info as any)?.Producer });
        setSweep((k) => k + 1);
      }
    })().catch(() => live && setError("This file could not be opened as a document."));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc?.file_hash]);

  const caught = useMemo(() => (doc ? caughtOn(findings, doc.document_type) : []), [findings, doc]);
  const readings = useMemo(() => (page && chain && doc ? read(page.lines, factsOf(chain, sample, STAGE[doc.document_type] ?? ""), caught) : []), [page, chain, doc, sample, caught]);
  const good = readings.filter((r) => r.agrees).length;
  const bad = readings.length - good;
  // "differs from the system Rs 1,90,600.80" names what the books hold.
  const books = (note?: string) => note?.match(/differs from the system ((?:Rs )?[\d,.]*\d)/)?.[1];
  const language = page?.devanagari ? (/^(Hindi|Marathi)$/.test(sample.detail?.["Documents read in"] ?? "") ? sample.detail!["Documents read in"] : "Hindi or Marathi") : "";

  return (
    <div className="lamp fixed inset-0 z-[70] flex flex-col" role="dialog" aria-modal="true" aria-label={`${DOC[doc?.document_type] ?? "Document"} of ${number}, held to the light`}>
      <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-5 py-3 sm:px-8">
        <div className="min-w-0">
          <h2 className="serif text-[22px] leading-tight text-ink">{number}, held to the light</h2>
          <p className="text-[13px] text-ink-2">Green agrees with the books. Pink is what the evidence checks caught.</p>
        </div>
        <div className="flex gap-1 rounded-full bg-wash p-1" role="tablist" aria-label="The documents of this sample">
          {docs.map((d, i) => (
            <button key={d.document_type} role="tab" aria-selected={i === at} disabled={!d.file_hash} onClick={() => setAt(i)} className={cx("rounded-full px-3.5 py-1.5 text-sm transition-colors disabled:opacity-40", i === at ? "bg-brand font-semibold text-on-brand" : "text-ink-2 hover:text-ink")}>
              {DOC[d.document_type] ?? d.document_type.replace(/_/g, " ")}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4 text-sm">
          {page && (
            <button onClick={() => setSweep((k) => k + 1)} className="font-medium text-ink-2 transition-colors hover:text-ink">
              Pass the lamp again
            </button>
          )}
          <button onClick={onClose} className="inline-flex items-center gap-2 font-medium text-ink-2 transition-colors hover:text-ink">
            <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-3">Esc</kbd>
            Close
          </button>
        </div>
      </header>

      <div className="thin-scroll grid min-h-0 flex-1 gap-8 overflow-y-auto px-5 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex justify-center">
          {error ? (
            <p className="mt-16 text-ink-2">{error}</p>
          ) : image ? (
            <div style={{ maxWidth: WIDTH }}>
              <img src={image} alt="The document as the client sent it" className="w-full bg-white" />
              <p className="mt-4 text-sm text-ink-2">This is a photograph or a scan, so there is no text in it to compare here. The engine reads scans with OCR and sends what it cannot read to a person.</p>
            </div>
          ) : (
            <div className="lamp-page" style={{ width: page?.width ?? WIDTH, height: page?.height ?? 420 }}>
              <canvas ref={canvas} style={{ width: page?.width ?? WIDTH, display: "block" }} />
              {page && (
                <div key={sweep} className="absolute inset-0">
                  <div className="lamp-tint" />
                  {readings.map((r) => (
                    <div
                      key={r.key}
                      onPointerEnter={() => setHover(r.key)}
                      onPointerLeave={() => setHover(null)}
                      className={cx("lamp-mark", r.agrees ? "lamp-ok" : r.odd ? "lamp-odd" : "lamp-bad", hover === r.key && "lamp-hot")}
                      style={{ left: r.x - 3, top: r.y - 2, width: r.w + 6, height: r.h + 4, "--at": `${Math.round((r.y / page.height) * 1700 + 150)}ms` } as CSSProperties}
                    >
                      {(!r.agrees || hover === r.key) && <span className={cx("lamp-tag", r.agrees ? "lamp-tag-ok" : r.odd ? "lamp-tag-bad lamp-tag-odd" : "lamp-tag-bad")}>{r.agrees || r.odd ? r.name : books(r.note) ? `The books say ${books(r.note)}` : r.name}</span>}
                    </div>
                  ))}
                  <div className="lamp-beam" />
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="min-w-0 text-sm">
          {page && chain && (
            <>
              <div className="flex items-end gap-6">
                <div>
                  <div className="amount text-[40px] leading-none text-pass">{good}</div>
                  <div className="mt-1 text-[13px] text-ink-2">{good === 1 ? "value agrees" : "values agree"} with the books</div>
                </div>
                {bad > 0 && (
                  <div>
                    <div className="amount text-[40px] leading-none text-fail">{bad}</div>
                    <div className="mt-1 text-[13px] text-ink-2">{bad === 1 ? "does" : "do"} not</div>
                  </div>
                )}
              </div>
              {language && <p className="mt-4 text-[13px] text-ink-2">Written in {language}. Its numbers, dates and document numbers are compared like any other document's.</p>}

              {caught.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-[15px] font-semibold text-ink">What the engine caught on this document</h3>
                  <ul className="mt-2 space-y-2">
                    {caught.map(({ f, said }) => (
                      <li key={f.finding_id}>
                        <button onClick={() => onFinding(f.finding_id)} className="flex w-full items-start gap-2.5 rounded-lg border border-fail/50 px-3 py-2.5 text-left text-fail transition-colors hover:bg-fail/10">
                          <span className="mt-0.5 shrink-0">
                            <Mark tone="bad" size={15} />
                          </span>
                          <span className="leading-snug">{said.replace(/^./, (c) => c.toUpperCase()).replace(/\.+$/, "")}.</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <h3 className="mt-6 text-[15px] font-semibold text-ink">What the lamp shows</h3>
              <ul className="mt-1">
                {readings.map((r) => (
                  <li key={r.key} onPointerEnter={() => setHover(r.key)} onPointerLeave={() => setHover(null)} className={cx("flex items-baseline gap-2.5 border-b border-line-soft px-1.5 py-2 transition-colors", hover === r.key && "bg-wash")}>
                    <span className={cx("shrink-0 translate-y-0.5", r.agrees ? "text-pass" : r.odd ? "text-wait" : "text-fail")}>
                      <Mark tone={r.agrees ? "good" : r.odd ? "warn" : "bad"} size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cx("block", r.agrees ? "text-ink-2" : r.odd ? "font-medium text-wait" : "font-medium text-fail")}>{r.agrees || r.odd ? r.name : books(r.note) ? `The books say ${books(r.note)}` : r.name}</span>
                    </span>
                    <span className={cx("num max-w-[55%] truncate text-right", r.agrees ? "text-ink" : r.odd ? "font-semibold text-wait" : "font-semibold text-fail")} title={r.text}>
                      {r.text}
                    </span>
                  </li>
                ))}
                {readings.length === 0 && <li className="py-3 text-ink-2">Nothing on this document could be matched to the records of the sale.</li>}
              </ul>
              <p className="mt-4 text-[13px] leading-relaxed text-ink-3">
                {page.producer ? `The file says it was made with ${page.producer}. ` : ""}
                Taxable value in the books: ₹ {sample.taxable_value !== undefined ? money(sample.taxable_value) : "not stated"}. Values with no mark were not compared.
              </p>
            </>
          )}
          {!page && !image && !error && <p className="text-ink-2">Fetching the document as the client sent it.</p>}
        </aside>
      </div>
    </div>
  );
}
