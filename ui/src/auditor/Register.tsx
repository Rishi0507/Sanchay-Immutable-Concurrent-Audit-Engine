import { useEffect, useMemo, useState } from "react";
import type { ViewProps } from "../App";
import { Button, Card, Chip, Empty, ErrorNote, Mark, Pills, Status, cx, useTool } from "../ui";
import { Calendar, Columns, DayCell, Donut, Pareto, Swatch, ink } from "./charts";
import { ChartSkeleton, FieldGrid, LedgerRows, MoreBar, PageBrief, Panel, RegisterRow, spotlight, SearchBox, Term, ViewHead, dateKey, day, inr, monthKey, monthLabel, monthRange, num, plural, registerFields, scaleFor, useRegisterAll } from "./kit";

const statuses = [
  { value: "MATCHED", label: "Agrees with the books", color: "color-mix(in oklab, var(--color-brand) 42%, transparent)" },
  { value: "FIELD_DIFFERENCE", label: "Differs from the books", color: ink.high },
  { value: "NOT_IN_SYSTEM", label: "No invoice behind it", color: ink.warm },
  { value: "DUPLICATE_ROW", label: "Duplicated row", color: ink.medium },
  { value: "OTHER", label: "Other differences", color: ink.muted },
];

const reconLabel: Record<string, string> = {
  MATCHED: "Agrees",
  FIELD_DIFFERENCE: "Differs",
  NOT_IN_SYSTEM: "Not in system",
  MISSING_IN_REGISTER: "Missing in register",
  DUPLICATE_ROW: "Duplicate",
  ROW_ARITHMETIC: "Does not foot",
  REVERSED_IN_SYSTEM: "Reversed in system",
};

const bucket = (r: RegisterRow) => (!r.recon_status ? "" : statuses.some((s) => s.value === r.recon_status) ? r.recon_status : "OTHER");
const PAGE = 100;

export default function Register({ pulse, goTo, focus, engagementId }: ViewProps) {
  const [status, setStatus] = useState("");
  const [month, setMonth] = useState("");
  const [customer, setCustomer] = useState("");
  const [dayPick, setDayPick] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [onlyBad, setOnlyBad] = useState(true);
  const [rowView, setRowView] = useState<"ledger" | "table">("ledger");
  const reg = useRegisterAll(!!engagementId, pulse);
  const engagement = useTool<any>(engagementId ? "get_engagement_status" : null, {}, [pulse]);
  const f = registerFields(reg.columns);
  const columns = reg.columns.length ? reg.columns : reg.rows[0] ? Object.keys(reg.rows[0].raw) : [];

  // Other views link here with a month or a status already chosen.
  useEffect(() => {
    if (focus?.startsWith("month:")) setMonth(focus.slice(6));
    if (focus === "status:attention") setStatus("attention");
    if (focus?.startsWith("day:")) {
      setDayPick(focus.slice(4));
      setOnlyBad(false);
    }
  }, [focus]);
  useEffect(() => setLimit(PAGE), [status, month, dayPick, customer, query]);

  const matchesStatus = (r: RegisterRow) => !status || (status === "attention" ? !!r.recon_status && r.recon_status !== "MATCHED" : bucket(r) === status);
  const matchesMonth = (r: RegisterRow) => (!month || (f.date ? monthKey(r.raw[f.date]) === month : true)) && (!dayPick || (f.date ? dateKey(r.raw[f.date]) === dayPick : true));
  const matchesCustomer = (r: RegisterRow) => !customer || (f.customer ? String(r.raw[f.customer]) === customer : true);
  const matchesQuery = (r: RegisterRow) => {
    const q = query.trim().toLowerCase();
    return !q || String(r.row_no) === q || Object.values(r.raw).some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q));
  };

  // Each chart follows the other filters, never its own, so it stays usable as a switch.
  const charts = useMemo(() => {
    const value = (r: RegisterRow) => (f.value ? num(r.raw[f.value]) : 0);
    const byStatus = new Map<string, { value: number; rows: number }>();
    const byMonth = new Map<string, Record<string, number>>();
    const byCustomer = new Map<string, { value: number; bad: number; related: boolean }>();
    for (const r of reg.rows) {
      const b = bucket(r);
      if (matchesMonth(r) && matchesCustomer(r) && matchesQuery(r) && b) {
        const s = byStatus.get(b) ?? { value: 0, rows: 0 };
        s.value += value(r);
        s.rows++;
        byStatus.set(b, s);
      }
      if (matchesStatus(r) && matchesCustomer(r) && matchesQuery(r) && f.date) {
        const m = monthKey(r.raw[f.date]);
        if (m) {
          const row = byMonth.get(m) ?? {};
          row[b || "MATCHED"] = (row[b || "MATCHED"] ?? 0) + value(r);
          byMonth.set(m, row);
        }
      }
      if (matchesStatus(r) && matchesMonth(r) && matchesQuery(r) && f.customer) {
        const c = String(r.raw[f.customer] ?? "");
        const e = byCustomer.get(c) ?? { value: 0, bad: 0, related: false };
        e.value += value(r);
        if (r.recon_status && r.recon_status !== "MATCHED") e.bad++;
        if (r.rp_tag === "Related Party") e.related = true;
        byCustomer.set(c, e);
      }
    }
    return {
      byStatus,
      months: monthRange([...byMonth.keys()]).map((m) => ({
        key: m,
        label: monthLabel(m),
        parts: statuses.filter((s) => !onlyBad || s.value !== "MATCHED").map((s) => ({ key: s.value, label: s.label, value: byMonth.get(m)?.[s.value] ?? 0, color: s.color })),
      })),
      customers: [...byCustomer.entries()].sort((a, b) => b[1].value - a[1].value).slice(0, 30),
      customerCount: byCustomer.size,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reg.rows, status, month, dayPick, customer, query, onlyBad, f.date, f.value, f.customer]);

  const visible = useMemo(() => reg.rows.filter((r) => matchesStatus(r) && matchesMonth(r) && matchesCustomer(r) && matchesQuery(r)), [reg.rows, status, month, dayPick, customer, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const differences = statuses
    .filter((st) => st.value !== "MATCHED" && charts.byStatus.has(st.value))
    .map((st) => ({ value_key: st.value, label: st.label, color: st.color, value: charts.byStatus.get(st.value)!.value, rows: charts.byStatus.get(st.value)!.rows }));
  const agreeing = charts.byStatus.get("MATCHED");
  const all = reg.rows.length;
  const periodStart = String(engagement.data?.period_start ?? "");
  const periodEnd = String(engagement.data?.period_end ?? "");

  // Each day's register value and the rows on it that do not agree.
  const calendar = useMemo(() => {
    const days = new Map<string, DayCell>();
    let outside = 0;
    let outsideValue = 0;
    if (!f.date) return { days, outside, outsideValue };
    for (const r of reg.rows) {
      const d = dateKey(r.raw[f.date]);
      if (!d) continue;
      const v = f.value ? num(r.raw[f.value]) : 0;
      if ((periodStart && d < periodStart) || (periodEnd && d > periodEnd)) {
        outside++;
        outsideValue += v;
        continue;
      }
      const cell = days.get(d) ?? { date: d, value: 0, rows: 0, flagged: 0 };
      cell.value += v;
      cell.rows++;
      if (r.recon_status && r.recon_status !== "MATCHED") cell.flagged++;
      days.set(d, cell);
    }
    return { days, outside, outsideValue };
  }, [reg.rows, f.date, f.value, periodStart, periodEnd]);

  // One unit per chart, chosen from its largest figure.
  const monthMax = Math.max(0, ...charts.months.map((m) => m.parts.reduce((t, p) => t + p.value, 0)));
  const monthScale = scaleFor(monthMax);
  const diffScale = scaleFor(Math.max(0, ...differences.map((d) => d.value)));
  const customerScale = scaleFor(Math.max(0, ...charts.customers.map(([, e]) => e.value)));
  const calendarScale = scaleFor(Math.max(0, ...[...calendar.days.values()].map((d) => d.value)));

  // One plain sentence per chart, from the same data.
  const peak = charts.months.reduce<{ label: string; v: number } | null>((best, m) => {
    const v = m.parts.reduce((t, p) => t + p.value, 0);
    return !best || v > best.v ? { label: m.label, v } : best;
  }, null);
  const monthTakeaway = peak && peak.v > 0 ? `${peak.label} is the largest month at ${monthScale.label(peak.v)}.` : "Nothing in view for these filters.";
  const biggestDiff = [...differences].sort((x, y) => y.value - x.value)[0];
  const flaggedDays = [...calendar.days.values()].filter((d) => d.flagged > 0);
  const lastFlagged = flaggedDays.map((d) => d.date).sort().pop();
  const calendarTakeaway = flaggedDays.length
    ? `${plural(flaggedDays.length, "day")} had rows not agreeing${lastFlagged ? `, the last on ${day(lastFlagged)}` : ""}.`
    : "No day had rows that do not agree.";
  const custTotal = charts.customers.reduce((t, [, e]) => t + e.value, 0);
  let running = 0;
  let toEighty = 0;
  for (const [, e] of charts.customers) {
    running += e.value;
    toEighty++;
    if (custTotal && running / custTotal >= 0.8) break;
  }
  const concentrationTakeaway = charts.customers.length
    ? `The largest ${toEighty} of these ${charts.customers.length} customers make up 80% of their value; the top one alone is ${custTotal ? ((charts.customers[0][1].value / custTotal) * 100).toFixed(0) : 0}%.`
    : undefined;
  const attention = reg.rows.filter((r) => r.recon_status && r.recon_status !== "MATCHED");
  const total = f.value ? reg.rows.reduce((t, r) => t + num(r.raw[f.value!]), 0) : 0;
  const attentionValue = f.value ? attention.reduce((t, r) => t + num(r.raw[f.value!]), 0) : 0;
  const filtered = !!(status || month || dayPick || customer || query);
  const relatedCustomers = charts.customers.filter(([, e]) => e.related).length;
  const clear = () => {
    setStatus("");
    setMonth("");
    setDayPick("");
    setCustomer("");
    setQuery("");
  };

  return (
    <>
      <ViewHead title="Sales register" />

      {all > 0 && (
        <PageBrief
          lead={`${plural(all, "row")} worth ${inr(total)}. ${plural(attention.length, "row")} worth ${inr(attentionValue)} ${attention.length === 1 ? "does" : "do"} not agree with the books.`}
          detail="The client's register exactly as provided, reconciled line by line against the sales in the books. Select a figure to filter every chart and the rows below."
          stats={[
            { label: "Rows in the register", value: all.toLocaleString("en-IN"), active: !filtered, onClick: clear, hint: "Clear every filter" },
            { label: "Agree with the books", value: (all - attention.length).toLocaleString("en-IN"), tone: "good", active: status === "MATCHED", onClick: () => setStatus(status === "MATCHED" ? "" : "MATCHED"), hint: "Show only rows that agree" },
            { label: "Do not agree", value: attention.length, tone: attention.length ? "bad" : undefined, active: status === "attention", onClick: () => setStatus(status === "attention" ? "" : "attention"), hint: "Show only rows that do not agree" },
            { label: `Customers, ${relatedCustomers} related`, value: charts.customerCount, onClick: () => spotlight("rg-customers"), hint: "Go to customer concentration" },
          ]}
          guide={[
            { label: "Month by month", target: "rg-months" },
            { label: "Day by day", target: "rg-days" },
            { label: "Customers", target: "rg-customers" },
            { label: "The rows", target: "rg-rows" },
          ]}
        />
      )}

      {reg.loading && !all ? (
        <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <Card className="p-5">
            <ChartSkeleton height={220} />
          </Card>
          <Card className="p-5">
            <ChartSkeleton height={220} />
          </Card>
        </div>
      ) : reg.error ? (
        <Card>
          <ErrorNote error={reg.error} />
        </Card>
      ) : all === 0 ? (
        <Card>
          <Empty title="No register to show yet" hint="The client uploads the sales register; then run Import the register from the plan on the Overview." />
        </Card>
      ) : (
        <>
          <div id="rg-months" className="mb-5 grid gap-5 lg:grid-cols-[1.5fr_1fr]">
            <Panel
              title={onlyBad ? "In which months do rows not agree with the books?" : "How was the register's value spread across the year?"}
              takeaway={monthTakeaway}
              meta={
                <span className="flex items-center gap-3">
                  {month && (
                    <button onClick={() => setMonth("")} className="font-medium text-brand hover:underline">
                      All months
                    </button>
                  )}
                  <Pills value={onlyBad ? "bad" : "all"} onChange={(v) => setOnlyBad(v === "bad")} options={[{ value: "all", label: "All" }, { value: "bad", label: "Not agreeing" }]} />
                </span>
              }
            >
              <Columns data={charts.months} height={220} format={monthScale.label} axisFormat={monthScale.axis} selected={month || undefined} onSelect={(m) => setMonth(month === m ? "" : m)} />
              <p className="mt-2 text-xs text-ink-2">Select a month to show only its rows.</p>
            </Panel>
            <Panel
              title="Why do rows not agree?"
              takeaway={biggestDiff ? `${biggestDiff.label} is the largest at ${diffScale.label(biggestDiff.value)}.` : "Every row in view agrees with the books."}
              meta={status ? <button onClick={() => setStatus("")} className="font-medium text-brand hover:underline">All rows</button> : undefined}
            >
              {differences.length > 0 && (
                <Donut
                  size={150}
                  thickness={20}
                  center={diffScale.label(differences.reduce((t, d) => t + d.value, 0))}
                  centerNote={plural(differences.reduce((t, d) => t + d.rows, 0), "row")}
                  format={diffScale.label}
                  selected={status && status !== "attention" ? status : undefined}
                  onSelect={(k) => setStatus(status === k ? "" : k)}
                  slices={differences.map((d) => ({ key: d.value_key, label: d.label, value: d.value, color: d.color, detail: plural(d.rows, "row") }))}
                />
              )}
              {agreeing && (
                <button onClick={() => setStatus(status === "MATCHED" ? "" : "MATCHED")} aria-pressed={status === "MATCHED"} className={cx("mt-4 flex w-full items-center gap-2.5 rounded-md border-t border-line-soft px-2 pt-3 pb-1 text-left text-[13px]", status === "MATCHED" ? "text-ink" : "text-ink-2 hover:text-ink")}>
                  <Mark tone="good" size={14} />
                  <span className="flex-1">{plural(agreeing.rows, "row")} agree with the books</span>
                  <span className="num font-medium text-ink">{inr(agreeing.value)}</span>
                </button>
              )}
            </Panel>
          </div>

          <MoreBar group="rg" title="More analysis" items="A calendar of sales by day, and how concentrated revenue is among customers." />
          {calendar.days.size > 0 && periodStart && periodEnd && (
            <Panel
              id="rg-days"
              more="rg"
              className="mb-5"
              title="Which days carried the sales, and which had rows not agreeing?"
              takeaway={calendarTakeaway}
              meta={
                calendar.outside ? (
                  <span className="text-xs text-fail">
                    {plural(calendar.outside, "row")} dated outside the period, {inr(calendar.outsideValue)}
                  </span>
                ) : undefined
              }
            >
              <Calendar start={periodStart} end={periodEnd} days={calendar.days} format={calendarScale.label} selected={dayPick || undefined} onSelect={(d) => setDayPick(dayPick === d ? "" : d)} />
            </Panel>
          )}

          <Panel
            id="rg-customers"
            more="rg"
            className="mb-5"
            title="How concentrated is revenue among customers?"
            takeaway={concentrationTakeaway}
            meta={
              customer ? (
                <button onClick={() => setCustomer("")} className="font-medium text-brand hover:underline">
                  All customers
                </button>
              ) : (
                <span className="text-xs">Largest {charts.customers.length} of {charts.customerCount}. Select a bar to filter.</span>
              )
            }
          >
            <Pareto
              height={230}
              format={customerScale.label}
              axisFormat={customerScale.axis}
              selected={customer || undefined}
              onSelect={(c) => setCustomer(customer === c ? "" : c)}
              items={charts.customers.map(([name, e]) => ({
                key: name,
                label: name,
                value: e.value,
                color: e.related ? ink.rp : "color-mix(in oklab, var(--color-brand) 60%, transparent)",
                flagged: e.bad > 0,
                note: [e.related ? "Related party" : "", e.bad ? plural(e.bad, "row") + " not agreeing" : ""].filter(Boolean).join(", "),
              }))}
            />
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-2">
              <span className="flex items-center gap-1.5">
                <Swatch color="color-mix(in oklab, var(--color-brand) 60%, transparent)" />
                Customer
              </span>
              <span className="flex items-center gap-1.5">
                <Swatch color={ink.rp} />
                <Term word="related party">Related party</Term>
              </span>
              <span className="flex items-center gap-1.5">
                <i className="inline-block h-2.5 w-2.5 rounded-[3px] border-2 border-fail" />
                Red outline and a mark above the bar: has rows not agreeing (on either colour)
              </span>
              <span>Dashed line: 80% of revenue</span>
            </div>
          </Panel>

          <div id="rg-rows">
            <div className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="w-full sm:w-72">
                  <SearchBox value={query} onChange={setQuery} label="Search the register" placeholder="Search bill no., customer, amount" />
                </div>
                <button onClick={() => setStatus(status === "attention" ? "" : "attention")} aria-pressed={status === "attention"} className={cx("inline-flex h-9 items-center gap-2 rounded-md border px-3 text-[13px] transition-colors", status === "attention" ? "border-ink bg-wash text-ink" : "border-line text-ink-2 hover:text-ink")}>
                  <Swatch color={ink.high} />
                  Only rows needing attention
                </button>
                {dayPick && (
                  <button onClick={() => setDayPick("")} className="inline-flex h-9 items-center gap-2 rounded-md border border-ink bg-wash px-3 text-[13px] text-ink">
                    {day(dayPick)}
                    <span aria-hidden className="text-ink-3">✕</span>
                    <span className="sr-only">Remove the day filter</span>
                  </button>
                )}
                <span className="text-[13px] text-ink-2">
                  {plural(visible.length, "row")}
                  {filtered ? ` of ${all}` : ""}
                </span>
                {filtered && (
                  <button onClick={clear} className="text-[13px] font-medium text-brand hover:underline">
                    Clear filters
                  </button>
                )}
                <span className="ml-auto">
                  <Pills value={rowView} onChange={setRowView} options={[{ value: "ledger", label: "Ledger" }, { value: "table", label: "Every column" }]} />
                </span>
              </div>

              <Card>
                {visible.length === 0 ? (
                  <Empty title="No rows match" hint="Change the filters or clear them." />
                ) : rowView === "ledger" ? (
                  <>
                    <div className="thin-scroll max-h-[640px] overflow-auto">
                      <LedgerRows
                        items={visible.slice(0, limit).map((r) => {
                          const b = bucket(r);
                          const st = statuses.find((x) => x.value === b);
                          const date = f.date ? dateKey(r.raw[f.date]) : null;
                          return {
                            key: String(r.row_no),
                            rail: b && b !== "MATCHED" ? st?.color ?? ink.high : "var(--color-line)",
                            group: date ? monthLabel(date.slice(0, 7)) : undefined,
                            title: (
                              <>
                                {f.bill ? String(r.raw[f.bill] ?? "") : `Row ${r.row_no}`}
                                <span className="ml-2 font-normal text-ink-2">{f.customer ? String(r.raw[f.customer] ?? "") : ""}</span>
                                {r.rp_tag === "Related Party" && (
                                  <span className="ml-2 align-middle">
                                    <Chip tone="rp">Related</Chip>
                                  </span>
                                )}
                              </>
                            ),
                            meta: `${date ? day(date) : ""}${r.finding_ids?.length ? `, ${plural(r.finding_ids.length, "finding")}` : ""}`,
                            amount: f.value ? num(r.raw[f.value]) : undefined,
                            status: r.recon_status ? <Status tone={r.recon_status === "MATCHED" ? "good" : "bad"}>{reconLabel[r.recon_status] ?? r.recon_status.replace(/_/g, " ").toLowerCase()}</Status> : null,
                            detail: (
                              <>
                                <FieldGrid fields={[["Row", r.row_no], ...columns.map((c) => [c, r.raw[c] === null || r.raw[c] === undefined ? "" : String(r.raw[c])] as [string, string])]} />
                                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line-soft pt-3 text-[13px]">
                                  <span className="text-ink-3">Auditor&apos;s marks</span>
                                  {r.recon_status && <Status tone={r.recon_status === "MATCHED" ? "good" : "bad"}>{reconLabel[r.recon_status] ?? r.recon_status}</Status>}
                                  {r.rp_tag && <span className="text-ink-2">{r.rp_tag}</span>}
                                  {r.suggested_rp && (
                                    <Chip tone="warn" title={r.suggested_rp}>
                                      Possibly related
                                    </Chip>
                                  )}
                                  {r.finding_ids?.length > 0 && (
                                    <button className="inline-flex items-center gap-1 font-medium text-brand hover:underline" onClick={() => goTo("findings", r.finding_ids[0])}>
                                      <Mark tone="accent" size={12} />
                                      Open {plural(r.finding_ids.length, "finding")}
                                    </button>
                                  )}
                                </div>
                              </>
                            ),
                          };
                        })}
                      />
                    </div>
                    <div className="flex items-center justify-between border-t border-line-soft px-4 py-3 text-xs text-ink-3">
                      <span className="tabular-nums">
                        Showing {Math.min(limit, visible.length)} of {visible.length}. Select a row to open it; arrow keys move between rows.
                      </span>
                      {limit < visible.length && (
                        <Button kind="ghost" small onClick={() => setLimit((l) => l + PAGE)}>
                          Show {Math.min(PAGE, visible.length - limit)} more
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="thin-scroll max-h-[560px] overflow-auto">
                      <table className="w-full text-[13px]">
                        <thead className="sticky top-0 z-10 bg-paper">
                          <tr className="border-b border-line text-left text-xs text-ink-2">
                            <th className="px-3 py-2.5 font-medium">Row</th>
                            {columns.map((c) => (
                              <th key={c} className="px-3 py-2.5 font-medium whitespace-nowrap">
                                {c}
                              </th>
                            ))}
                            {/* The auditor's own columns stay pinned, so they are in view
                                however wide the client's register is. */}
                            <th className="sticky right-0 border-l border-line bg-brand-wash px-3 py-2.5 font-medium whitespace-nowrap text-brand">Auditor's marks</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.slice(0, limit).map((r) => {
                            const marked = !!r.recon_status && r.recon_status !== "MATCHED";
                            return (
                              <tr key={r.row_no} className={cx("border-b border-line-soft transition-colors last:border-0", marked ? "bg-mark hover:bg-mark-hover" : "hover:bg-wash")}>
                                <td className="px-3 py-2 text-ink-3 tabular-nums">{r.row_no}</td>
                                {columns.map((c) => (
                                  <td key={c} className="px-3 py-2 whitespace-nowrap">
                                    {r.raw[c] === null || r.raw[c] === undefined ? "" : String(r.raw[c])}
                                  </td>
                                ))}
                                <td className={cx("sticky right-0 border-l border-line px-3 py-2", marked ? "bg-mark" : "bg-paper")}>
                                  <div className="flex items-center gap-3 whitespace-nowrap">
                                    {r.recon_status && (
                                      <span className="w-[112px]">
                                        <Status tone={r.recon_status === "MATCHED" ? "good" : "bad"}>{reconLabel[r.recon_status] ?? r.recon_status.replace(/_/g, " ").toLowerCase()}</Status>
                                      </span>
                                    )}
                                    <span className="w-[64px]">{r.rp_tag === "Related Party" ? <Chip tone="rp">Related</Chip> : null}</span>
                                    {r.suggested_rp && (
                                      <Chip tone="warn" title={r.suggested_rp}>
                                        Possibly related
                                      </Chip>
                                    )}
                                    {r.finding_ids?.length > 0 && (
                                      <button className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline" onClick={() => goTo("findings", r.finding_ids[0])}>
                                        <Mark tone="accent" size={12} />
                                        {plural(r.finding_ids.length, "finding")}
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex items-center justify-between border-t border-line-soft px-4 py-3 text-xs text-ink-3">
                      <span className="tabular-nums">
                        Showing {Math.min(limit, visible.length)} of {visible.length}
                      </span>
                      {limit < visible.length && (
                        <Button kind="ghost" small onClick={() => setLimit((l) => l + PAGE)}>
                          Show {Math.min(PAGE, visible.length - limit)} more
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
