import cytoscape, { Core } from "cytoscape";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { money } from "../api";
import type { ViewProps } from "../App";
import { token, useTheme } from "../theme";
import { Card, Empty, ErrorNote, Pills, cx, useTool } from "../ui";
import type { GraphData } from "./Graph3D";
import { ChartSkeleton, PageBrief, ViewHead, inr, plural, spotlight } from "./kit";

// The 3D view is the default. The flat view stays for small screens and for printing.
const Graph3D = lazy(() => import("./Graph3D"));

function webgl(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

// Colours are read from the design tokens when the graph is drawn, so they
// follow the theme and mean what they mean everywhere else.
function colours() {
  return {
    company: token("brand"),
    customer: token("wait"),
    vendor: token("warm"),
    related: token("rp"),
    ink: token("ink"),
    paper: token("paper"),
    goods: token("ink-3"),
    money: token("pass"),
    cycle: token("fail"),
  };
}

export default function Graph({ pulse, goTo }: ViewProps) {
  const { data, error, loading, reload } = useTool<GraphData>("get_counterparty_graph", {}, [pulse]);
  const holder = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [theme] = useTheme();
  const [mode, setMode] = useState<"3d" | "2d">(() => (webgl() ? "3d" : "2d"));

  useEffect(() => {
    if (mode !== "2d" || !holder.current || !data?.nodes?.length) return;
    const c = colours();
    const nodeColor: Record<string, string> = { company: c.company, entity: c.company, customer: c.customer, vendor: c.vendor, cluster: c.related };
    const instance = cytoscape({
      container: holder.current,
      elements: [
        ...data.nodes.map((n) => ({ data: { id: n.id, label: n.label, kind: n.kind, related: n.related ? 1 : 0 } })),
        ...data.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, kind: e.kind, value: e.value } })),
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 10,
            color: c.ink,
            "font-family": "Anek Latin Variable, sans-serif",
            "text-background-color": c.paper,
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "text-max-width": "110px",
            "text-wrap": "ellipsis",
            width: 22,
            height: 22,
            "background-color": (el: any) => nodeColor[el.data("kind")] ?? c.goods,
            "border-width": (el: any) => (el.data("related") ? 3 : 0),
            "border-color": c.related,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": (el: any) => (el.data("kind") === "money" ? c.money : c.goods),
            "target-arrow-color": (el: any) => (el.data("kind") === "money" ? c.money : c.goods),
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "line-style": (el: any) => (el.data("kind") === "money" ? "dashed" : "solid"),
          },
        },
        { selector: ".dim", style: { opacity: 0.12 } },
        { selector: "node.hot", style: { width: 30, height: 30, "border-width": 3, "border-color": c.cycle } },
        { selector: "edge.hot", style: { width: 3.5, "line-color": c.cycle, "target-arrow-color": c.cycle, "line-style": "dashed", "line-dash-pattern": [9, 5] } as any },
      ],
      layout: { name: "cose", animate: false, nodeDimensionsIncludeLabels: true, nodeRepulsion: () => 42000, idealEdgeLength: () => 120, nodeOverlap: 40, gravity: 0.25, numIter: 2500, padding: 56 } as any,
      wheelSensitivity: 0.25,
    });
    cy.current = instance;
    return () => {
      instance.destroy();
      cy.current = null;
    };
  }, [data, theme, mode]);

  // Highlights one cycle and dims everything else.
  useEffect(() => {
    const instance = cy.current;
    if (mode !== "2d" || !instance || !data) return;
    instance.elements().removeClass("dim hot");
    if (active === null) return;
    const path = data.cycles[active]?.path ?? [];
    const inCycle = new Set(path);
    instance.elements().addClass("dim");
    instance.nodes().forEach((n) => {
      if (inCycle.has(n.id())) n.removeClass("dim").addClass("hot");
    });
    for (let i = 0; i < path.length; i++) {
      const from = path[i];
      const to = path[(i + 1) % path.length];
      instance.edges(`[source = "${from}"][target = "${to}"]`).removeClass("dim").addClass("hot");
    }
    const hot = instance.elements(".hot");
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (hot.length) instance.animate({ fit: { eles: hot, padding: 80 }, duration: still ? 0 : 350 });
    if (still) return;
    // Dashes travel along the cycle's edges, showing which way goods and money go round.
    let offset = 0;
    let frame = 0;
    const tick = () => {
      offset = (offset - 0.6) % 28;
      instance.edges(".hot").style("line-dash-offset", offset);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, data, mode]);

  const cycleValue = (data?.cycles ?? []).reduce((t, c) => t + (Number(c.value) || 0), 0);
  const biggest = (data?.cycles ?? []).reduce((best, c, i, all) => (best < 0 || (Number(c.value) || 0) > (Number(all[best].value) || 0) ? i : best), -1);
  const counterparties = (data?.nodes ?? []).filter((n) => n.kind === "customer" || n.kind === "vendor").length;
  const labelOf = (id: string) => data?.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <>
      <ViewHead
        title="Graph"
        action={<Pills options={[{ value: "3d", label: "3D" }, { value: "2d", label: "Flat" }]} value={mode} onChange={(v) => setMode(v as "3d" | "2d")} />}
      />
      {data?.nodes?.length ? (
        <PageBrief
          lead={
            data.cycles.length
              ? `${plural(data.cycles.length, "trading cycle")} found, where goods or money come back to where they started.`
              : "No trading cycles: nothing comes back to where it started."
          }
          detail="The company sits between the vendors it buys from and the customers it sells to. A cycle is a chain of trades that returns to its start, which can inflate revenue without real sales. Select a figure to trace the largest cycle."
          stats={[
            { label: "Trading cycles", value: data.cycles.length, tone: data.cycles.length ? "bad" : undefined, onClick: () => spotlight("gr-cycles"), hint: "Go to the list of cycles" },
            { label: "Value going round", value: inr(cycleValue), tone: cycleValue ? "bad" : undefined, active: active !== null, onClick: () => setActive(active === null && biggest >= 0 ? biggest : null), hint: "Highlight the largest cycle" },
            { label: "Customers and vendors", value: counterparties, onClick: () => spotlight("gr-net"), hint: "Go to the network" },
            { label: "Related parties", value: data.nodes.filter((n) => n.related).length, tone: data.nodes.some((n) => n.related) ? "accent" : undefined, onClick: () => spotlight("gr-net"), hint: "Related parties are ringed in the network" },
          ]}
          guide={[
            { label: "The network", target: "gr-net" },
            { label: "The cycles", target: "gr-cycles" },
          ]}
        />
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-2" aria-label="Legend">
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-brand" />Company</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-wait" />Customer</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-warm" />Vendor</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full border-2 border-rp" />Related party</span>
        <span className="flex items-center gap-1.5"><i className="h-0.5 w-4 bg-ink-3" />Goods</span>
        <span className="flex items-center gap-1.5"><i className="h-0 w-4 border-t-2 border-dashed border-pass" />Money</span>
        <span className="flex items-center gap-1.5"><i className="h-0.5 w-4 bg-fail" />Selected cycle</span>
      </div>
      {loading && !data ? (
        <Card className="p-5">
          <ChartSkeleton height={420} />
        </Card>
      ) : error ? (
        <Card>
          <ErrorNote error={error} onRetry={reload} />
        </Card>
      ) : !data?.nodes?.length ? (
        <Card>
          <Empty title="Nothing to draw yet" hint="Run the detectors on the Overview tab to build the graph." />
        </Card>
      ) : (
        <div id="gr-net" className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Card className="overflow-hidden">
            {mode === "3d" ? (
              <Suspense fallback={<div className="h-[66vh] w-full" />}>
                <Graph3D key={theme} data={data} active={active} onPickCycle={setActive} />
              </Suspense>
            ) : (
              <div ref={holder} className="h-[66vh] w-full" aria-label="Network of the company and its counterparties" />
            )}
          </Card>
          <div id="gr-cycles" className="min-w-0">
          <Card className="thin-scroll max-h-[66vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="text-sm font-semibold">Trading cycles</span>
              <span className={cx("text-sm font-semibold tabular-nums", data.cycles.length ? "text-fail" : "text-ink-3")}>{data.cycles.length}</span>
            </div>
            {data.cycles.length === 0 ? (
              <Empty title="No cycles found" hint="No goods or money return to where they started." />
            ) : (
              data.cycles.map((c, i) => (
                <div
                  key={i}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active === i}
                  onClick={() => setActive(active === i ? null : i)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActive(active === i ? null : i);
                    }
                  }}
                  className={cx("cursor-pointer border-b border-l-2 border-b-line-soft px-4 py-3 transition-colors last:border-b-0 focus-visible:bg-wash focus-visible:outline-none", active === i ? "border-l-fail bg-fail-wash" : "border-l-transparent hover:bg-wash")}
                >
                  <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-medium text-ink">
                    {[...c.path, c.path[0]].map((id, k) => (
                      <li key={k} className="flex items-center gap-1.5">
                        {k > 0 && <span className="text-ink-3" aria-hidden>→</span>}
                        <span>{labelOf(id)}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-1.5 flex items-center justify-between text-xs text-ink-2">
                    <span className="num text-[14px] font-medium text-ink">₹ {money(c.value)}</span>
                    {c.finding_id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          goTo("findings", c.finding_id);
                        }}
                        className="font-medium text-brand hover:underline"
                      >
                        Open the finding
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </Card>
          </div>
        </div>
      )}
    </>
  );
}
