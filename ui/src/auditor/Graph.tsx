import cytoscape, { Core } from "cytoscape";
import { useEffect, useRef, useState } from "react";
import { money } from "../api";
import type { ViewProps } from "../App";
import { Card, Chip, Empty, ErrorNote, Header, Loading, cx, useTool } from "../ui";

interface GraphData {
  nodes: { id: string; label: string; kind: string; related?: boolean }[];
  edges: { source: string; target: string; kind: string; value: number; count?: number }[];
  cycles: { finding_id?: string; path: string[]; value: number }[];
}

const nodeColor: Record<string, string> = {
  company: "#4f46e5",
  entity: "#4f46e5",
  customer: "#0ea5e9",
  vendor: "#f59e0b",
  cluster: "#8b5cf6",
};

export default function Graph({ pulse, goTo }: ViewProps) {
  const { data, error, loading, reload } = useTool<GraphData>("get_counterparty_graph", {}, [pulse]);
  const holder = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    if (!holder.current || !data?.nodes?.length) return;
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
            "font-size": 9,
            color: "#334155",
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "text-max-width": "110px",
            "text-wrap": "ellipsis",
            width: 22,
            height: 22,
            "background-color": (el: any) => nodeColor[el.data("kind")] ?? "#94a3b8",
            "border-width": (el: any) => (el.data("related") ? 3 : 0),
            "border-color": "#e11d48",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": (el: any) => (el.data("kind") === "money" ? "#86efac" : "#cbd5e1"),
            "target-arrow-color": (el: any) => (el.data("kind") === "money" ? "#86efac" : "#cbd5e1"),
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "line-style": (el: any) => (el.data("kind") === "money" ? "dashed" : "solid"),
          },
        },
        { selector: ".dim", style: { opacity: 0.12 } },
        { selector: "node.hot", style: { width: 30, height: 30, "border-width": 3, "border-color": "#e11d48" } },
        { selector: "edge.hot", style: { width: 3.5, "line-color": "#e11d48", "target-arrow-color": "#e11d48" } },
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: () => 60000, idealEdgeLength: () => 150, nodeOverlap: 40, gravity: 0.2, padding: 40 } as any,
      wheelSensitivity: 0.25,
    });
    cy.current = instance;
    return () => {
      instance.destroy();
      cy.current = null;
    };
  }, [data]);

  // Highlights one cycle and dims everything else.
  useEffect(() => {
    const instance = cy.current;
    if (!instance || !data) return;
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
    if (hot.length) instance.animate({ fit: { eles: hot, padding: 80 }, duration: 350 });
  }, [active, data]);

  const labelOf = (id: string) => data?.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <>
      <Header
        title="Graph"
        hint="Goods and money between the company and its counterparties."
        action={
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-sky-500" />Customer</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-amber-500" />Vendor</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full border-2 border-rose-600" />Related</span>
            <span className="flex items-center gap-1.5"><i className="h-0.5 w-4 bg-slate-300" />Goods</span>
            <span className="flex items-center gap-1.5"><i className="h-0 w-4 border-t-2 border-dashed border-green-300" />Money</span>
          </div>
        }
      />
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <Card>
          <ErrorNote error={error} onRetry={reload} />
        </Card>
      ) : !data?.nodes?.length ? (
        <Card>
          <Empty title="No graph yet" hint="Run the detectors from the Overview tab." />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Card className="overflow-hidden">
            <div ref={holder} className="h-[66vh] w-full" />
          </Card>
          <Card className="thin-scroll max-h-[66vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <span className="text-sm font-semibold">Cycles</span>
              <Chip tone={data.cycles.length ? "bad" : "good"}>{data.cycles.length}</Chip>
            </div>
            {data.cycles.length === 0 ? (
              <Empty title="No cycles found" />
            ) : (
              data.cycles.map((c, i) => (
                <div
                  key={i}
                  onClick={() => setActive(active === i ? null : i)}
                  className={cx("cursor-pointer border-b border-slate-100 px-4 py-3 transition-colors last:border-0", active === i ? "bg-rose-50" : "hover:bg-slate-50")}
                >
                  <div className="text-sm font-medium">{c.path.map(labelOf).join(" → ")} → {labelOf(c.path[0])}</div>
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                    <span className="tabular-nums">₹ {money(c.value)}</span>
                    {c.finding_id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          goTo("findings", c.finding_id);
                        }}
                        className="font-medium text-indigo-600 hover:underline"
                      >
                        Open finding
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      )}
    </>
  );
}
