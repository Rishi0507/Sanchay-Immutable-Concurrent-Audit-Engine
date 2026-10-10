// The counterparty graph as a trade board.
//
// Read it left to right: vendors supply the company on the left, the company
// sits in the middle, customers buy on the right. Each counterparty is a
// column whose height is its trade with the company. Parties that both buy
// and sell, where circular trading lives, stand in their own row in front.
// Only the parties that matter are drawn: the largest vendors and customers,
// every related party and every member of a cycle. The rest are summed into
// one column per side, so the picture stays readable.
//
// Layout is deterministic: the same graph always draws the same way.

import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { money } from "../api";
import { prefersReducedMotion, token } from "../theme";

export interface GraphData {
  nodes: { id: string; label: string; kind: string; related?: boolean }[];
  edges: { source: string; target: string; kind: string; value: number; count?: number }[];
  cycles: { finding_id?: string; path: string[]; value: number }[];
}

type Side = "vendor" | "customer" | "both" | "company" | "entity";

interface Column {
  id: string;
  label: string;
  side: Side;
  related: boolean;
  inCycle: boolean;
  others: number; // how many parties a summary column stands for, 0 for a single party
  pos: THREE.Vector3;
  height: number;
  volume: number;
  goodsIn: number;
  goodsOut: number;
  moneyIn: number;
  moneyOut: number;
}

interface Flow {
  from: number;
  to: number;
  kind: "goods" | "money";
  value: number;
  curve: THREE.CatmullRomCurve3;
  width: number;
}

const TOP_VENDORS = 5;
const TOP_CUSTOMERS = 6;
const NAMED_PER_SIDE = 3;
const isCompany = (k: string) => k === "company" || k === "entity";

function sideOf(kind: string): Side {
  if (kind === "company") return "company";
  if (kind === "entity") return "entity";
  if (kind === "vendor") return "vendor";
  if (kind === "customer") return "customer";
  return "both";
}

// Back-row labels alternate between two heights so neighbours do not overlap.
function labelLift(c: Column): number {
  return c.side === "both" && Math.abs(Math.round(c.pos.x / 3.3)) % 2 === 1 ? 1.5 : 0;
}

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹ ${(v / 1e7).toFixed(a >= 1e9 ? 0 : 1)} Cr`;
  if (a >= 1e5) return `₹ ${(v / 1e5).toFixed(1)} L`;
  return `₹ ${money(v)}`;
}

function build(data: GraphData) {
  const flows = new Map<string, { gi: number; go: number; mi: number; mo: number }>();
  const f = (id: string) => {
    if (!flows.has(id)) flows.set(id, { gi: 0, go: 0, mi: 0, mo: 0 });
    return flows.get(id)!;
  };
  for (const e of data.edges) {
    if (e.kind === "money") {
      f(e.source).mo += e.value;
      f(e.target).mi += e.value;
    } else {
      f(e.source).go += e.value;
      f(e.target).gi += e.value;
    }
  }
  const vol = (id: string) => {
    const x = flows.get(id);
    return x ? x.gi + x.go + x.mi + x.mo : 0;
  };
  const cycleIds = new Set(data.cycles.flatMap((c) => c.path));
  const byVol = (a: { id: string }, b: { id: string }) => vol(b.id) - vol(a.id) || a.id.localeCompare(b.id);

  // Choose what to draw.
  const keep = new Set<string>();
  const grouped = new Map<string, string>(); // party id -> summary column id
  const groups: Record<"vendor" | "customer" | "both", string[]> = { vendor: [], customer: [], both: [] };
  for (const side of ["vendor", "customer"] as const) {
    const list = data.nodes.filter((n) => sideOf(n.kind) === side).sort(byVol);
    const top = side === "vendor" ? TOP_VENDORS : TOP_CUSTOMERS;
    list.forEach((n, i) => {
      if (i < top || n.related || cycleIds.has(n.id)) keep.add(n.id);
      else {
        grouped.set(n.id, `others:${side}`);
        groups[side].push(n.id);
      }
    });
  }
  data.nodes.forEach((n) => {
    const s = sideOf(n.kind);
    if (s === "company" || s === "entity") keep.add(n.id);
    if (s === "both") {
      if (n.related || cycleIds.has(n.id)) keep.add(n.id);
      else {
        grouped.set(n.id, "others:both");
        groups.both.push(n.id);
      }
    }
  });

  const columns: Column[] = [];
  const index = new Map<string, number>();
  const add = (c: Omit<Column, "pos" | "height">) => {
    index.set(c.id, columns.length);
    columns.push({ ...c, pos: new THREE.Vector3(), height: 0 });
  };
  for (const n of data.nodes.filter((x) => keep.has(x.id))) {
    const fl = flows.get(n.id) ?? { gi: 0, go: 0, mi: 0, mo: 0 };
    add({ id: n.id, label: n.label, side: sideOf(n.kind), related: !!n.related, inCycle: cycleIds.has(n.id), others: 0,
      volume: vol(n.id), goodsIn: fl.gi, goodsOut: fl.go, moneyIn: fl.mi, moneyOut: fl.mo });
  }
  for (const side of ["vendor", "customer", "both"] as const) {
    const ids = groups[side];
    if (!ids.length) continue;
    const sum = { gi: 0, go: 0, mi: 0, mo: 0 };
    ids.forEach((id) => {
      const x = flows.get(id);
      if (x) (Object.keys(sum) as (keyof typeof sum)[]).forEach((k) => (sum[k] += x[k]));
    });
    add({ id: `others:${side}`, label: side === "both" ? `${ids.length} others that buy and sell` : `${ids.length} other ${side}s`, side, related: false, inCycle: false, others: ids.length,
      volume: sum.gi + sum.go + sum.mi + sum.mo, goodsIn: sum.gi, goodsOut: sum.go, moneyIn: sum.mi, moneyOut: sum.mo });
  }

  // Heights: log scale between the smallest and largest party drawn.
  const parties = columns.filter((c) => !isCompany(c.side));
  const logs = parties.map((c) => Math.log10(1 + c.volume));
  const lo = Math.min(...logs, 0);
  const hi = Math.max(...logs, lo + 1);
  parties.forEach((c) => {
    c.height = 0.5 + 4.2 * ((Math.log10(1 + c.volume) - lo) / (hi - lo));
  });

  // Positions: vendors on an arc to the left, customers to the right, both-sided parties in front.
  const place = (list: Column[], dir: -1 | 1) => {
    const ordered = list.filter((c) => !c.others).sort((a, b) => b.volume - a.volume || a.id.localeCompare(b.id));
    const summary = list.find((c) => c.others);
    const all = summary ? [...ordered, summary] : ordered;
    const span = Math.min(1.5, 0.24 * Math.max(1, all.length - 1));
    all.forEach((c, i) => {
      const t = all.length === 1 ? 0 : i / (all.length - 1);
      const a = -span / 2 + t * span;
      const r = 11.5;
      c.pos.set(dir * Math.cos(a) * r, 0, -Math.sin(a) * r * 1.05);
    });
  };
  place(columns.filter((c) => c.side === "vendor"), -1);
  place(columns.filter((c) => c.side === "customer"), 1);
  const both = columns.filter((c) => c.side === "both").sort((a, b) => b.volume - a.volume || a.id.localeCompare(b.id));
  both.forEach((c, i) => c.pos.set((i - (both.length - 1) / 2) * 3.3, 0, -6.6));
  const comps = columns.filter((c) => isCompany(c.side));
  comps.forEach((c, i) => {
    c.height = i === 0 ? 1.6 : 1.1;
    c.pos.set(i === 0 ? 0 : (i % 2 ? 1 : -1) * 3.4 * Math.ceil(i / 2), 0, i === 0 ? 0 : 3.6);
  });

  // Flows between drawn columns, summed when parties were grouped.
  const sums = new Map<string, { from: number; to: number; kind: "goods" | "money"; value: number }>();
  for (const e of data.edges) {
    const s = index.get(keep.has(e.source) ? e.source : grouped.get(e.source) ?? "");
    const t = index.get(keep.has(e.target) ? e.target : grouped.get(e.target) ?? "");
    if (s === undefined || t === undefined || s === t) continue;
    const kind = e.kind === "money" ? "money" : "goods";
    const key = `${s}>${t}>${kind}`;
    const cur = sums.get(key) ?? { from: s, to: t, kind, value: 0 };
    cur.value += e.value;
    sums.set(key, cur);
  }
  const maxV = Math.max(1, ...[...sums.values()].map((x) => x.value));
  const flowList: Flow[] = [...sums.values()].map((x) => {
    const a = columns[x.from].pos;
    const b = columns[x.to].pos;
    // Goods arcs run high, money arcs run low, so the two directions never sit on top of each other.
    const lift = x.kind === "goods" ? 1.9 : 0.55;
    const side = new THREE.Vector3(b.z - a.z, 0, a.x - b.x).normalize().multiplyScalar(x.kind === "goods" ? 0.35 : -0.35);
    const mid = a.clone().add(b).multiplyScalar(0.5).add(side);
    mid.y = lift + a.distanceTo(b) * (x.kind === "goods" ? 0.09 : 0.03);
    const start = a.clone().setY(x.kind === "goods" ? 0.35 : 0.12);
    const end = b.clone().setY(x.kind === "goods" ? 0.35 : 0.12);
    return { ...x, curve: new THREE.CatmullRomCurve3([start, mid, end]), width: 0.025 + 0.075 * Math.sqrt(x.value / maxV) };
  });
  return { columns, index, flows: flowList, grouped };
}

function palette(dark: boolean) {
  return {
    dark,
    paper: new THREE.Color(token("paper")),
    wash: new THREE.Color(token("wash")),
    line: new THREE.Color(token("line")),
    ink: new THREE.Color(token("ink")),
    ink3: new THREE.Color(token("ink-3")),
    company: new THREE.Color(token("brand")),
    customer: new THREE.Color(token("wait")),
    vendor: new THREE.Color(token("warm")),
    both: new THREE.Color(token("rp")),
    goods: new THREE.Color(dark ? token("ink-2") : token("ink-3")),
    money: new THREE.Color(token("pass")),
    cycle: new THREE.Color(token("fail")),
  };
}

interface CamState {
  theta: number;
  phi: number;
  dist: number;
  target: THREE.Vector3;
  goalTarget: THREE.Vector3;
  goalDist: number;
}

const HOME = { theta: 0, phi: 0.62, dist: 34 };
const HOME_TARGET: [number, number, number] = [0, 1.2, -2.2];

function Rig({ cam }: { cam: React.MutableRefObject<CamState> }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    const c = cam.current;
    const k = 1 - Math.pow(0.03, dt);
    c.target.lerp(c.goalTarget, k);
    c.dist += (c.goalDist - c.dist) * k;
    const sp = Math.sin(c.phi);
    camera.position.set(c.target.x + c.dist * sp * Math.sin(c.theta), c.target.y + c.dist * Math.cos(c.phi), c.target.z + c.dist * sp * Math.cos(c.theta));
    camera.lookAt(c.target);
  });
  return null;
}

function Board({ pal }: { pal: ReturnType<typeof palette> }) {
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(44, 22, pal.line, pal.line);
    const m = g.material as THREE.Material;
    m.transparent = true;
    m.opacity = pal.dark ? 0.35 : 0.6;
    return g;
  }, [pal]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[44, 30]} />
        <meshStandardMaterial color={pal.wash} roughness={1} />
      </mesh>
      <primitive object={grid} position={[0, 0, 0]} scale={[1, 1, 30 / 44]} />
    </group>
  );
}

function ColumnMesh({
  c, i, pal, state, onHover, onPick,
}: {
  c: Column;
  i: number;
  pal: ReturnType<typeof palette>;
  state: "normal" | "hot" | "dim";
  onHover: (i: number | null) => void;
  onPick: (i: number) => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const shown = useRef(0);
  const base =
    c.side === "company" || c.side === "entity" ? pal.company : c.side === "vendor" ? pal.vendor : c.side === "customer" ? pal.customer : pal.both;
  const color = useMemo(() => {
    if (state === "hot") return pal.cycle.clone();
    if (c.others) return pal.ink3.clone();
    const col = base.clone();
    if (state === "dim") col.lerp(pal.wash, 0.78);
    return col;
  }, [state, base, pal, c.others]);
  const w = isCompany(c.side) ? (c.side === "company" ? 2.6 : 1.8) : c.others ? 1.1 : 0.9;
  useFrame((_, dt) => {
    // Columns rise once when the view opens.
    shown.current = Math.min(1, shown.current + dt * 1.4);
    const e = 1 - Math.pow(1 - shown.current, 3);
    if (ref.current) {
      ref.current.scale.y = Math.max(0.001, e);
      ref.current.position.y = (c.height * e) / 2;
    }
  });
  return (
    <group position={[c.pos.x, 0, c.pos.z]}>
      <mesh
        ref={ref}
        castShadow
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover(i);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onPick(i);
        }}
      >
        <boxGeometry args={[w, c.height, w]} />
        <meshStandardMaterial color={color} roughness={0.55} metalness={isCompany(c.side) ? 0.35 : 0.05} transparent opacity={state === "dim" ? 0.55 : 1} />
      </mesh>
      {c.related && (
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[w * 0.82, w * 0.98, 48]} />
          <meshBasicMaterial color={pal.both} transparent opacity={state === "dim" ? 0.25 : 0.9} />
        </mesh>
      )}
    </group>
  );
}

function Flows({ flows, pal, hot, reduced }: { flows: Flow[]; pal: ReturnType<typeof palette>; hot: Set<number> | null; reduced: boolean }) {
  const tubes = useMemo(() => flows.map((f) => new THREE.TubeGeometry(f.curve, 48, f.width, 8, false)), [flows]);
  useEffect(() => () => tubes.forEach((t) => t.dispose()), [tubes]);
  // A few markers per flow travel in its direction. They are slow and small; their job is to show direction.
  const markers = useMemo(() => flows.flatMap((_, i) => [0, 0.5].map((o) => ({ flow: i, t: (o + i * 0.137) % 1 }))), [flows]);
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    markers.forEach((m, i) => {
      const f = flows[m.flow];
      const c = hot ? (hot.has(m.flow) ? pal.cycle : pal.wash) : f.kind === "money" ? pal.money : pal.goods;
      mesh.setColorAt(i, c);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [markers, flows, pal, hot]);
  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    markers.forEach((m, i) => {
      const lit = hot?.has(m.flow);
      if (!reduced) m.t = (m.t + dt * (lit ? 0.32 : 0.14)) % 1;
      flows[m.flow].curve.getPoint(m.t, p);
      dummy.position.copy(p);
      dummy.scale.setScalar(hot && !lit ? 0.001 : flows[m.flow].width * 2.2 + 0.05);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      {flows.map((f, i) => {
        const lit = hot?.has(i);
        const color = hot ? (lit ? pal.cycle : pal.line) : f.kind === "money" ? pal.money : pal.goods;
        return (
          <mesh key={i} geometry={tubes[i]} raycast={() => null}>
            <meshStandardMaterial color={color} roughness={0.6} transparent opacity={hot ? (lit ? 0.95 : 0.12) : 0.55} />
          </mesh>
        );
      })}
      <instancedMesh ref={ref} args={[undefined, undefined, markers.length]} raycast={() => null}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshStandardMaterial roughness={0.4} />
      </instancedMesh>
    </group>
  );
}

// Labels are DOM elements placed every frame from the 3D positions, so text stays crisp.
function Labels({ columns, nodes, extra, extraEls }: {
  columns: Column[];
  nodes: React.MutableRefObject<(HTMLDivElement | null)[]>;
  extra: THREE.Vector3[];
  extraEls: React.MutableRefObject<(HTMLDivElement | null)[]>;
}) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  const at = useMemo(() => new THREE.Vector3(), []);
  const put = (el: HTMLDivElement | null, p: THREE.Vector3) => {
    if (!el) return;
    v.copy(p).project(camera);
    el.style.visibility = v.z < 1 ? "visible" : "hidden";
    el.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px)`;
  };
  useFrame(() => {
    columns.forEach((c, i) => put(nodes.current[i], at.set(c.pos.x, c.height + 0.35 + labelLift(c), c.pos.z)));
    extra.forEach((p, i) => put(extraEls.current[i], p));
  });
  return null;
}

export default function Graph3D({ data, active, onPickCycle }: { data: GraphData; active: number | null; onPickCycle: (i: number | null) => void }) {
  const dark = document.documentElement.dataset.theme !== "light";
  const pal = useMemo(() => palette(dark), [dark]);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const { columns, index, flows, grouped } = useMemo(() => build(data), [data]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const cam = useRef<CamState>({ ...HOME, target: new THREE.Vector3(...HOME_TARGET), goalTarget: new THREE.Vector3(...HOME_TARGET), goalDist: HOME.dist });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const cycle = active !== null ? data.cycles[active] : null;
  const colOf = (id: string) => index.get(id) ?? index.get(grouped.get(id) ?? "");
  const hotCols = useMemo(() => {
    if (!cycle) return null;
    return new Set(cycle.path.map(colOf).filter((x): x is number => x !== undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle, index, grouped]);
  const hotFlows = useMemo(() => {
    if (!cycle) return null;
    const out = new Set<number>();
    for (let i = 0; i < cycle.path.length; i++) {
      const a = colOf(cycle.path[i]);
      const b = colOf(cycle.path[(i + 1) % cycle.path.length]);
      flows.forEach((f, k) => f.from === a && f.to === b && out.add(k));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle, flows, index, grouped]);

  useEffect(() => {
    const c = cam.current;
    if (hotCols && hotCols.size) {
      const pts = [...hotCols].map((i) => columns[i].pos);
      const centre = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      const spread = Math.max(3, ...pts.map((p) => p.distanceTo(centre)));
      c.goalTarget.copy(centre).setY(0.8);
      c.goalDist = Math.min(30, spread * 2.6 + 12);
    } else if (picked !== null) {
      c.goalTarget.copy(columns[picked].pos).setY(1);
      c.goalDist = 18;
    } else {
      c.goalTarget.set(...HOME_TARGET);
      c.goalDist = HOME.dist;
    }
  }, [hotCols, picked, columns]);

  const labelEls = useRef<(HTMLDivElement | null)[]>([]);
  const sideEls = useRef<(HTMLDivElement | null)[]>([]);
  const sideAnchors = useMemo(() => [new THREE.Vector3(-11.5, 0, 6.2), new THREE.Vector3(11.5, 0, 6.2), new THREE.Vector3(0, 0, -9.0)], []);
  const hasBoth = columns.some((c) => c.side === "both");
  const info = picked !== null ? columns[picked] : hovered !== null ? columns[hovered] : null;
  const named = useMemo(() => {
    const out = new Set<number>();
    for (const side of ["vendor", "customer"] as const) {
      columns
        .map((c, i) => [c, i] as const)
        .filter(([c]) => c.side === side && !c.others)
        .sort((a, b) => b[0].volume - a[0].volume)
        .slice(0, NAMED_PER_SIDE)
        .forEach(([, i]) => out.add(i));
    }
    columns.forEach((c, i) => c.side !== "both" && (isCompany(c.side) || c.others || c.inCycle || c.related) && out.add(i));
    return out;
  }, [columns]);
  const stateOf = (i: number): "normal" | "hot" | "dim" => (hotCols ? (hotCols.has(i) ? "hot" : "dim") : "normal");
  const chip = dark ? "rgba(20,22,26,0.82)" : "rgba(255,255,255,0.9)";

  return (
    <div
      className="relative h-[66vh] w-full select-none overflow-hidden bg-paper"
      style={{ cursor: hovered !== null ? "pointer" : drag.current ? "grabbing" : "grab" }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const c = cam.current;
        c.theta = Math.max(-0.9, Math.min(0.9, c.theta - (e.clientX - drag.current.x) * 0.005));
        c.phi = Math.max(0.45, Math.min(1.35, c.phi - (e.clientY - drag.current.y) * 0.005));
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
      onWheel={(e) => {
        const c = cam.current;
        c.goalDist = Math.min(44, Math.max(10, c.goalDist * (1 + Math.sign(e.deltaY) * 0.08)));
      }}
    >
      <Canvas
        shadows
        camera={{ fov: 38, near: 0.1, far: 200, position: [0, 18, 24] }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        onPointerMissed={() => {
          setPicked(null);
          if (active !== null) onPickCycle(null);
        }}
      >
        <Rig cam={cam} />
        <ambientLight intensity={dark ? 0.75 : 1.1} />
        <directionalLight position={[8, 18, 10]} intensity={dark ? 1.6 : 1.9} castShadow shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-22} shadow-camera-right={22} shadow-camera-top={16} shadow-camera-bottom={-16} shadow-bias={-0.0004} />
        <Board pal={pal} />
        {columns.map((c, i) => (
          <ColumnMesh key={c.id} c={c} i={i} pal={pal} state={stateOf(i)} onHover={setHovered} onPick={setPicked} />
        ))}
        <Flows flows={flows} pal={pal} hot={hotFlows} reduced={reduced} />
        <Labels columns={columns} nodes={labelEls} extra={sideAnchors} extraEls={sideEls} />
      </Canvas>

      <div className="pointer-events-none absolute inset-0">
        {columns.map((c, i) => {
          const st = stateOf(i);
          const show = hotCols ? st === "hot" : named.has(i) || hovered === i || picked === i;
          return (
            <div
              key={c.id}
              ref={(el) => (labelEls.current[i] = el)}
              className="absolute left-0 top-0 whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-center leading-tight transition-opacity duration-300"
              style={{ background: chip, opacity: show ? 1 : 0 }}
            >
              <div className={`text-[11px] font-medium ${st === "hot" ? "text-fail" : isCompany(c.side) ? "text-brand" : "text-ink"}`}>
                {(() => {
                  const max = c.side === "both" && !c.others ? 16 : 22;
                  return c.label.length > max ? c.label.slice(0, max - 1) + "…" : c.label;
                })()}
              </div>
              {!isCompany(c.side) && <div className="text-[10px] tabular-nums text-ink-3">{compact(c.volume)}</div>}
            </div>
          );
        })}
        {["Vendors · supply", "Customers · sales", "Both buy and sell"].map((t, i) => (
          <div key={t} ref={(el) => (sideEls.current[i] = el)}
            className="absolute left-0 top-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-3"
            style={{ display: i === 2 && !hasBoth ? "none" : undefined }}>
            {t}
          </div>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-9 right-4 flex flex-wrap justify-end gap-4 text-[11px] text-ink-2">
        <span className="flex items-center gap-1.5"><i className="h-0.5 w-5 rounded bg-ink-3" />Goods (high arc)</span>
        <span className="flex items-center gap-1.5"><i className="h-0.5 w-5 rounded bg-pass" />Money (low arc)</span>
        <span>Column height is trade value</span>
      </div>

      {info && (
        <div className="pointer-events-none absolute bottom-4 left-4 w-72 rounded-md border border-line bg-paper p-3 text-xs shadow-lg">
          <div className="mb-1 text-sm font-semibold text-ink">{info.label}</div>
          <div className="mb-2 flex flex-wrap gap-2 text-ink-2">
            <span>{info.others ? "Summed column" : info.side === "both" ? "Buys and sells" : info.side}</span>
            {info.related && <span className="text-rp">Related party</span>}
            {info.inCycle && <span className="text-fail">In a trading cycle</span>}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
            <span className="text-ink-3">Goods to it</span><span className="text-right">₹ {money(info.goodsIn)}</span>
            <span className="text-ink-3">Goods from it</span><span className="text-right">₹ {money(info.goodsOut)}</span>
            <span className="text-ink-3">Money to it</span><span className="text-right">₹ {money(info.moneyIn)}</span>
            <span className="text-ink-3">Money from it</span><span className="text-right">₹ {money(info.moneyOut)}</span>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-4 right-4 text-[11px] text-ink-3">Drag to tilt · scroll to zoom · click a column</div>
    </div>
  );
}
