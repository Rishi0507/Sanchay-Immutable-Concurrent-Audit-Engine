import { Component, ReactNode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Identity, Notice, Role, callTool, getEngagement, getToken, setEngagement, setRole, setToken, subscribe, whoami } from "./api";
import { Button, Toasts, cx, inputClass, toast } from "./ui";
import Upload from "./client/Upload";
import Requests from "./client/Requests";
import Records from "./client/Records";
import Overview from "./auditor/Overview";
import Register from "./auditor/Register";
import Samples from "./auditor/Samples";
import Findings from "./auditor/Findings";
import Trail from "./auditor/Trail";
import Export from "./auditor/Export";

// The two heavy libraries load only where they are used: Three.js on the
// sign-in screen, the graph library on the Graph tab.
const HashChain = lazy(() => import("./HashChain"));
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
}

interface EngagementRef {
  engagement_id: string;
  period_start: string;
  period_end: string;
  opened_at?: string;
  signed_off?: boolean;
}

type TabDef = { id: string; label: string; view: (p: ViewProps) => JSX.Element };

const clientTabs: TabDef[] = [
  { id: "upload", label: "Upload", view: (p) => <Upload {...p} /> },
  { id: "requests", label: "Requests", view: (p) => <Requests {...p} /> },
  { id: "records", label: "Records", view: (p) => <Records {...p} /> },
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

const demoIdentities: { label: string; does: string; token: string }[] = [
  { label: "Client", does: "Record sales, upload the register and evidence", token: "client-demo-token" },
  { label: "Auditor", does: "Sample, test and raise findings", token: "auditor-demo-token" },
  { label: "Audit manager", does: "Confirm findings and sign off", token: "manager-demo-token" },
];

// The auditor's tick mark, used as the product mark.
function Wordmark({ large }: { large?: boolean }) {
  return (
    <div className={cx("flex shrink-0 items-center font-semibold whitespace-nowrap tracking-[-0.01em] text-ink", large ? "gap-2.5 text-xl" : "gap-2 text-[15px]")}>
      <svg width={large ? 22 : 18} height={large ? 22 : 18} viewBox="0 0 20 20" fill="none" stroke="var(--color-brand)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3.5 10.5l4.2 4.2L16.5 5.2" />
      </svg>
      Revenue Audit
    </div>
  );
}

// If WebGL is unavailable the sign-in screen simply shows no chain.
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SignIn({ onSignedIn }: { onSignedIn: (id: Identity) => void }) {
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
    <div className="grid min-h-full md:grid-cols-[minmax(360px,440px)_1fr]">
      <div className="flex flex-col justify-center px-8 py-12 sm:px-12">
        <Wordmark large />
        <p className="mt-3 max-w-xs text-sm text-ink-2">An AI agent runs the statutory revenue audit. A human auditor confirms every conclusion.</p>

        <h1 className="mt-12 text-sm font-semibold">Sign in as</h1>
        <div className="mt-3 divide-y divide-line-soft border-y border-line">
          {demoIdentities.map((d) => (
            <button
              key={d.token}
              onClick={() => signIn(d.token)}
              disabled={!!busy}
              className="group flex w-full items-center justify-between gap-4 py-3.5 text-left transition-colors hover:bg-wash disabled:opacity-60 sm:px-2"
            >
              <span>
                <span className="block text-[15px] font-medium text-ink">{d.label}</span>
                <span className="block text-[13px] text-ink-2">{d.does}</span>
              </span>
              {busy === d.token ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand" />
              ) : (
                <svg className="text-ink-3 transition-colors group-hover:text-brand" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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

      <div className="hidden border-l border-line bg-wash md:block">
        <Quiet>
          <Suspense fallback={null}>
            <HashChain />
          </Suspense>
        </Quiet>
      </div>
    </div>
  );
}

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState("");
  const [focus, setFocus] = useState<string | undefined>();
  const [pulse, setPulse] = useState(0);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [engagements, setEngagements] = useState<EngagementRef[]>([]);
  const [engagementId, setEngagementId] = useState("");
  const [engagementsLoaded, setEngagementsLoaded] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    whoami()
      .then(setIdentity)
      .catch(() => setToken(""))
      .finally(() => setChecking(false));
  }, []);

  const tabs = identity?.role === "client_employee" ? clientTabs : auditorTabs;
  const auditing = !!identity && identity.role !== "client_employee";

  useEffect(() => {
    setRole(identity?.role ?? "");
    if (identity) setTab(identity.role === "client_employee" ? "upload" : "overview");
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

  if (checking) return null;
  if (!identity)
    return (
      <>
        <SignIn onSignedIn={setIdentity} />
        <Toasts />
      </>
    );

  const active = tabs.find((t) => t.id === tab) ?? tabs[0];
  const onEngagement = (id: string) => {
    chooseEngagement(id);
    loadEngagements();
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-paper">
        <div className="mx-auto flex h-[52px] max-w-[1320px] items-stretch gap-8 px-6">
          <div className="flex items-center">
            <Wordmark />
          </div>
          <nav className="flex min-w-0 flex-1 items-stretch gap-0.5" aria-label="Sections">
            {tabs.map((t) => {
              const current = t.id === active.id;
              return (
                <button
                  key={t.id}
                  onClick={() => goTo(t.id)}
                  aria-current={current ? "page" : undefined}
                  className={cx(
                    "relative flex items-center px-3 text-sm transition-colors duration-150",
                    current ? "font-semibold text-ink" : "font-medium text-ink-2 hover:text-ink",
                  )}
                >
                  {t.label}
                  {!!badges[t.id] && !current && (
                    <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{badges[t.id]}</span>
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
              <span className="font-medium text-ink">{roleLabel[identity.role]}</span>
              <span className="hidden xl:inline">, {identity.user}</span>
            </span>
            <button
              onClick={() => {
                setToken("");
                setIdentity(null);
                setEngagements([]);
                setEngagementsLoaded(false);
              }}
              className="font-medium text-ink-2 transition-colors hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1320px] flex-1 px-6 pt-8 pb-16">
        <div key={`${active.id}:${engagementId}`} className="view">
          <Suspense fallback={null}>{auditing && !engagementsLoaded ? null : active.view({ identity, pulse, goTo, focus, engagementId, onEngagement })}</Suspense>
        </div>
      </main>
      <Toasts />
    </div>
  );
}
