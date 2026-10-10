import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { Identity, Notice, Role, ToolInfo, callTool, getEngagement, getToken, listTools, setEngagement, setRole, setToken, subscribe, whoami } from "./api";
import { useTheme } from "./theme";
import { Button, Toasts, cx, inputClass, toast } from "./ui";
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

// The heavy parts load only where they are used: the story page with its 3D
// scene, and the graph library on the Graph tab.
const Story = lazy(() => import("./story/Story"));
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
type TabDef = { id: string; label: string; view: (p: ViewProps) => JSX.Element; needs?: string[] };

const clientTabs: TabDef[] = [
  { id: "upload", label: "Upload", view: (p) => <Upload {...p} />, needs: ["upload_sales_register", "upload_related_parties"] },
  { id: "requests", label: "Requests", view: (p) => <Requests {...p} />, needs: ["upload_evidence"] },
  { id: "records", label: "Records", view: (p) => <Records {...p} /> },
  { id: "new", label: "New record", view: (p) => <NewRecord {...p} /> },
  { id: "access", label: "Access", view: (p) => <Access {...p} /> },
];

const auditorTabs: TabDef[] = [
  { id: "overview", label: "Overview", view: (p) => <Overview {...p} /> },
  { id: "register", label: "Register", view: (p) => <Register {...p} /> },
  { id: "samples", label: "Samples", view: (p) => <Samples {...p} /> },
  { id: "findings", label: "Findings", view: (p) => <Findings {...p} /> },
  { id: "graph", label: "Graph", view: (p) => <Graph {...p} /> },
  { id: "trail", label: "Trail", view: (p) => <Trail {...p} /> },
  { id: "export", label: "Export", view: (p) => <Export {...p} /> },
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
  { label: "Auditor", does: "Sample, test and raise findings", token: "auditor-demo-token" },
  { label: "Audit manager", does: "Confirm findings and sign off", token: "manager-demo-token" },
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
    default:
      return (
        <svg {...p}>
          <path d="M10 4v12M4 10h12" />
        </svg>
      );
  }
}

// The auditor's tick mark, used as the product mark.
function Wordmark({ large, onClick }: { large?: boolean; onClick?: () => void }) {
  const mark = (
    <>
      <svg width={large ? 22 : 18} height={large ? 22 : 18} viewBox="0 0 20 20" fill="none" stroke="var(--color-brand)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3.5 10.5l4.2 4.2L16.5 5.2" />
      </svg>
      Revenue Audit
    </>
  );
  const className = cx("flex shrink-0 items-center font-semibold whitespace-nowrap tracking-[-0.01em] text-ink", large ? "gap-2.5 text-xl" : "gap-2 text-[15px]");
  return onClick ? (
    <button onClick={onClick} className={className} title="How it works">
      {mark}
    </button>
  ) : (
    <div className={className}>{mark}</div>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="font-medium text-ink-2 transition-colors hover:text-ink" aria-label={`Switch to the ${theme === "dark" ? "light" : "dark"} theme`}>
      {theme === "dark" ? "Light" : "Dark"}
    </button>
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
      setError("That token is not recognised.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="view flex min-h-full flex-col">
      <header className="flex h-16 items-center justify-between px-6 text-[13px] md:px-12">
        <button onClick={onBack} className="font-medium text-ink-2 transition-colors hover:text-ink">
          Back to how it works
        </button>
        <ThemeSwitch />
      </header>
      <div className="flex flex-1 items-center justify-center px-6 pb-24">
        <div className="w-full max-w-[400px]">
          <Wordmark large />
          <h1 className="serif mt-10 text-[34px] leading-[1.08] font-[430] tracking-[-0.02em]">Sign in</h1>
          <p className="mt-2 text-sm text-ink-2">Each identity sees only what its role and department allow.</p>

          <div className="mt-8 mb-2 flex items-baseline justify-between text-xs font-medium text-ink-2">
            <span>Client company</span>
            <button onClick={() => signIn(unrestrictedToken)} disabled={!!busy} className="text-ink-3 transition-colors hover:text-brand disabled:opacity-60">
              All departments
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {departments.map((d) => (
              <button key={d.token} onClick={() => signIn(d.token)} disabled={!!busy} className="rounded-md border border-line px-3 py-2.5 text-left transition-colors hover:border-brand hover:bg-wash disabled:opacity-60">
                <span className="flex items-center justify-between text-[15px] font-medium text-ink">
                  {d.label}
                  {busy === d.token && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-brand" />}
                </span>
                <span className="block text-[13px] text-ink-2">{d.does}</span>
              </button>
            ))}
          </div>

          <div className="mt-7 mb-2 text-xs font-medium text-ink-2">Audit firm</div>
          <div className="divide-y divide-line-soft border-y border-line">
            {auditIdentities.map((d) => (
              <button key={d.token} onClick={() => signIn(d.token)} disabled={!!busy} className="group flex w-full items-center justify-between gap-4 py-3.5 text-left transition-colors hover:bg-wash disabled:opacity-60 sm:px-2">
                <span>
                  <span className="block text-[15px] font-medium text-ink">{d.label}</span>
                  <span className="block text-[13px] text-ink-2">{d.does}</span>
                </span>
                {busy === d.token ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand" />
                ) : (
                  <svg className="text-ink-3 transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-brand" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M6 3.5L10.5 8 6 12.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>

          <form
            className="mt-8"
            onSubmit={(e) => {
              e.preventDefault();
              if (token) signIn(token);
            }}
          >
            <label htmlFor="token" className="mb-1.5 block text-xs font-medium text-ink-2">
              Or sign in with an identity token
            </label>
            <div className="flex gap-2">
              <input id="token" className={inputClass} type="password" autoComplete="off" value={token} onChange={(e) => setValue(e.target.value)} />
              <Button kind="ghost" busy={!!busy && busy === token} disabled={!token}>
                Sign in
              </Button>
            </div>
            {error && <p className="mt-2 text-sm text-fail">{error}</p>}
          </form>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  // Before sign-in the story page is the front door. Signed in, it is one
  // click on the wordmark away.
  const [screen, setScreen] = useState<"story" | "signin" | "app">("story");
  const [tab, setTab] = useState("");
  const [focus, setFocus] = useState<string | undefined>();
  const [pulse, setPulse] = useState(0);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [engagements, setEngagements] = useState<EngagementRef[]>([]);
  const [engagementId, setEngagementId] = useState("");
  const [engagementsLoaded, setEngagementsLoaded] = useState(false);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    whoami()
      .then((id) => {
        setIdentity(id);
        // A link to #story opens the story even for someone signed in.
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
    setTab("");
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
      } else if (n.kind === "activity" && n.data.user !== identity.user && n.data.status === "ok") {
        setPulse((p) => p + 1);
      }
    });
  }, [identity]);

  const goTo = useCallback((next: string, nextFocus?: string) => {
    setTab(next);
    setFocus(nextFocus);
    setBadges((b) => ({ ...b, [next]: 0 }));
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  if (checking) return null;

  if (screen === "story")
    return (
      <Suspense fallback={null}>
        <Story onOpen={() => setScreen(identity ? "app" : "signin")} />
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
          onBack={() => setScreen("story")}
        />
        <Toasts />
      </>
    );

  const active: TabDef | undefined = tabs.find((t) => t.id === tab) ?? tabs[0];
  const onEngagement = (id: string) => {
    chooseEngagement(id);
    loadEngagements();
  };

  const engagementSelect =
    auditing && engagements.length > 0 ? (
      <select
        value={engagementId}
        onChange={(e) => chooseEngagement(e.target.value)}
        className="h-9 w-full truncate rounded-md border border-line bg-paper px-2 text-[13px] text-ink outline-none transition-colors hover:border-ink-3 focus:border-brand"
        aria-label="Engagement"
        title={(() => {
          const e = engagements.find((x) => x.engagement_id === engagementId);
          return e ? `Audit period ${e.period_start} to ${e.period_end}` : undefined;
        })()}
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

  const readOnly = auditing ? (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs font-medium text-ink-2"
      title="The audit side can read the client's records but cannot change them. Every attempt is recorded in the trail."
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
      </svg>
      Read-only
    </span>
  ) : null;

  const signOut = () => {
    setToken("");
    setIdentity(null);
    setEngagements([]);
    setEngagementsLoaded(false);
    setScreen("signin");
  };

  return (
    <div className="flex min-h-full bg-canvas">
      {/* Sections run down the left on wide screens. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-paper lg:flex">
        <div className="flex h-14 items-center px-5">
          <Wordmark onClick={() => setScreen("story")} />
        </div>
        {engagementSelect && (
          <div className="px-4 pb-4">
            <div className="mb-1.5 text-xs font-medium text-ink-3">Engagement</div>
            {engagementSelect}
          </div>
        )}
        <nav className="thin-scroll flex-1 overflow-y-auto px-3" aria-label="Sections">
          <ul className="space-y-0.5">
            {tabs.map((t) => {
              const current = t.id === active?.id;
              return (
                <li key={t.id}>
                  <button
                    onClick={() => goTo(t.id)}
                    aria-current={current ? "page" : undefined}
                    className={cx(
                      "relative flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors duration-150",
                      current ? "bg-brand-wash font-semibold text-ink" : "font-medium text-ink-2 hover:bg-wash hover:text-ink",
                    )}
                  >
                    <span className={cx("absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand transition-opacity duration-150", current ? "opacity-100" : "opacity-0")} />
                    <span className={current ? "text-brand" : "text-ink-3"}>
                      <TabIcon id={t.id} />
                    </span>
                    <span className="flex-1 truncate">{t.label}</span>
                    {!!badges[t.id] && !current && (
                      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-on-brand">{badges[t.id]}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="space-y-2.5 border-t border-line-soft px-5 py-3 text-[13px]">
          {readOnly}
          <div className="min-w-0" title={identity.user}>
            <div className="truncate font-medium text-ink">{identity.department_name ?? roleLabel[identity.role]}</div>
            <div className="truncate text-xs text-ink-2">{identity.user}</div>
          </div>
          <div className="flex items-center gap-4">
            <ThemeSwitch />
            <button onClick={signOut} className="font-medium text-ink-2 transition-colors hover:text-ink">
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Narrow screens keep a top bar with the sections in a scrolling row. */}
        <header className="sticky top-0 z-30 border-b border-line bg-paper lg:hidden">
          <div className="flex h-[52px] items-center gap-3 px-4 text-[13px]">
            <Wordmark onClick={() => setScreen("story")} />
            <div className="ml-auto flex min-w-0 items-center gap-3 whitespace-nowrap">
              {engagementSelect && <div className="w-32">{engagementSelect}</div>}
              <ThemeSwitch />
              <button onClick={signOut} className="font-medium text-ink-2 transition-colors hover:text-ink">
                Sign out
              </button>
            </div>
          </div>
          <nav className="thin-scroll flex h-11 items-stretch gap-0.5 overflow-x-auto border-t border-line-soft px-2" aria-label="Sections">
            {tabs.map((t) => {
              const current = t.id === active?.id;
              return (
                <button
                  key={t.id}
                  onClick={() => goTo(t.id)}
                  aria-current={current ? "page" : undefined}
                  className={cx("relative flex shrink-0 items-center px-3 text-sm whitespace-nowrap transition-colors duration-150", current ? "font-semibold text-ink" : "font-medium text-ink-2 hover:text-ink")}
                >
                  {t.label}
                  {!!badges[t.id] && !current && (
                    <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-on-brand">{badges[t.id]}</span>
                  )}
                  <span className={cx("absolute inset-x-3 -bottom-px h-0.5 bg-brand transition-opacity duration-150", current ? "opacity-100" : "opacity-0")} />
                </button>
              );
            })}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pt-8 pb-16 sm:px-8">
          <div key={`${active?.id}:${engagementId}`} className="view">
            <Suspense fallback={null}>
              {!active || !tools || (auditing && !engagementsLoaded) ? null : active.view({ identity, pulse, goTo, focus, engagementId, onEngagement, tools, can })}
            </Suspense>
          </div>
        </main>
      </div>
      <Toasts />
    </div>
  );
}
