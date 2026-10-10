// The register as a city: one tower per party per month, as tall as the money
// it booked, with a red cap for the part the tests caught. Months run along
// the front, the largest parties stand in rows behind. Drag to turn it.

import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { prefersReducedMotion, token } from "../theme";
import { inr } from "../auditor/kit";
import { Profile, col, text, toDay, toNumber } from "./profile";

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Tower {
  month: string;
  party: string;
  x: number;
  z: number;
  value: number;
  caught: number;
}

function useTowers(p: Profile, date: number, party: number, amount: number, flagged: Set<number>) {
  return useMemo(() => {
    const days = col(p, date).map(toDay);
    const names = col(p, party).map(text);
    const amt = col(p, amount).map(toNumber);
    const byParty = new Map<string, number>();
    names.forEach((n, k) => n && byParty.set(n, (byParty.get(n) ?? 0) + Math.abs(amt[k] ?? 0)));
    const parties = [...byParty.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n]) => n);
    const months = [...new Set(days.filter(Boolean).map((d) => d!.slice(0, 7)))].sort().slice(-12);
    const cells = new Map<string, Tower>();
    days.forEach((d, k) => {
      if (!d) return;
      const mi = months.indexOf(d.slice(0, 7));
      const pi = parties.indexOf(names[k]);
      if (mi < 0 || pi < 0) return;
      const key = `${mi}:${pi}`;
      const t = cells.get(key) ?? { month: months[mi], party: parties[pi], x: mi - (months.length - 1) / 2, z: pi - (parties.length - 1) / 2, value: 0, caught: 0 };
      const v = Math.abs(amt[k] ?? 0);
      t.value += v;
      if (flagged.has(k)) t.caught += v;
      cells.set(key, t);
    });
    const towers = [...cells.values()];
    const max = Math.max(1, ...towers.map((t) => t.value));
    return { towers, max, months, parties };
  }, [p, date, party, amount, flagged]);
}

const HEIGHT = 5;

function Towers({ towers, max, hover, onHover, drag }: { towers: Tower[]; max: number; hover: number | null; onHover: (i: number | null) => void; drag: React.MutableRefObject<{ angle: number; auto: boolean }> }) {
  const body = useRef<THREE.InstancedMesh>(null);
  const cap = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);
  const grow = useRef(prefersReducedMotion() ? 1 : 0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colors = useMemo(() => ({ ink: new THREE.Color(token("brand")), hi: new THREE.Color(token("highlight")), fail: new THREE.Color(token("fail")) }), []);

  useFrame((_, dt) => {
    if (drag.current.auto && !prefersReducedMotion()) drag.current.angle += dt * 0.12;
    if (group.current) group.current.rotation.y += (drag.current.angle - group.current.rotation.y) * Math.min(1, dt * 6);
    if (grow.current < 1) grow.current = Math.min(1, grow.current + dt * 0.9);
    const g = 1 - (1 - grow.current) ** 3;
    towers.forEach((t, i) => {
      const h = Math.max(0.02, (t.value / max) * HEIGHT * g);
      const c = (t.caught / max) * HEIGHT * g;
      const w = hover === i ? 0.78 : 0.68;
      dummy.position.set(t.x * 1.0, (h - c) / 2, t.z * 1.0);
      dummy.scale.set(w, Math.max(0.001, h - c), w);
      dummy.updateMatrix();
      body.current?.setMatrixAt(i, dummy.matrix);
      body.current?.setColorAt(i, hover === i ? colors.hi : colors.ink);
      // A tower with nothing caught has no cap at all.
      dummy.position.set(t.x, h - c / 2, t.z);
      if (c > 0.002) dummy.scale.set(w + 0.02, c, w + 0.02);
      else dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      cap.current?.setMatrixAt(i, dummy.matrix);
    });
    if (body.current) {
      body.current.instanceMatrix.needsUpdate = true;
      if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
    }
    if (cap.current) cap.current.instanceMatrix.needsUpdate = true;
  });

  const pick = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onHover(e.instanceId ?? null);
  };

  return (
    <group ref={group}>
      <instancedMesh ref={body} args={[undefined, undefined, towers.length]} onPointerMove={pick} onPointerOut={() => onHover(null)}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.55} metalness={0.05} />
      </instancedMesh>
      <instancedMesh ref={cap} args={[undefined, undefined, towers.length]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={colors.fail} roughness={0.4} emissive={colors.fail} emissiveIntensity={0.25} />
      </instancedMesh>
      <gridHelper args={[16, 16, token("line"), token("line-soft")]} position={[0, 0.001, 0]} />
    </group>
  );
}

export default function City3D({ p, date, party, amount, flagged }: { p: Profile; date: number; party: number; amount: number; flagged: Set<number> }) {
  const { towers, max, months, parties } = useTowers(p, date, party, amount, flagged);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef({ angle: -0.5, auto: true });
  const from = useRef<number | null>(null);
  const [ok, setOk] = useState(true);
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      setOk(!!(c.getContext("webgl2") || c.getContext("webgl")));
    } catch {
      setOk(false);
    }
  }, []);
  const t = hover !== null ? towers[hover] : null;
  if (!ok) return <p className="text-[15px] text-ink-2">This browser cannot draw in 3D.</p>;
  return (
    <div className="relative">
      <div
        className="h-[420px] cursor-grab overflow-hidden rounded-xl bg-[radial-gradient(ellipse_at_center,var(--color-wash),var(--color-paper))] active:cursor-grabbing"
        onPointerDown={(e) => {
          from.current = e.clientX;
          drag.current.auto = false;
        }}
        onPointerMove={(e) => {
          if (from.current === null) return;
          drag.current.angle += (e.clientX - from.current) * 0.008;
          from.current = e.clientX;
        }}
        onPointerUp={() => (from.current = null)}
        onPointerLeave={() => (from.current = null)}
      >
        <Canvas dpr={[1, 2]} camera={{ fov: 36, near: 0.1, far: 200, position: [0, 10, 17.5] }} gl={{ antialias: true, alpha: true }} onCreated={({ camera }) => camera.lookAt(0, 1.4, 0)}>
          <ambientLight intensity={1.1} />
          <directionalLight position={[6, 12, 8]} intensity={1.6} />
          <directionalLight position={[-8, 6, -6]} intensity={0.5} />
          <Towers towers={towers} max={max} hover={hover} onHover={setHover} drag={drag} />
        </Canvas>
      </div>
      <div className="pointer-events-none absolute top-3 left-3 rounded-lg bg-paper/90 px-3 py-2 text-[13px] shadow-sm backdrop-blur">
        {t ? (
          <>
            <div className="font-bold text-ink">{t.party}</div>
            <div className="text-ink-2">
              {monthNames[+t.month.slice(5) - 1]} {t.month.slice(0, 4)}: <b className="text-ink">{inr(t.value)}</b>
            </div>
            {t.caught > 0 && <div className="font-semibold text-fail">{inr(t.caught)} in rows caught by a test</div>}
          </>
        ) : (
          <>
            <div className="font-bold text-ink">
              {parties.length} largest parties, {months.length} months
            </div>
            <div className="text-ink-2">Drag to turn. Point at a tower to read it. Red caps were caught by a test.</div>
          </>
        )}
      </div>
    </div>
  );
}
