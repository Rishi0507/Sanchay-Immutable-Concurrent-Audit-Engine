// Client for the MCP server's HTTP gateway. Every screen calls the same tools
// an agent calls over MCP, so the UI has no separate path into the system.

export type Role = "client_employee" | "auditor" | "audit_manager";

export interface Identity {
  user: string;
  role: Role;
  // Set for a client employee who belongs to a department.
  department?: string;
  department_name?: string;
}

// One tool as the server lists it for the signed-in identity.
export interface ToolInfo {
  name: string;
  group: string;
  description: string;
  write: boolean;
  input_schema: {
    properties: Record<string, { type?: string; format?: string; enum?: string[]; description?: string }>;
    required?: string[];
  };
}

export interface ToolError {
  code: string;
  message: string;
  next_step?: string;
}

export class ApiError extends Error {
  code: string;
  nextStep?: string;
  constructor(e: ToolError) {
    super(e.message);
    this.code = e.code;
    this.nextStep = e.next_step;
  }
}

const TOKEN_KEY = "revenue-audit-token";

let currentRole: Role | "" = "";

export function setRole(role: Role | "") {
  currentRole = role;
}

// The sign-in belongs to the tab, so two people can work side by side in one
// browser: an auditor in one tab and a client employee in another.
const kept = localStorage.getItem(TOKEN_KEY);
if (kept) {
  // A sign-in kept by an earlier version moves to the first tab that opens.
  if (!sessionStorage.getItem(TOKEN_KEY)) sessionStorage.setItem(TOKEN_KEY, kept);
  localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    throw new ApiError({ code: "BAD_RESPONSE", message: `The server answered ${res.status} with no JSON body.` });
  }
  if (!res.ok || body?.ok === false) {
    throw new ApiError(body?.error ?? { code: "ERROR", message: `Request failed with ${res.status}.` });
  }
  return (body?.result ?? body) as T;
}

function headers(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${getToken()}`, ...extra };
}

export async function whoami(token?: string): Promise<Identity> {
  const res = await fetch("/api/whoami", {
    headers: { Authorization: `Bearer ${token ?? getToken()}` },
  });
  return parse<Identity>(res);
}

// The tools the signed-in identity may call. The server decides, so the
// interface shows a person only what their role and department allow.
export async function listTools(): Promise<ToolInfo[]> {
  const res = await fetch("/api/tools", { headers: headers() });
  return (await parse<{ tools: ToolInfo[] }>(res)).tools;
}

// Drops empty values so optional filters do not fail validation.
function clean(args: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

// The engagement the auditor is working on. Tools that take engagement_id
// receive it automatically, so every screen follows the header's selection.
const ENGAGEMENT_KEY = "revenue-audit-engagement";
let currentEngagement = localStorage.getItem(ENGAGEMENT_KEY) ?? "";

export function getEngagement(): string {
  return currentEngagement;
}

export function setEngagement(id: string) {
  currentEngagement = id;
  if (id) localStorage.setItem(ENGAGEMENT_KEY, id);
  else localStorage.removeItem(ENGAGEMENT_KEY);
}

const engagementTools = new Set([
  "get_audit_plan", "get_engagement_status", "import_register", "reconcile_register", "get_register_rows",
  "tag_related_parties", "run_detectors", "select_sales_tod", "select_cutoff_tod", "select_credit_note_tod",
  "get_samples", "get_evidence_status", "request_evidence", "verify_evidence", "check_post_testing_changes",
  "get_findings", "get_counterparty_graph", "draft_findings_memo", "export_workpaper", "sign_off_engagement",
  "query_records", "get_sale_chain", "get_ledger_entries", "verify_ledger_integrity", "ask_assistant",
]);

export async function callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const body = clean(args);
  if (currentEngagement && currentRole !== "client_employee" && engagementTools.has(name) && !("engagement_id" in body)) {
    body.engagement_id = currentEngagement;
  }
  const res = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return parse<T>(res);
}

// Calls a tool as a named identity, without changing who is signed in. The
// story page uses it to read live figures with the demo auditor identity.
export async function callToolAs<T = any>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(clean(args)),
  });
  return parse<T>(res);
}

export async function health(): Promise<{ database: boolean; ledger: boolean; engine: boolean } | null> {
  try {
    const res = await fetch("/healthz");
    const body = await res.json();
    return body.services ?? null;
  } catch {
    return null;
  }
}

export async function uploadFile(file: File): Promise<{ file_hash: string; file_name: string; size: number }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/files", { method: "POST", headers: headers(), body: form });
  return parse(res);
}

export function fileUrl(hash: string, name?: string): string {
  const q = new URLSearchParams({ token: getToken() });
  if (name) q.set("name", name);
  return `/api/files/${hash}?${q.toString()}`;
}

export interface Notice {
  kind: string;
  at: string;
  data: Record<string, any>;
}

// Server-Sent Events from the MCP server. Returns a function that closes the
// stream.
export function subscribe(onNotice: (n: Notice) => void): () => void {
  const source = new EventSource(`/api/stream?token=${encodeURIComponent(getToken())}`);
  const handler = (e: MessageEvent) => {
    try {
      onNotice(JSON.parse(e.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  for (const kind of ["activity", "client_upload", "evidence_requested"]) {
    source.addEventListener(kind, handler as EventListener);
  }
  return () => source.close();
}

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const rupee = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? rupee.format(n) : "";
}

export function shortHash(h?: string | null, n = 10): string {
  return h ? `${h.slice(0, n)}…` : "";
}

export function when(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
