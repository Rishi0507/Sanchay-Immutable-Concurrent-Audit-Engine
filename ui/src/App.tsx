import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { Identity, Notice, Role, ToolInfo, callTool, getEngagement, getToken, listTools, setEngagement, setRole, setToken, subscribe, whoami } from "./api";
import { useTheme } from "./theme";
import { BrandMark, Button, Mark, Toasts, cx, inputClass, toast } from "./ui";
import { setFullDetail, useDetail } from "./auditor/kit";
import { CommandItem, CommandPalette } from "./Command";
import { Thread, useTilt } from "./print";
import { PalettePicker, UvSwitch } from "./inks";
import Upload from "./client/Upload";
import Requests from "./client/Requests";
import Records from "./client/Records";
import NewRecord from "./client/NewRecord";
import Access from "./client/Access";
import Overview from "./auditor/Overview";
import Register from "./auditor/Register";
import Samples from "./auditor/Samples";
import Findings from "./auditor/Findings";
import Trail from "./auditor/Trail";
import Export from "./auditor/Export";
import Ask from "./auditor/Ask";

// The heavy parts load only where they are used: the story page with its 3D
// scene, and the graph library on the Graph tab.
const Landing = lazy(() => import("./landing/Landing"));
const Lens = lazy(() => import("./lens/Lens"));
const Preview = lazy(() => import("./Preview"));
const Graph = lazy(() => import("./auditor/Graph"));

export interface ViewProps {
  identity: Identity;
  // Increases whenever the server reports activity, so open views can refresh.
  pulse: number;
  goTo: (tab: string, focus?: string) => void;
  focus?: string;
  // The engagement in view, or "" when none is open. Auditor views only.
  engagementId: string;
  onEngagement: (id: string) => void;
  // The tools the server lists for this identity, and a test for one of them.
  // Client views use them to show a person only what their department owns.
  tools: ToolInfo[];
  can: (tool: string) => boolean;
}

interface EngagementRef {
  engagement_id: string;
  period_start: string;
  period_end: string;
  opened_at?: string;
  signed_off?: boolean;
}

// A tab with `needs` is shown only to an identity that may call one of those tools.
type TabDef = {
  // A few plain words under the section name, for readers new to audit.
  hint?: string; id: string; label: string; view: (p: ViewProps) => JSX.Element; needs?: string[] };

const clientTabs: TabDef[] = [
  { id: "upload", hint: "Send the register and parties", label: "Upload", view: (p) => <Upload {...p} />, needs: ["upload_sales_register", "upload_related_parties"] },
  { id: "requests", hint: "Documents the auditor asked for", label: "Requests", view: (p) => <Requests {...p} />, needs: ["upload_evidence"] },
  { id: "records", hint: "Every record you have made", label: "Records", view: (p) => <Records {...p} /> },
  { id: "new", hint: "Record a step of a sale", label: "New record", view: (p) => <NewRecord {...p} /> },
  { id: "access", hint: "Who may do what", label: "Access", view: (p) => <Access {...p} /> },
  { id: "lens", hint: "Check any file in the browser", label: "Lens", view: () => <Lens embedded /> },
];

const auditorTabs: TabDef[] = [
  { id: "overview", hint: "The answer on one page", label: "Overview", view: (p) => <Overview {...p} /> },
  { id: "register", hint: "The client's list of sales", label: "Register", view: (p) => <Register {...p} /> },
  { id: "samples", hint: "Invoices checked against papers", label: "Samples", view: (p) => <Samples {...p} /> },
  { id: "findings", hint: "Problems found, to review", label: "Findings", view: (p) => <Findings {...p} /> },
  { id: "graph", hint: "Money going round in circles", label: "Graph", view: (p) => <Graph {...p} /> },
  { id: "trail", hint: "Every action, sealed", label: "Trail", view: (p) => <Trail {...p} /> },
  { id: "export", hint: "Reports, files and emails", label: "Export", view: (p) => <Export {...p} /> },
  { id: "lens", hint: "Audit any file in the browser", label: "Lens", view: () => <Lens embedded /> },
];

const roleLabel: Record<Role, string> = {
  client_employee: "Client",
  auditor: "Auditor",
  audit_manager: "Audit manager",
};

// One demo identity per client department, and the two on the audit side.
const departments: { label: string; does: string; token: string }[] = [
  { label: "Sales", does: "Customers and orders", token: "sales-demo-token" },
  { label: "Dispatch", does: "Goods movement", token: "dispatch-demo-token" },
  { label: "Accounts", does: "Invoices and cash", token: "accounts-demo-token" },
  { label: "Admin", does: "Vendors and filings", token: "admin-demo-token" },
];

const auditIdentities: { label: string; does: string; token: string }[] = [
  { label: "Auditor", does: "Runs the audit: samples, tests and raises findings", token: "auditor-demo-token" },
  { label: "Audit manager", does: "Reviews each finding and signs off", token: "manager-demo-token" },
];

// A client employee who belongs to no department, used to load the business.
const unrestrictedToken = "client-demo-token";

// "2025-04-01" to "2026-03-31" reads as "FY 2025-26". A period that is not one
// April-to-March year keeps its dates.
function fiscalYear(start: string, end: string) {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  if (s.getMonth() === 3 && s.getDate() === 1 && e.getMonth() === 2 && e.getDate() === 31 && e.getFullYear() === s.getFullYear() + 1) {
    return `FY ${s.getFullYear()}-${String(e.getFullYear()).slice(2)}`;
  }
  return `${start} to ${end}`;
}

// Simple view folds each page's secondary analysis; full detail shows it all.
function ViewSwitch() {
  const d = useDetail();
  return (
    <div className="px-4 pb-3">
      <div
        className="grid grid-cols-2 rounded-lg bg-black/25 p-1"
        role="group"
        aria-label="How much to show"
        title={d.full ? "Every chart and table is shown." : "Main points first. Each page folds its extra analysis into one bar you can open."}
      >
        {[
          { full: false, label: "Simple" },
          { full: true, label: "Full detail" },
        ].map((o) => (
          <button
            key={o.label}
            onClick={() => setFullDetail(o.full)}
            aria-pressed={d.full === o.full}
            className={cx("h-8 rounded-md text-[13.5px] font-semibold transition-colors", d.full === o.full ? "bg-spine-ink text-spine" : "text-spine-ink-2 hover:text-spine-ink")}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// One small line icon per section, for the side navigation.
function TabIcon({ id }: { id: string }) {
  const p = { width: 17, height: 17, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (id) {
    case "overview":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="6" height="6" rx="1.2" />
          <rect x="11" y="3" width="6" height="4" rx="1.2" />
          <rect x="11" y="9" width="6" height="8" rx="1.2" />
          <rect x="3" y="11" width="6" height="6" rx="1.2" />
        </svg>
      );
    case "register":
    case "records":
      return (
        <svg {...p}>
          <rect x="3.5" y="3" width="13" height="14" rx="1.5" />
          <path d="M3.5 7.5h13M3.5 12h13M8 7.5V17" />
        </svg>
      );
    case "samples":
      return (
        <svg {...p}>
          <circle cx="9" cy="9" r="5" />
          <path d="M13 13l4 4M7 9h4M9 7v4" />
        </svg>
      );
    case "findings":
      return (
        <svg {...p}>
          <path d="M10 3l7.5 13h-15z" />
          <path d="M10 8.5v3.5M10 14.2v.1" />
        </svg>
      );
    case "graph":
      return (
        <svg {...p}>
          <circle cx="5" cy="10" r="2" />
          <circle cx="15" cy="5" r="2" />
          <circle cx="15" cy="15" r="2" />
          <path d="M6.8 9.1l6.4-3.2M6.8 10.9l6.4 3.2" />
        </svg>
      );
    case "trail":
      return (
        <svg {...p}>
          <path d="M4 5h12M4 10h12M4 15h8" />
          <circle cx="15.5" cy="15" r="1.5" />
        </svg>
      );
    case "export":
      return (
        <svg {...p}>
          <path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M4 15.5h12" />
        </svg>
      );
    case "upload":
      return (
        <svg {...p}>
          <path d="M10 13V4M6.5 7.5L10 4l3.5 3.5M4 15.5h12" />
        </svg>
      );
    case "requests":
      return (
        <svg {...p}>
          <path d="M4 5.5h12v8H9l-3.5 3v-3H4z" />
        </svg>
      );
    case "access":
      return (
        <svg {...p}>
          <circle cx="10" cy="7" r="3" />
          <path d="M4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5" />
        </svg>
      );
    case "lens":
      return (
        <svg {...p}>
          <circle cx="8.5" cy="8.5" r="5" />
          <path d="M12.2 12.2L17 17M6 8.6l1.7 1.7 3-3.4" />
        </svg>
      );
    case "theme":
      return (
        <svg {...p}>
          <path d="M16 11.5A6.5 6.5 0 018.5 4a6.5 6.5 0 107.5 7.5z" />
        </svg>
      );
    case "story":
      return (
        <svg {...p}>
          <path d="M4 4.5h5a2 2 0 012 2V16a1.5 1.5 0 00-1.5-1.5H4zM16 4.5h-5a2 2 0 00-2 2V16a1.5 1.5 0 011.5-1.5H16z" />
        </svg>
      );
    case "signout":
      return (
        <svg {...p}>
          <path d="M8 4H4.5v12H8M12 6.5L15.5 10 12 13.5M15.5 10H8" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <path d="M10 4v12M4 10h12" />
        </svg>
      );
  }
}

// The Sanchay emblem beside the product name, on the green spine.
function Wordmark({ onClick }: { onClick?: () => void }) {
  const mark = (
    <>
      <BrandMark size={34} />
      <span className="text-left leading-tight">
        <span className="display block text-[21px] text-spine-ink">Sanchay</span>
        <span className="block text-[12px] font-medium text-spine-ink-2">Statutory revenue audit</span>
      </span>
    </>
  );
  const className = "flex shrink-0 items-center gap-3";
  return onClick ? (
    <button onClick={onClick} className={cx(className, "rounded-lg transition-opacity hover:opacity-85")} title="The front page">
      {mark}
    </button>
  ) : (
    <div className={className}>{mark}</div>
  );
}

function SignIn({ onSignedIn, onBack }: { onSignedIn: (id: Identity) => void; onBack: () => void }) {
  const [token, setValue] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const signIn = async (t: string) => {
    setBusy(t);
    setError("");
    try {
      const id = await whoami(t);
      setToken(t);
      onSignedIn(id);
    } catch {
      setError("That token is not recognised. Check it, or pick one of the identities above.");
    } finally {
      setBusy("");
    }
  };

  const spinner = <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand" />;

  return (
    <div className="view grid min-h-full lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* The ledger's cover: the product, and what it does, in one sentence. */}
      <aside className="relative flex flex-col justify-between overflow-hidden bg-spine px-8 py-8 text-spine-ink md:px-12 lg:min-h-screen">
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "repeating-linear-gradient(to bottom, transparent 0 39px, #eaf4ee 39px 40px)" }} aria-hidden />
        <div className="relative flex items-center justify-between text-[14px]">
          <button onClick={onBack} className="inline-flex items-center gap-1.5 font-semibold text-spine-ink-2 transition-colors hover:text-spine-ink">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 3.5L5.5 8 10 12.5" />
            </svg>
            How it works
          </button>
          <PalettePicker compact onDark />
        </div>
        <div className="relative my-12 lg:my-0">
          <img src="/logo.png" alt="Sanchay" width={150} height={104} className="logo-ground rounded-2xl" />
          <h1 className="display mt-10 max-w-[13ch] text-[52px] leading-[0.98] md:text-[64px]">Every sale, checked against its record.</h1>
          <p className="mt-6 max-w-md text-[17px] leading-relaxed text-spine-ink-2">
            Sanchay audits a company's revenue from the ledger behind it: each order, dispatch, invoice and payment, sealed so nobody can change it later.
          </p>
        </div>
        <ul className="relative grid gap-3 text-[15px] text-spine-ink-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          {["Every register row reconciled", "Samples nobody can pick", "Findings a manager signs off"].map((t) => (
            <li key={t} className="flex items-center gap-2.5">
              <span className="text-highlight">
                <Mark tone="good" size={18} draw />
              </span>
              {t}
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex items-center justify-center bg-canvas px-6 py-12 md:px-12">
        <div className="w-full max-w-[480px]">
          <h2 className="display text-[38px] leading-none">Sign in</h2>
          <p className="mt-2 text-[16px] text-ink-2">Choose who you are. Each identity sees only what its role allows.</p>

          <div className="mt-8 mb-3 text-[14px] font-bold text-ink">Audit firm</div>
          <div className="grid gap-3">
            {auditIdentities.map((d, i) => (
              <button
                key={d.token}
                onClick={() => signIn(d.token)}
                disabled={!!busy}
                className="group flex items-center gap-4 rounded-2xl border border-line bg-paper px-5 py-4 text-left shadow-[0_1px_0_var(--color-line-soft)] transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand hover:shadow-[0_12px_28px_rgba(12,58,43,0.14)] disabled:opacity-60"
              >
                <span className={cx("flex h-12 w-12 shrink-0 items-center justify-center rounded-xl", i === 0 ? "bg-brand text-on-brand" : "bg-spine text-highlight")}>
                  {i === 0 ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="10.5" cy="10.5" r="6" />
                      <path d="M15 15l5 5M8 10.6l1.8 1.8 3.2-3.6" />
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 20c4-1 6.5-3.5 8-7.5M12.5 12.5L18 5l1 1-6 7.5" />
                      <path d="M4 20h16" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[18px] font-bold text-ink">{d.label}</span>
                  <span className="block text-[14px] text-ink-2">{d.does}</span>
                </span>
                {busy === d.token ? (
                  spinner
                ) : (
                  <svg className="text-ink-3 transition-all duration-150 group-hover:translate-x-1 group-hover:text-brand" width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M6 3.5L10.5 8 6 12.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>

          <div className="mt-8 mb-3 flex items-baseline justify-between">
            <span className="text-[14px] font-bold text-ink">Client company, by department</span>
            <button onClick={() => signIn(unrestrictedToken)} disabled={!!busy} className="text-[13px] font-semibold text-brand transition-colors hover:underline disabled:opacity-60">
              All departments
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {departments.map((d) => (
              <button key={d.token} onClick={() => signIn(d.token)} disabled={!!busy} className="rounded-xl border border-line bg-paper px-4 py-3 text-left transition-[border-color,background-color] duration-150 hover:border-brand hover:bg-brand-wash/40 disabled:opacity-60">
                <span className="flex items-center justify-between text-[16px] font-bold text-ink">
                  {d.label}
                  {busy === d.token && spinner}
                </span>
                <span className="block text-[13.5px] text-ink-2">{d.does}</span>
              </button>
            ))}
          </div>

          <form
            className="mt-8 border-t border-line pt-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (token) signIn(token);
            }}
          >
            <label htmlFor="token" className="mb-1.5 block text-[13px] font-semibold text-ink-2">
              Or sign in with an identity token
            </label>
            <div className="flex gap-2">
              <input id="token" className={inputClass} type="password" autoComplete="off" value={token} onChange={(e) => setValue(e.target.value)} />
              <Button kind="ghost" busy={!!busy && busy === token} disabled={!token}>
                Sign in
              </Button>
            </div>
            {error && <p className="mt-2 text-[14px] font-medium text-fail">{error}</p>}
          </form>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // Colour-shift ink and holograms follow the pointer everywhere.
  useTilt();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  // The landing tells the story and is the front door. The Lens audits a file
  // in the browser with no account. The workspace needs a sign-in.
  const [screen, setScreen] = useState<"landing" | "lens" | "signin" | "app">("landing");
  // A tab a landing chapter asked for, opened once the reader has signed in.
  const [pendingTab, setPendingTab] = useState("");
  const [tab, setTab] = useState("");
  const [focus, setFocus] = useState<string | undefined>();
  const [pulse, setPulse] = useState(0);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [engagements, setEngagements] = useState<EngagementRef[]>([]);
  const [engagementId, setEngagementId] = useState("");
  const [engagementsLoaded, setEngagementsLoaded] = useState(false);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [palette, setPalette] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [theme, setThemeValue] = useTheme();

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    whoami()
      .then((id) => {
        setIdentity(id);
        // A link to #story opens the landing even for someone signed in.
        if (window.location.hash !== "#story") setScreen("app");
      })
      .catch(() => setToken(""))
      .finally(() => setChecking(false));
  }, []);

  const auditing = !!identity && identity.role !== "client_employee";
  const can = useCallback((tool: string) => !!tools?.some((t) => t.name === tool), [tools]);
  const tabs = useMemo(() => (auditing ? auditorTabs : tools ? clientTabs.filter((t) => !t.needs || t.needs.some(can)) : []), [auditing, tools, can]);

  // The server lists the tools of this identity. The tabs follow from that list.
  useEffect(() => {
    setRole(identity?.role ?? "");
    setTools(null);
    setTab(pendingTab);
    setPendingTab("");
    if (!identity) return;
    listTools()
      .then(setTools)
      .catch(() => setTools([]));
  }, [identity]);

  const chooseEngagement = useCallback((id: string) => {
    setEngagement(id);
    setEngagementId(id);
  }, []);

  // Keeps the list of engagements current and settles on one: the stored
  // choice if it still exists, otherwise the most recent open engagement.
  const loadEngagements = useCallback(async () => {
    try {
      const { engagements: list } = await callTool<{ engagements: EngagementRef[] }>("list_engagements");
      const sorted = [...list].sort((a, b) => (b.opened_at ?? "").localeCompare(a.opened_at ?? ""));
      setEngagements(sorted);
      const stored = getEngagement();
      if (stored && sorted.some((e) => e.engagement_id === stored)) {
        setEngagementId(stored);
      } else {
        chooseEngagement((sorted.find((e) => !e.signed_off) ?? sorted[0])?.engagement_id ?? "");
      }
    } catch {
      setEngagements([]);
    } finally {
      setEngagementsLoaded(true);
    }
  }, [chooseEngagement]);

  useEffect(() => {
    if (auditing) loadEngagements();
  }, [auditing, loadEngagements]);

  // Counts beside the sections, so the navigation itself says where the work is.
  useEffect(() => {
    if (!auditing || !engagementId) {
      setCounts({});
      return;
    }
    let live = true;
    callTool<any>("get_engagement_status")
      .then((s) => {
        if (!live) return;
        const sev = s.counts?.findings_by_severity ?? {};
        setCounts({ findings: Number(sev.High ?? 0) + Number(sev.Medium ?? 0) + Number(sev.Low ?? 0), high: Number(sev.High ?? 0), samples: Number(s.counts?.evidence_pending ?? 0) });
      })
      .catch(() => live && setCounts({}));
    return () => {
      live = false;
    };
  }, [auditing, engagementId, pulse]);

  // Live notices: a client upload badges the auditor's Overview, an evidence
  // request badges the client's Requests tab.
  useEffect(() => {
    if (!identity) return;
    return subscribe((n: Notice) => {
      if (n.kind === "client_upload") {
        setBadges((b) => ({ ...b, overview: (b.overview ?? 0) + 1 }));
        toast("The client uploaded a file.");
        setPulse((p) => p + 1);
      } else if (n.kind === "evidence_requested") {
        setBadges((b) => ({ ...b, requests: (b.requests ?? 0) + 1 }));
        toast("The auditor requested documents.");
        setPulse((p) => p + 1);
      } else if (n.kind === "activity" && n.data.user !== identity.user && n.data.changes) {
        // Only a call that changed something reloads the screen. Reloading on
        // reads would make two auditors on one engagement reload each other.
        setPulse((p) => p + 1);
      }
    });
  }, [identity]);

  const goTo = useCallback((next: string, nextFocus?: string) => {
    setTab(next);
    setFocus(nextFocus);
    setBadges((b) => ({ ...b, [next]: 0 }));
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  // Ctrl+K or / opens the palette, wherever the reader is.
  useEffect(() => {
    if (screen !== "app" || !identity) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, identity]);

  const closePalette = useCallback(() => setPalette(false), []);

  const signOut = useCallback(() => {
    setToken("");
    setIdentity(null);
    setEngagements([]);
    setEngagementsLoaded(false);
    setScreen("signin");
  }, []);

  const commands = useMemo<CommandItem[]>(() => {
    const go: CommandItem[] = tabs.map((t) => ({ id: `go:${t.id}`, group: "Go to", label: t.label, hint: t.hint, icon: <TabIcon id={t.id} />, run: () => goTo(t.id) }));
    const filters: CommandItem[] = auditing
      ? [
          { id: "do:high", group: "Do", label: "Show high-severity findings", hint: "Findings, filtered to High", icon: <TabIcon id="findings" />, run: () => goTo("findings", "f:severity=High") },
          { id: "do:review", group: "Do", label: "Show findings awaiting review", hint: "Findings the manager has not decided", icon: <TabIcon id="findings" />, run: () => goTo("findings", "f:status=proposed") },
          { id: "do:attention", group: "Do", label: "Show register rows that do not agree", hint: "Register, filtered to differences", icon: <TabIcon id="register" />, run: () => goTo("register", "status:attention") },
        ]
      : [];
    const general: CommandItem[] = [
      { id: "do:theme", group: "Do", label: theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme", icon: <TabIcon id="theme" />, run: () => setThemeValue(theme === "dark" ? "light" : "dark") },
      { id: "do:story", group: "Do", label: "Read how Sanchay works", hint: "The front page and its six chapters", icon: <TabIcon id="story" />, run: () => setScreen("landing") },
      { id: "do:signout", group: "Do", label: "Sign out", icon: <TabIcon id="signout" />, run: signOut },
    ];
    return [...go, ...filters, ...general];
  }, [tabs, auditing, goTo, theme, setThemeValue, signOut]);

  if (checking) return null;

  if (import.meta.env.DEV && window.location.hash === "#preview")
    return (
      <Suspense fallback={null}>
        <Preview />
      </Suspense>
    );

  const openWorkspace = (next?: string) => {
    if (identity) {
      if (next) goTo(next);
      setScreen("app");
    } else {
      setPendingTab(next ?? "");
      setScreen("signin");
    }
  };

  if (screen === "landing")
    return (
      <Suspense fallback={<div className="h-screen bg-spine" />}>
        <Landing onInspect={() => setScreen("lens")} onWorkspace={openWorkspace} />
        <Toasts />
      </Suspense>
    );

  if (screen === "lens")
    return (
      <Suspense fallback={null}>
        <Lens onSignIn={() => openWorkspace()} onStory={() => setScreen("landing")} />
        <Toasts />
      </Suspense>
    );

  if (!identity)
    return (
      <>
        <SignIn
          onSignedIn={(id) => {
            setIdentity(id);
            setScreen("app");
          }}
          onBack={() => setScreen("landing")}
        />
        <Toasts />
      </>
    );

  const active: TabDef | undefined = tabs.find((t) => t.id === tab) ?? tabs[0];
  const onEngagement = (id: string) => {
    chooseEngagement(id);
    loadEngagements();
  };
  const current = engagements.find((x) => x.engagement_id === engagementId);

  // What the badge beside a section says: news first, then work waiting there.
  const badgeFor = (id: string): { n: number; tone: "news" | "work" | "alert" } | null => {
    if (badges[id]) return { n: badges[id], tone: "news" };
    if (id === "findings" && counts.findings) return { n: counts.findings, tone: counts.high ? "alert" : "work" };
    if (id === "samples" && counts.samples) return { n: counts.samples, tone: "work" };
    return null;
  };
  const badgeClass = { news: "bg-highlight text-spine", work: "bg-white/15 text-spine-ink", alert: "bg-[#e5532f] text-white" };

  const engagementSelect =
    auditing && engagements.length > 0 ? (
      <select
        value={engagementId}
        onChange={(e) => chooseEngagement(e.target.value)}
        className="h-10 w-full truncate rounded-lg border border-white/15 bg-spine-2 px-2.5 text-[14px] font-semibold text-spine-ink outline-none transition-colors hover:border-white/30 focus:border-highlight"
        aria-label="Engagement"
        title={current ? `Audit period ${current.period_start} to ${current.period_end}` : undefined}
      >
        {engagements.map((e) => (
          <option key={e.engagement_id} value={e.engagement_id} title={`${e.period_start} to ${e.period_end}`}>
            {fiscalYear(e.period_start, e.period_end)}
            {engagements.length > 1 && e.opened_at ? ` (${new Date(e.opened_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}
            {e.signed_off ? " (signed off)" : ""}
          </option>
        ))}
        <option value="">New engagement</option>
      </select>
    ) : null;

  const searchButton = (wide: boolean) => (
    <button
      onClick={() => setPalette(true)}
      className={cx(
        "group inline-flex items-center gap-2.5 rounded-xl border border-line bg-paper text-left text-ink-2 shadow-[0_1px_0_var(--color-line-soft)] transition-colors hover:border-brand/60 hover:text-ink",
        wide ? "h-11 w-full max-w-[420px] px-4" : "h-9 w-9 justify-center",
      )}
      aria-label="Search and jump, Ctrl K"
    >
      <svg className="shrink-0 text-brand" width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      {wide && (
        <>
          <span className="flex-1 truncate text-[15px]">{auditing ? "Find a page, an action or a finding" : "Find a page or an action"}</span>
          <kbd>Ctrl</kbd>
          <kbd>K</kbd>
        </>
      )}
    </button>
  );

  return (
    <div className="flex min-h-full bg-canvas">
      {/* The ledger's cloth spine: sections down the left on wide screens. */}
      <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col bg-spine text-spine-ink lg:flex">
        {/* The security thread runs down the spine. */}
        <Thread vertical className="absolute top-0 right-0 h-full opacity-60" />
        <div className="flex h-[76px] items-center px-5">
          <Wordmark onClick={() => setScreen("landing")} />
        </div>
        {engagementSelect && (
          <div className="px-4 pb-4">
            <div className="mb-1.5 px-0.5 text-[12px] font-semibold text-spine-ink-2 [@media(max-height:760px)]:hidden">Engagement</div>
            {engagementSelect}
          </div>
        )}
        <nav className="thin-scroll flex-1 overflow-y-auto px-3" aria-label="Sections">
          <ul className="space-y-1">
            {tabs.map((t) => {
              const on = t.id === active?.id;
              const badge = !on ? badgeFor(t.id) : null;
              return (
                <li key={t.id}>
                  <button
                    onClick={() => goTo(t.id)}
                    aria-current={on ? "page" : undefined}
                    className={cx(
                      "relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 [@media(max-height:760px)]:py-1.5",
                      on ? "bg-white/[0.11] text-spine-ink" : "text-spine-ink-2 hover:bg-white/[0.06] hover:text-spine-ink",
                    )}
                  >
                    <span className={cx("absolute inset-y-2.5 -left-3 w-1 rounded-r-full bg-highlight transition-opacity duration-150", on ? "opacity-100" : "opacity-0")} />
                    <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors", on ? "bg-highlight text-spine" : "bg-white/[0.07]")}>
                      <TabIcon id={t.id} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cx("block truncate text-[15.5px]", on ? "font-bold" : "font-semibold")}>{t.label}</span>
                      {t.hint && <span className="block truncate text-[12.5px] leading-tight text-spine-ink-2 [@media(max-height:760px)]:hidden">{t.hint}</span>}
                    </span>
                    {badge && <span className={cx("num inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full px-1.5 text-[12px] font-bold", badgeClass[badge.tone])}>{badge.n}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {auditing && <ViewSwitch />}
        <div className="border-t border-white/10 px-5 py-4 text-[14px]">
          <div className="flex min-w-0 items-center gap-3" title={identity.user}>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-highlight text-[14px] font-bold text-spine">{(identity.department_name ?? roleLabel[identity.role]).slice(0, 1)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold">{identity.department_name ?? roleLabel[identity.role]}</span>
              <span className="block truncate text-[12.5px] text-spine-ink-2">{auditing ? "Can read, cannot change the books" : identity.user}</span>
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <PalettePicker compact onDark />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-spine-ink-2">
            <UvSwitch onDark />
            <button onClick={signOut} className="font-semibold transition-colors hover:text-spine-ink">
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Narrow screens keep a top bar with the sections in a scrolling row. */}
        <header className="sticky top-0 z-30 bg-spine text-spine-ink lg:hidden">
          <div className="flex h-[60px] items-center gap-3 px-4 text-[14px]">
            <Wordmark onClick={() => setScreen("landing")} />
            <div className="ml-auto flex min-w-0 items-center gap-3 whitespace-nowrap">
              {engagementSelect && <div className="w-32">{engagementSelect}</div>}
              <button onClick={() => setPalette(true)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10" aria-label="Search and jump">
                <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="M10.5 10.5L14 14" />
                </svg>
              </button>
              <button onClick={signOut} className="font-semibold text-spine-ink-2 hover:text-spine-ink">
                Sign out
              </button>
            </div>
          </div>
          <nav className="thin-scroll flex h-12 items-stretch gap-1 overflow-x-auto border-t border-white/10 px-2" aria-label="Sections">
            {tabs.map((t) => {
              const on = t.id === active?.id;
              const badge = !on ? badgeFor(t.id) : null;
              return (
                <button
                  key={t.id}
                  onClick={() => goTo(t.id)}
                  aria-current={on ? "page" : undefined}
                  className={cx("relative flex shrink-0 items-center px-3 text-[15px] whitespace-nowrap transition-colors", on ? "font-bold text-spine-ink" : "font-semibold text-spine-ink-2")}
                >
                  {t.label}
                  {badge && <span className={cx("num ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold", badgeClass[badge.tone])}>{badge.n}</span>}
                  <span className={cx("absolute inset-x-3 bottom-0 h-[3px] rounded-t bg-highlight transition-opacity", on ? "opacity-100" : "opacity-0")} />
                </button>
              );
            })}
          </nav>
        </header>

        {/* The desk's top edge: the engagement in view and the search box. */}
        <div className="sticky top-0 z-20 hidden items-center gap-4 border-b border-line bg-canvas/90 px-8 py-3 backdrop-blur-md lg:flex">
          <div className="min-w-0 text-[14px] text-ink-2">
            {auditing && current ? (
              <>
                <span className="font-bold text-ink">{fiscalYear(current.period_start, current.period_end)} revenue audit</span>
                {current.signed_off ? <span className="ml-2 font-semibold text-pass">Signed off</span> : null}
              </>
            ) : (
              <span className="font-bold text-ink">{identity.department_name ? `${identity.department_name} department` : roleLabel[identity.role]}</span>
            )}
          </div>
          <div className="ml-auto flex w-full max-w-[420px] justify-end">{searchButton(true)}</div>
        </div>

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pt-7 pb-20 sm:px-8">
          <div key={`${active?.id}:${engagementId}`} className="view">
            <Suspense fallback={null}>
              {!active || !tools || (auditing && !engagementsLoaded) ? null : active.view({ identity, pulse, goTo, focus, engagementId, onEngagement, tools, can })}
            </Suspense>
          </div>
        </main>
      </div>
      {palette && <CommandPalette onClose={closePalette} items={commands} findings={auditing && !!engagementId} onFinding={(id) => goTo("findings", id)} />}
      {auditing && engagementId && can("ask_assistant") && <Ask engagementId={engagementId} goTo={goTo} />}
      <Toasts />
    </div>
  );
}
