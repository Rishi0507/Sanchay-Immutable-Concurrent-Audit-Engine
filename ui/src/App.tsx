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

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-paper">
        <div className="mx-auto flex h-[52px] max-w-[1320px] items-stretch gap-8 px-6">
          <div className="flex items-center">
            <Wordmark onClick={() => setScreen("story")} />
          </div>
          <nav className="flex min-w-0 flex-1 items-stretch gap-0.5" aria-label="Sections">
            {tabs.map((t) => {
              const current = t.id === active?.id;
              return (
                <button
                  key={t.id}
                  onClick={() => goTo(t.id)}
                  aria-current={current ? "page" : undefined}
                  className={cx("relative flex items-center px-3 text-sm transition-colors duration-150", current ? "font-semibold text-ink" : "font-medium text-ink-2 hover:text-ink")}
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
          <div className="flex shrink-0 items-center gap-4 text-[13px] whitespace-nowrap">
            {auditing && engagements.length > 0 && (
              <select
                value={engagementId}
                onChange={(e) => chooseEngagement(e.target.value)}
                className="h-8 max-w-60 truncate rounded-md border border-line bg-paper px-2 text-[13px] text-ink outline-none transition-colors hover:border-ink-3 focus:border-brand"
                aria-label="Engagement"
              >
                {engagements.map((e) => (
                  <option key={e.engagement_id} value={e.engagement_id}>
                    {e.period_start} to {e.period_end}
                    {engagements.length > 1 && e.opened_at ? ` (${new Date(e.opened_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}
                    {e.signed_off ? " (signed off)" : ""}
                  </option>
                ))}
                <option value="">New engagement</option>
              </select>
            )}
            <span className="hidden text-ink-2 lg:inline" title={identity.user}>
              <span className="font-medium text-ink">{identity.department_name ?? roleLabel[identity.role]}</span>
              <span className="hidden xl:inline">, {identity.user}</span>
            </span>
            <ThemeSwitch />
            <button
              onClick={() => {
                setToken("");
                setIdentity(null);
                setEngagements([]);
                setEngagementsLoaded(false);
                setScreen("signin");
              }}
              className="font-medium text-ink-2 transition-colors hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1320px] flex-1 px-6 pt-8 pb-16">
        <div key={`${active?.id}:${engagementId}`} className="view">
          <Suspense fallback={null}>
            {!active || !tools || (auditing && !engagementsLoaded) ? null : active.view({ identity, pulse, goTo, focus, engagementId, onEngagement, tools, can })}
          </Suspense>
        </div>
      </main>
      <Toasts />
    </div>
  );
}
