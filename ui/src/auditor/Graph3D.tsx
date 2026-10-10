// The counterparty graph in three dimensions.
//
// The company sits at the centre as the core. Every counterparty is placed on
// an orbit: the more it trades with the company, the closer and larger it is.
// Customers sit above the equator, vendors below, mixed clusters on it. Goods
// and money travel along the arcs as particles, so the flow can be read at a
// glance. A selected trading cycle is lit as a closed loop and the camera
// turns to face it; everything else falls back.
//
// Layout is deterministic: the same graph always draws the same way.

import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { money } from "../api";
import { prefersReducedMotion, token } from "../theme";

export interface GraphData {
  nodes: { id: string; label: string; kind: string; related?: boolean }[];
  edges: { source: string; target: string; kind: string; value: number; count?: number }[];
  cycles: { finding_id?: string; path: string[]; value: number }[];
}

interface Placed {
  id: string;
  label: string;
  kind: string;
  related: boolean;
  pos: THREE.Vector3;
  size: number;
  volume: number;
  goodsIn: number;
  goodsOut: number;
  moneyIn: number;
  moneyOut: number;
  inCycle: boolean;
}

interface Arc {
  from: number;
  to: number;
  kind: string;
  value: number;
  curve: THREE.QuadraticBezierCurve3;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const isCompany = (k: string) => k === "company" || k === "entity";

function palette(dark: boolean) {
  return {
    company: new THREE.Color(token("brand")),
    customer: new THREE.Color(token("wait")),
    vendor: new THREE.Color(token("warm")),
    related: new THREE.Color(token("rp")),
    goods: new THREE.Color(dark ? token("ink-2") : token("ink-3")),
    money: new THREE.Color(token("pass")),
    cycle: new THREE.Color(token("fail")),
    line: new THREE.Color(token("line")),
    ink: token("ink"),
    dark,
  };
}

function layout(data: GraphData) {
  const volume = new Map<string, number>();
  const flows = new Map<string, { gi: number; go: number; mi: number; mo: number }>();
  const flow = (id: string) => {
    if (!flows.has(id)) flows.set(id, { gi: 0, go: 0, mi: 0, mo: 0 });
    return flows.get(id)!;
  };
  for (const e of data.edges) {
    volume.set(e.source, (volume.get(e.source) ?? 0) + e.value);
    volume.set(e.target, (volume.get(e.target) ?? 0) + e.value);
    if (e.kind === "money") {
      flow(e.source).mo += e.value;
      flow(e.target).mi += e.value;
    } else {
      flow(e.source).go += e.value;
      flow(e.target).gi += e.value;
    }
  }
  const cycleNodes = new Set(data.cycles.flatMap((c) => c.path));
  // Volumes span several orders of magnitude, so place by log volume between the smallest and largest partner.
  const logs = data.nodes.filter((n) => !isCompany(n.kind)).map((n) => Math.log10(1 + (volume.get(n.id) ?? 0)));
  const logMin = Math.min(...logs, 0);
  const logMax = Math.max(...logs, logMin + 1);
  const companies = data.nodes.filter((n) => isCompany(n.kind));
  const others = data.nodes
    .filter((n) => !isCompany(n.kind))
    .sort((a, b) => (volume.get(b.id) ?? 0) - (volume.get(a.id) ?? 0) || a.id.localeCompare(b.id));

  const placed: Placed[] = [];
  const base = (n: GraphData["nodes"][number], pos: THREE.Vector3, size: number): Placed => {
    const f = flows.get(n.id) ?? { gi: 0, go: 0, mi: 0, mo: 0 };
    return {
      id: n.id, label: n.label, kind: n.kind, related: !!n.related, pos, size, volume: volume.get(n.id) ?? 0,
      goodsIn: f.gi, goodsOut: f.go, moneyIn: f.mi, moneyOut: f.mo, inCycle: cycleNodes.has(n.id),
    };
  };
  companies.forEach((n, i) => {
    const pos = i === 0 ? new THREE.Vector3() : new THREE.Vector3(Math.cos(i * 2.1) * 3.2, (i % 2 ? 1 : -1) * 1.1, Math.sin(i * 2.1) * 3.2);
    placed.push(base(n, pos, i === 0 ? 1.15 : 0.7));
  });
  const counts = { up: 0, down: 0, mid: 0 };
  others.forEach((n) => {
    const v = volume.get(n.id) ?? 0;
    const w = (Math.log10(1 + v) - logMin) / (logMax - logMin); // 0..1
    const lane = n.kind === "customer" ? "up" : n.kind === "vendor" ? "down" : "mid";
    const i = counts[lane]++;
    const radius = 5.5 + Math.pow(1 - w, 0.8) * 15 + (i % 4) * 0.45;
    let y: number;
    if (lane === "up") y = 0.12 + 0.78 * ((i * 0.6180339) % 1);
    else if (lane === "down") y = -(0.12 + 0.78 * ((i * 0.6180339) % 1));
    else y = ((i * 0.6180339) % 1) * 0.36 - 0.18;
    const theta = i * GOLDEN + (lane === "down" ? 1.3 : lane === "mid" ? 2.4 : 0);
    const ring = Math.sqrt(1 - y * y);
    const pos = new THREE.Vector3(Math.cos(theta) * ring, y * 0.8, Math.sin(theta) * ring).multiplyScalar(radius);
    placed.push(base(n, pos, 0.09 + 0.26 * w * w));
  });
  const index = new Map(placed.map((p, i) => [p.id, i]));
  const arcs: Arc[] = [];
  for (const e of data.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const pa = placed[a].pos;
    const pb = placed[b].pos;
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const lift = pa.distanceTo(pb) * 0.22;
    const out = mid.lengthSq() > 0.01 ? mid.clone().normalize() : new THREE.Vector3(0, 1, 0);
    // Goods and money between the same pair bow to opposite sides, so both stay visible.
    const side = new THREE.Vector3().subVectors(pb, pa).cross(out).normalize().multiplyScalar(e.kind === "money" ? lift * 0.55 : -lift * 0.55);
    const ctrl = mid.add(out.multiplyScalar(lift)).add(side);
    arcs.push({ from: a, to: b, kind: e.kind, value: e.value, curve: new THREE.QuadraticBezierCurve3(pa.clone(), ctrl, pb.clone()) });
  }
  return { placed, index, arcs };
}

// Orbit camera written by hand: drag to turn, wheel to zoom, idle turns slowly.
interface CamState {
  theta: number;
  phi: number;
  dist: number;
  target: THREE.Vector3;
  goalTarget: THREE.Vector3;
  goalDist: number;
  dragging: boolean;
  lastInput: number;
}

function Rig({ cam, reduced }: { cam: React.MutableRefObject<CamState>; reduced: boolean }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    const c = cam.current;
    const idle = performance.now() / 1000 - c.lastInput > 2.5;
    if (!c.dragging && idle && !reduced) c.theta += dt * 0.06;
    const k = 1 - Math.pow(0.02, dt);
    c.target.lerp(c.goalTarget, k);
    c.dist += (c.goalDist - c.dist) * k;
    const sp = Math.sin(c.phi);
    camera.position.set(
      c.target.x + c.dist * sp * Math.sin(c.theta),
      c.target.y + c.dist * Math.cos(c.phi),
      c.target.z + c.dist * sp * Math.cos(c.theta),
    );
    camera.lookAt(c.target);
  });
  return null;
}

function Stars({ dark }: { dark: boolean }) {
  const geo = useMemo(() => {
    const n = 900;
    const pos = new Float32Array(n * 3);
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const r = 55 + rnd() * 45;
      const q = Math.sqrt(1 - u * u);
      pos.set([Math.cos(t) * q * r, u * r, Math.sin(t) * q * r], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  const ref = useRef<THREE.Points>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.004;
  });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial size={0.16} sizeAttenuation color={dark ? "#cfd6e4" : "#9aa0ab"} transparent opacity={dark ? 0.55 : 0.35} depthWrite={false} />
    </points>
  );
}

function OrbitGuides({ color }: { color: THREE.Color }) {
  const rings = [6, 10.5, 15, 20];
  return (
    <group rotation={[Math.PI / 2, 0, 0]}>
      {rings.map((r) => (
        <mesh key={r}>
          <ringGeometry args={[r - 0.012, r + 0.012, 160]} />
          <meshBasicMaterial color={color} transparent opacity={0.35} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

function Core({ pos, size, color, reduced }: { pos: THREE.Vector3; size: number; color: THREE.Color; reduced: boolean }) {
  const shell = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  useFrame((state, dt) => {
    if (reduced) return;
    if (shell.current) {
      shell.current.rotation.y += dt * 0.25;
      shell.current.rotation.x += dt * 0.11;
    }
    if (halo.current) {
      const s = 1 + Math.sin(state.clock.elapsedTime * 1.6) * 0.06;
      halo.current.scale.setScalar(s);
    }
  });
  const glow = color.clone().multiplyScalar(2.6);
  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[size * 0.62, 48, 48]} />
        <meshBasicMaterial color={glow} toneMapped={false} />
      </mesh>
      <mesh ref={shell}>
        <icosahedronGeometry args={[size, 1]} />
        <meshBasicMaterial color={color.clone().multiplyScalar(1.4)} wireframe transparent opacity={0.55} toneMapped={false} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[size * 1.55, 32, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.07} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Nodes({
  placed, pal, focus, hovered, onHover, onPick, intro,
}: {
  placed: Placed[];
  pal: ReturnType<typeof palette>;
  focus: Set<string> | null;
  hovered: number | null;
  onHover: (i: number | null) => void;
  onPick: (i: number) => void;
  intro: React.MutableRefObject<number>;
}) {
  const list = placed.filter((p) => !isCompany(p.kind));
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const offset = placed.length - list.length;

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    list.forEach((p, i) => {
      const c = (p.kind === "customer" ? pal.customer : p.kind === "vendor" ? pal.vendor : pal.related).clone();
      const dim = focus && !focus.has(p.id);
      if (focus && focus.has(p.id)) c.copy(pal.cycle).multiplyScalar(2.2);
      else if (dim) c.multiplyScalar(pal.dark ? 0.05 : 0.35).lerp(pal.line, pal.dark ? 0.15 : 0.6);
      else c.multiplyScalar(pal.dark ? 1.35 : 1);
      mesh.setColorAt(i, c);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [list, pal, focus]);

  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = intro.current;
    const e = 1 - Math.pow(1 - t, 3);
    list.forEach((p, i) => {
      const pulse = p.inCycle && !focus ? 1 + Math.sin(state.clock.elapsedTime * 2.4 + i) * 0.12 : 1;
      const grow = hovered === i + offset ? 1.6 : focus ? (focus.has(p.id) ? 1.7 : 0.7) : 1;
      dummy.position.copy(p.pos).multiplyScalar(e);
      dummy.scale.setScalar(p.size * pulse * grow * Math.max(0.05, e));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, list.length]}
      onPointerMove={(ev: ThreeEvent<PointerEvent>) => {
        ev.stopPropagation();
        if (ev.instanceId !== undefined) onHover(ev.instanceId + offset);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(ev: ThreeEvent<MouseEvent>) => {
        ev.stopPropagation();
        if (ev.instanceId !== undefined) onPick(ev.instanceId + offset);
      }}
    >
      <sphereGeometry args={[1, 32, 32]} />
      <meshStandardMaterial roughness={0.32} metalness={0.15} toneMapped={false} />
    </instancedMesh>
  );
}

function RelatedRings({ placed, color, intro, dimmed }: { placed: Placed[]; color: THREE.Color; intro: React.MutableRefObject<number>; dimmed: boolean }) {
  const list = placed.filter((p) => p.related && !isCompany(p.kind));
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const e = 1 - Math.pow(1 - intro.current, 3);
    list.forEach((p, i) => {
      dummy.position.copy(p.pos).multiplyScalar(e);
      dummy.rotation.set(state.clock.elapsedTime * 0.7 + i, state.clock.elapsedTime * 0.4, 0);
      dummy.scale.setScalar((p.size + 0.12) * 1.6 * Math.max(0.05, e));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  if (!list.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, list.length]} raycast={() => null}>
      <torusGeometry args={[1, 0.035, 8, 64]} />
      <meshBasicMaterial color={color.clone().multiplyScalar(dimmed ? 0.12 : 1.8)} toneMapped={false} transparent opacity={dimmed ? 0.5 : 1} />
    </instancedMesh>
  );
}

function Arcs({ arcs, pal, focusEdges, intro }: { arcs: Arc[]; pal: ReturnType<typeof palette>; focusEdges: Set<number> | null; intro: React.MutableRefObject<number> }) {
  const SEG = 28;
  const geo = useMemo(() => {
    const pos = new Float32Array(arcs.length * SEG * 2 * 3);
    const col = new Float32Array(arcs.length * SEG * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [arcs]);

  useEffect(() => {
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    arcs.forEach((a, i) => {
      const base = (a.kind === "money" ? pal.money : pal.goods).clone();
      const strength = focusEdges ? (focusEdges.has(i) ? 0 : pal.dark ? 0.045 : 0.12) : pal.dark ? 0.32 : 0.45;
      for (let s = 0; s < SEG * 2; s++) {
        const fade = 0.55 + 0.45 * Math.sin((Math.floor(s / 2) / SEG) * Math.PI);
        const c = pal.dark ? base.clone().multiplyScalar(strength * fade) : base.clone().lerp(new THREE.Color("#ffffff"), 1 - strength * fade);
        col.setXYZ(i * SEG * 2 + s, c.r, c.g, c.b);
      }
    });
    col.needsUpdate = true;
  }, [arcs, geo, pal, focusEdges]);

  const settled = useRef(false);
  useEffect(() => {
    settled.current = false;
  }, [arcs]);
  useFrame(() => {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const e = 1 - Math.pow(1 - intro.current, 3);
    if (e >= 1 && settled.current) return;
    const p = new THREE.Vector3();
    arcs.forEach((a, i) => {
      for (let s = 0; s < SEG; s++) {
        a.curve.getPoint(s / SEG, p).multiplyScalar(e);
        pos.setXYZ(i * SEG * 2 + s * 2, p.x, p.y, p.z);
        a.curve.getPoint((s + 1) / SEG, p).multiplyScalar(e);
        pos.setXYZ(i * SEG * 2 + s * 2 + 1, p.x, p.y, p.z);
      }
    });
    pos.needsUpdate = true;
    if (e >= 1) settled.current = true;
  });

  return (
    <lineSegments geometry={geo} raycast={() => null}>
      <lineBasicMaterial vertexColors transparent opacity={1} blending={pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending} depthWrite={false} />
    </lineSegments>
  );
}

// Particles travelling along the arcs. Their number on an arc grows with the value it carries.
function Flow({ arcs, pal, focusEdges, reduced, intro }: { arcs: Arc[]; pal: ReturnType<typeof palette>; focusEdges: Set<number> | null; reduced: boolean; intro: React.MutableRefObject<number> }) {
  const particles = useMemo(() => {
    const maxV = Math.max(1, ...arcs.map((a) => a.value));
    const out: { arc: number; t: number; speed: number }[] = [];
    arcs.forEach((a, i) => {
      const n = 1 + Math.round(3 * Math.log10(1 + (a.value / maxV) * 9));
      for (let k = 0; k < n; k++) out.push({ arc: i, t: k / n + (i * 0.137) % 1, speed: 0.07 + ((i * 7 + k * 3) % 10) * 0.006 });
    });
    return out.slice(0, 2400);
  }, [arcs]);
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const p = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    particles.forEach((q, i) => {
      const a = arcs[q.arc];
      const lit = focusEdges?.has(q.arc);
      const c = lit ? pal.cycle.clone().multiplyScalar(3) : (a.kind === "money" ? pal.money : pal.goods).clone().multiplyScalar(focusEdges ? 0.25 : pal.dark ? 1.6 : 1);
      mesh.setColorAt(i, c);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [particles, arcs, pal, focusEdges]);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh || intro.current < 1) return;
    const speedUp = reduced ? 0.25 : 1;
    particles.forEach((q, i) => {
      const lit = focusEdges?.has(q.arc);
      q.t = (q.t + dt * q.speed * speedUp * (lit ? 2.6 : 1)) % 1;
      arcs[q.arc].curve.getPoint(q.t, p);
      dummy.position.copy(p);
      dummy.scale.setScalar(lit ? 0.13 : focusEdges ? 0.04 : 0.065);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, particles.length]} raycast={() => null}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

// The selected cycle as glowing tubes, so the loop reads as one closed shape.
function CycleLoop({ arcs, edges, color }: { arcs: Arc[]; edges: number[]; color: THREE.Color }) {
  const tubes = useMemo(() => edges.map((i) => new THREE.TubeGeometry(arcs[i].curve, 64, 0.085, 10, false)), [arcs, edges]);
  const ref = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((state) => {
    if (ref.current) ref.current.opacity = 0.75 + Math.sin(state.clock.elapsedTime * 3) * 0.2;
  });
  useEffect(() => () => tubes.forEach((t) => t.dispose()), [tubes]);
  return (
    <group>
      {tubes.map((g, i) => (
        <mesh key={i} geometry={g} raycast={() => null}>
          <meshBasicMaterial ref={i === 0 ? ref : undefined} color={color.clone().multiplyScalar(2.4)} transparent opacity={0.9} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

// Labels are DOM elements placed every frame from the 3D positions, so text stays crisp.
function LabelProjector({ placed, ids, nodes }: { placed: Placed[]; ids: number[]; nodes: React.MutableRefObject<(HTMLDivElement | null)[]> }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    ids.forEach((pi, k) => {
      const el = nodes.current[k];
      if (!el) return;
      const p = placed[pi];
      v.copy(p.pos);
      v.y += p.size + 0.35;
      v.project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      el.style.opacity = visible ? "1" : "0";
      el.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px)`;
    });
  });
  return null;
}

export default function Graph3D({ data, active, onPickCycle }: { data: GraphData; active: number | null; onPickCycle: (i: number | null) => void }) {
  const dark = document.documentElement.dataset.theme !== "light";
  const pal = useMemo(() => palette(dark), [dark]);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const { placed, index, arcs } = useMemo(() => layout(data), [data]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const intro = useRef(reduced ? 1 : 0);
  const cam = useRef<CamState>({
    theta: 0.6, phi: 1.12, dist: 30, target: new THREE.Vector3(), goalTarget: new THREE.Vector3(), goalDist: 30, dragging: false, lastInput: -10,
  });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const cycle = active !== null ? data.cycles[active] : null;
  const focus = useMemo(() => (cycle ? new Set(cycle.path) : null), [cycle]);
  const cycleEdges = useMemo(() => {
    if (!cycle) return [];
    const out: number[] = [];
    for (let i = 0; i < cycle.path.length; i++) {
      const a = index.get(cycle.path[i]);
      const b = index.get(cycle.path[(i + 1) % cycle.path.length]);
      const found = arcs.findIndex((x) => x.from === a && x.to === b);
      if (found >= 0) out.push(found);
    }
    return out;
  }, [cycle, arcs, index]);
  const focusEdges = useMemo(() => (cycle ? new Set(cycleEdges) : null), [cycle, cycleEdges]);

  // Fly to the selected cycle, or back to the whole graph.
  useEffect(() => {
    const c = cam.current;
    if (cycle) {
      const pts = cycle.path.map((id) => placed[index.get(id) ?? 0].pos);
      const centre = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, pts.length));
      const spread = Math.max(4, ...pts.map((p) => p.distanceTo(centre)));
      c.goalTarget.copy(centre);
      c.goalDist = spread * 3.6 + 13;
    } else if (picked !== null) {
      c.goalTarget.copy(placed[picked].pos);
      c.goalDist = 12;
    } else {
      c.goalTarget.set(0, 0, 0);
      c.goalDist = 30;
    }
  }, [cycle, picked, placed, index]);

  // Which nodes carry a label: the company, the largest partners, the cycle and the hovered node.
  const labelIds = useMemo(() => {
    const ids = new Set<number>();
    placed.forEach((p, i) => isCompany(p.kind) && ids.add(i));
    if (focus) placed.forEach((p, i) => focus.has(p.id) && ids.add(i));
    else
      placed
        .map((p, i) => [p.volume, i] as const)
        .filter(([, i]) => !isCompany(placed[i].kind))
        .sort((a, b) => b[0] - a[0])
        .slice(0, 6)
        .forEach(([, i]) => ids.add(i));
    if (hovered !== null) ids.add(hovered);
    if (picked !== null) ids.add(picked);
    return [...ids];
  }, [placed, focus, hovered, picked]);
  const labelEls = useRef<(HTMLDivElement | null)[]>([]);

  const info = picked !== null ? placed[picked] : hovered !== null ? placed[hovered] : null;
  const totals = useMemo(() => ({
    goods: data.edges.filter((e) => e.kind !== "money").reduce((s, e) => s + e.value, 0),
    money: data.edges.filter((e) => e.kind === "money").reduce((s, e) => s + e.value, 0),
  }), [data]);

  return (
    <div
      className="relative h-[66vh] w-full select-none overflow-hidden"
      style={{ background: dark ? "radial-gradient(ellipse at 50% 40%, #1d2230 0%, #101217 55%, #0b0c10 100%)" : "radial-gradient(ellipse at 50% 40%, #ffffff 0%, #f4f2ec 60%, #ebe8df 100%)", cursor: hovered !== null ? "pointer" : drag.current ? "grabbing" : "grab" }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY };
        cam.current.dragging = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const c = cam.current;
        c.theta -= (e.clientX - drag.current.x) * 0.006;
        c.phi = Math.min(2.9, Math.max(0.25, c.phi - (e.clientY - drag.current.y) * 0.006));
        drag.current = { x: e.clientX, y: e.clientY };
        c.lastInput = performance.now() / 1000;
      }}
      onPointerUp={() => {
        drag.current = null;
        cam.current.dragging = false;
        cam.current.lastInput = performance.now() / 1000;
      }}
      onWheel={(e) => {
        const c = cam.current;
        c.goalDist = Math.min(70, Math.max(6, c.goalDist * (1 + Math.sign(e.deltaY) * 0.1)));
        c.lastInput = performance.now() / 1000;
      }}
    >
      <Canvas
        camera={{ fov: 42, near: 0.1, far: 400, position: [0, 12, 34] }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onPointerMissed={() => {
          setPicked(null);
          if (active !== null) onPickCycle(null);
        }}
      >
        <IntroClock intro={intro} />
        <ambientLight intensity={dark ? 0.55 : 0.9} />
        <pointLight position={[0, 0, 0]} intensity={dark ? 220 : 120} distance={60} decay={1.6} color={pal.company} />
        <directionalLight position={[12, 20, 14]} intensity={dark ? 1.1 : 1.6} />
        <Rig cam={cam} reduced={reduced} />
        <Stars dark={dark} />
        <OrbitGuides color={pal.line} />
        {placed.filter((p) => isCompany(p.kind)).map((p) => (
          <Core key={p.id} pos={p.pos} size={p.size} color={pal.company} reduced={reduced} />
        ))}
        <Arcs arcs={arcs} pal={pal} focusEdges={focusEdges} intro={intro} />
        <Flow arcs={arcs} pal={pal} focusEdges={focusEdges} reduced={reduced} intro={intro} />
        {cycle && <CycleLoop arcs={arcs} edges={cycleEdges} color={pal.cycle} />}
        <Nodes placed={placed} pal={pal} focus={focus} hovered={hovered} onHover={setHovered} onPick={setPicked} intro={intro} />
        <RelatedRings placed={placed} color={pal.related} intro={intro} dimmed={!!focus} />
        <LabelProjector placed={placed} ids={labelIds} nodes={labelEls} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={dark ? 0.9 : 0.35} luminanceThreshold={1.0} luminanceSmoothing={0.25} />
          <Vignette eskil={false} offset={0.25} darkness={dark ? 0.55 : 0.2} />
        </EffectComposer>
      </Canvas>

      <div className="pointer-events-none absolute inset-0">
        {labelIds.map((pi, k) => {
          const p = placed[pi];
          const hot = focus?.has(p.id);
          return (
            <div
              key={p.id}
              ref={(el) => (labelEls.current[k] = el)}
              className="absolute left-0 top-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium transition-opacity"
              style={{ background: dark ? "rgba(16,18,23,0.72)" : "rgba(255,255,255,0.85)", color: hot ? token("fail") : isCompany(p.kind) ? token("brand") : pal.ink, backdropFilter: "blur(4px)", border: `1px solid ${token("line")}` }}
            >
              {p.label.length > 34 ? p.label.slice(0, 33) + "…" : p.label}
            </div>
          );
        })}
      </div>

      {/* Totals, top left */}
      <div className="pointer-events-none absolute left-4 top-4 flex gap-5 text-xs">
        {[
          ["Counterparties", String(placed.filter((p) => !isCompany(p.kind)).length)],
          ["Goods", `₹ ${money(totals.goods)}`],
          ["Money", `₹ ${money(totals.money)}`],
          ["Cycles", String(data.cycles.length)],
        ].map(([k, v]) => (
          <div key={k}>
            <div className="text-ink-3 uppercase tracking-wider text-[10px]">{k}</div>
            <div className={k === "Cycles" && data.cycles.length ? "font-semibold tabular-nums text-fail" : "font-semibold tabular-nums text-ink"}>{v}</div>
          </div>
        ))}
      </div>

      {/* Hovered or picked node */}
      {info && (
        <div className="pointer-events-none absolute bottom-4 left-4 w-72 rounded-md border border-line p-3 text-xs shadow-lg" style={{ background: dark ? "rgba(20,22,26,0.88)" : "rgba(255,255,255,0.92)", backdropFilter: "blur(6px)" }}>
          <div className="mb-1 text-sm font-semibold text-ink">{info.label}</div>
          <div className="mb-2 flex gap-2 text-ink-2">
            <span className="capitalize">{info.kind}</span>
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

      <div className="pointer-events-none absolute bottom-4 right-4 text-[11px] text-ink-3">Drag to turn · scroll to zoom · click a node</div>
    </div>
  );
}

function IntroClock({ intro }: { intro: React.MutableRefObject<number> }) {
  useFrame((_, dt) => {
    if (intro.current < 1) intro.current = Math.min(1, intro.current + dt / 1.6);
  });
  return null;
}
