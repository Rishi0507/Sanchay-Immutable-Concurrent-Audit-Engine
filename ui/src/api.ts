// Client for the MCP server's HTTP gateway. Every screen calls the same tools
// an agent calls over MCP, so the UI has no separate path into the system.

export type Role = "client_employee" | "auditor" | "audit_manager";

export interface Identity {
  user: string;
  role: Role;
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

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
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

// Drops empty values so optional filters do not fail validation.
function clean(args: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export async function callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(clean(args)),
  });
  return parse<T>(res);
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
