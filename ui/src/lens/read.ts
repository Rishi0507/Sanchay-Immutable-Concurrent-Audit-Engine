// Reads a dropped file into a table: Excel through SheetJS (loaded only when
// needed), CSV and JSON by hand. Nothing leaves the browser.

export type Cell = string | number | Date | null;

export interface Table {
  name: string;
  columns: string[];
  rows: Cell[][];
  // The sheet a workbook was read from, when it had several.
  sheet?: string;
}

export async function readFile(file: File): Promise<Table> {
  const name = file.name;
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) return fromText(name, await file.text());
  if (lower.endsWith(".json")) return fromJson(name, await file.text());
  return fromWorkbook(name, await file.arrayBuffer());
}

export async function readUrl(url: string, name: string): Promise<Table> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${name}.`);
  const blob = await res.blob();
  return readFile(new File([blob], name));
}

async function fromWorkbook(name: string, data: ArrayBuffer): Promise<Table> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(data, { type: "array", cellDates: true });
  // The sheet with the most filled cells is the one that holds the data.
  let best: { sheet: string; grid: Cell[][]; filled: number } | null = null;
  for (const sheet of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[sheet], { header: 1, raw: true, defval: null, blankrows: false });
    const filled = grid.reduce((t, r) => t + r.filter((c) => c !== null && c !== "").length, 0);
    if (!best || filled > best.filled) best = { sheet, grid, filled };
  }
  if (!best) throw new Error("The workbook has no sheets.");
  return { ...fromGrid(name, best.grid), sheet: wb.SheetNames.length > 1 ? best.sheet : undefined };
}

function fromJson(name: string, text: string): Table {
  let data: unknown = JSON.parse(text);
  if (data && !Array.isArray(data) && typeof data === "object") {
    // { "rows": [...] } or the first array found at the top level.
    data = Object.values(data as Record<string, unknown>).find(Array.isArray) ?? [];
  }
  const list = (data as unknown[]).filter((r) => r && typeof r === "object") as Record<string, unknown>[];
  const columns: string[] = [];
  for (const r of list) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  const rows = list.map((r) => columns.map((c) => toCell(r[c])));
  return { name, columns, rows };
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || v instanceof Date) return v;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function fromText(name: string, text: string): Table {
  const nl = text.indexOf("\n");
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  const delimiter = ["\t", ";", ","].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  return fromGrid(name, parseDelimited(text, delimiter));
}

// RFC 4180 style: quoted fields may hold the delimiter, quotes and line breaks.
export function parseDelimited(text: string, delimiter = ","): Cell[][] {
  const out: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field === "" ? null : field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field === "" ? null : field);
      if (row.some((c) => c !== null)) out.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field === "" ? null : field);
  if (row.some((c) => c !== null)) out.push(row);
  return out;
}

// The header is the first row that is mostly text; rows above it are a title.
function fromGrid(name: string, grid: Cell[][]): Table {
  const width = Math.max(0, ...grid.slice(0, 50).map((r) => r.length));
  let header = 0;
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const r = grid[i];
    const text = r.filter((c) => typeof c === "string" && c.trim() && Number.isNaN(Number(c))).length;
    if (text >= Math.max(2, width * 0.5)) {
      header = i;
      break;
    }
  }
  const names = (grid[header] ?? []).map((c, i) => (c === null || c === "" ? `Column ${i + 1}` : String(c).trim()));
  while (names.length < width) names.push(`Column ${names.length + 1}`);
  const rows = grid.slice(header + 1).map((r) => names.map((_, i) => (r[i] === undefined ? null : r[i])));
  return { name, columns: names, rows };
}
