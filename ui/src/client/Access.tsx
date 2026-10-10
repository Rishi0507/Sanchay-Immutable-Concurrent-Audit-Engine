import type { ViewProps } from "../App";
import { Card, ErrorNote, Header, Loading, Mark, cx, useTool } from "../ui";
import { fieldLabel } from "./Records";

interface Policy {
  you: { user: string; role: string; department?: string };
  departments: { id: string; name: string; duties: string }[];
  tools: { name: string; group: string; write: boolean; departments: string[] }[];
}

// A tool name as a person reads it: "create_sales_order" becomes "Create sales order".
export function toolLabel(name: string): string {
  const text = fieldLabel(name.replace("gstr1", "GSTR-1").replace("eway", "e-way"));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Who may do what. The server holds the rule; this screen only shows it.
export default function Access({ identity }: ViewProps) {
  const { data, error, loading, reload } = useTool<Policy>("get_access_policy");
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;

  const mine = identity.department;
  // Tools that every department may call only read, so one line covers them.
  const owned = data.tools.filter((t) => t.departments.length < data.departments.length);
  const groups = [...new Set(owned.map((t) => t.group))];

  return (
    <>
      <Header
        title="Access"
        hint={mine ? "Each department can change only what it owns. Yours is highlighted." : "This identity belongs to no department and is not restricted."}
      />
      <Card>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line text-xs text-ink-2">
                <th className="px-4 py-3 text-left font-medium">Step</th>
                {data.departments.map((d) => (
                  <th key={d.id} title={d.duties} className={cx("w-28 px-3 py-3 text-center font-medium", d.id === mine && "bg-brand-wash text-brand")}>
                    {d.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g} group={g} policy={data} mine={mine} tools={owned.filter((t) => t.group === g)} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line-soft px-4 py-3 text-xs text-ink-3">Every department can view records, evidence requests and the audit trail.</p>
      </Card>
    </>
  );
}

function GroupRows({ group, policy, mine, tools }: { group: string; policy: Policy; mine?: string; tools: Policy["tools"] }) {
  return (
    <>
      <tr className="border-b border-line-soft bg-wash/60">
        <td colSpan={policy.departments.length + 1} className="px-4 py-1.5 text-xs font-semibold text-ink-2">
          {group}
        </td>
      </tr>
      {tools.map((t) => (
        <tr key={t.name} className="border-b border-line-soft last:border-0">
          <td className="px-4 py-2 text-ink">{toolLabel(t.name)}</td>
          {policy.departments.map((d) => (
            <td key={d.id} className={cx("px-3 py-2 text-center", d.id === mine && "bg-brand-wash")}>
              {t.departments.includes(d.id) && (
                <span className={cx("inline-flex", d.id === mine ? "text-brand" : "text-pass")} aria-label={`${d.name} may do this`}>
                  <Mark tone="good" />
                </span>
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
