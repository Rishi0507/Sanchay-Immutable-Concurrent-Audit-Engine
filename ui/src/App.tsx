import { useCallback, useEffect, useState } from "react";
import { Identity, Notice, Role, callTool, getEngagement, getToken, setEngagement, setRole, setToken, subscribe, whoami } from "./api";
import { Button, Card, Chip, Toasts, cx, inputClass, toast } from "./ui";
import Upload from "./client/Upload";
import Requests from "./client/Requests";
import Records from "./client/Records";
import Overview from "./auditor/Overview";
import Register from "./auditor/Register";
import Samples from "./auditor/Samples";
import Findings from "./auditor/Findings";
import Graph from "./auditor/Graph";
import Trail from "./auditor/Trail";
import Export from "./auditor/Export";

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

const demoIdentities: { label: string; token: string }[] = [
  { label: "Client", token: "client-demo-token" },
  { label: "Auditor", token: "auditor-demo-token" },
  { label: "Audit manager", token: "manager-demo-token" },
];

function SignIn({ onSignedIn }: { onSignedIn: (id: Identity) => void }) {
  const [token, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const signIn = async (t: string) => {
    setBusy(true);
    setError("");
    try {
      const id = await whoami(t);
      setToken(t);
      onSignedIn(id);
    } catch {
      setError("That token is not recognised.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="view w-full max-w-md p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo />
          <div className="text-lg font-semibold tracking-tight">Revenue Audit</div>
        </div>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {demoIdentities.map((d) => (
            <button
              key={d.token}
              onClick={() => signIn(d.token)}
              className="rounded-xl border border-slate-200 px-2 py-3 text-sm font-medium text-slate-700 transition-all duration-150 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="mb-3 flex items-center gap-3 text-xs text-slate-400">
          <div className="h-px flex-1 bg-slate-200" />
          or use a token
          <div className="h-px flex-1 bg-slate-200" />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (token) signIn(token);
          }}
          className="flex gap-2"
        >
          <input className={inputClass} type="password" placeholder="Identity token" value={token} onChange={(e) => setValue(e.target.value)} />
          <Button busy={busy} disabled={!token}>
            Sign in
          </Button>
        </form>
        {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
      </Card>
    </div>
  );
}

function Logo() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600 text-white">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12l5 5L20 6" />
      </svg>
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
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="text-sm font-semibold tracking-tight">Revenue Audit</span>
          </div>
          <nav className="flex h-full flex-1 items-stretch gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => goTo(t.id)}
                className={cx(
                  "relative px-3 text-sm font-medium transition-colors duration-150",
                  t.id === active.id ? "text-indigo-700" : "text-slate-500 hover:text-slate-900",
                )}
              >
                {t.label}
                {!!badges[t.id] && t.id !== active.id && (
                  <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">{badges[t.id]}</span>
                )}
                <span
                  className={cx(
                    "absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-indigo-600 transition-all duration-200",
                    t.id === active.id ? "opacity-100 scale-x-100" : "opacity-0 scale-x-50",
                  )}
                />
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            {auditing && engagements.length > 0 && (
              <select
                value={engagementId}
                onChange={(e) => chooseEngagement(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none transition-shadow focus:ring-4 focus:ring-indigo-100"
                title="Engagement"
              >
                {engagements.map((e) => (
                  <option key={e.engagement_id} value={e.engagement_id}>
                    {e.period_start} to {e.period_end}
                    {engagements.length > 1 && e.opened_at ? `, opened ${new Date(e.opened_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                    {e.signed_off ? " (signed off)" : ""}
                  </option>
                ))}
                <option value="">New engagement</option>
              </select>
            )}
            <Chip tone="accent">{roleLabel[identity.role]}</Chip>
            <span className="hidden text-sm text-slate-500 sm:inline">{identity.user}</span>
            <button
              onClick={() => {
                setToken("");
                setIdentity(null);
                setEngagements([]);
                setEngagementsLoaded(false);
              }}
              className="text-sm text-slate-400 transition-colors hover:text-slate-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <div key={`${active.id}:${engagementId}`} className="view">
          {auditing && !engagementsLoaded ? null : active.view({ identity, pulse, goTo, focus, engagementId, onEngagement })}
        </div>
      </main>
      <Toasts />
    </div>
  );
}
