// The one 3D scene behind the story page. It never changes to another scene:
// the camera travels through it as the visitor scrolls, and what it holds
// changes state.
//
// Geography, front to back:
//   the ledger     a gold chain of blocks, nearest the visitor
//   the documents  a row of stacks, one stack per sale, one plate per document
//   the register   a field of columns, one per invoice, a year across
//
// Everything repeated is an instanced mesh. Colours come from the design
// tokens, so a colour means here what it means in the tables.

import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Field, documentNames, trails } from "./data";
import { during, setHover, smoothstep, story } from "./store";

export interface Palette {
  background: string;
  grid: string;
  ice: string;
  gold: string;
  teal: string;
  vermilion: string;
  violet: string;
  dim: number; // how far unlit columns fall back
  glow: number; // how hard gold is pushed for the bloom
}

// The ledger runs in front of the register. The documents are laid out in
// front of the ledger when their chapter arrives.
const CHAIN_Z = 8.6;
const STACK_Z = 12.4;
const CHAIN_COUNT = 22;
const CHAIN_GAP = 1.18;
const GATES = [-17.4, -16.5, -15.6, -14.7];

// One camera position for each chapter. `side` is where the text sits; the
// view is shifted so the subject lands on the other half of the screen.
// `up` raises the subject on screen, for the chapter whose panel fills the
// lower half.
const shots: { pos: [number, number, number]; look: [number, number, number]; side: -1 | 0 | 1; up?: number }[] = [
  { pos: [-2, 12.5, 28], look: [0.5, 3.4, 2.5], side: -1 }, // 0 the register
  { pos: [19, 5.2, 10.5], look: [10.5, 1.6, -0.5], side: 1 }, // 1 period end
  { pos: [1.5, 3.7, 19.6], look: [0, 0.9, STACK_Z], side: -1 }, // 2 documents
  { pos: [9, 3.6, 17.5], look: [1.5, 0.3, CHAIN_Z], side: 1 }, // 3 ledger
  { pos: [-12.5, 3.1, 15.7], look: [-15.6, 0.9, CHAIN_Z], side: -1 }, // 4 identity
  { pos: [0, 21, 7.5], look: [0, 0, -0.6], side: 1 }, // 5 detection, from above
  { pos: [-9, 8.2, 13.5], look: [-0.5, 1.4, -0.5], side: -1 }, // 6 samples
  { pos: [-1.5, 4.4, 19], look: [-1.5, 0.4, CHAIN_Z], side: 1, up: 0.24 }, // 7 proof
  { pos: [0, 12.5, 27], look: [0, 0.6, 3], side: 0 }, // 8 close
];

function Rig({ compact }: { compact: boolean }) {
  const { camera, size } = useThree();
  const look = useRef(new THREE.Vector3(...shots[0].look));
  const shift = useRef(0);
  const raise = useRef(0);
  const scratch = useMemo(() => ({ pos: new THREE.Vector3(), look: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3() }), []);

  useFrame((_, dt) => {
    const p = Math.min(shots.length - 1, Math.max(0, story.p));
    const i = Math.min(shots.length - 2, Math.floor(p));
    const f = smoothstep(0, 1, p - i);
    const from = shots[i];
    const to = shots[i + 1];
    scratch.pos.copy(scratch.a.set(...from.pos)).lerp(scratch.b.set(...to.pos), f);
    scratch.look.copy(scratch.a.set(...from.look)).lerp(scratch.b.set(...to.look), f);
    // On a narrow screen the text sits above the scene, so pull back instead.
    if (compact) scratch.pos.multiplyScalar(1.25);

    const ease = 1 - Math.exp(-dt * 3.4);
    camera.position.lerp(scratch.pos, ease);
    look.current.lerp(scratch.look, ease);
    camera.lookAt(look.current);

    const wanted = compact ? 0 : (from.side + (to.side - from.side) * f) * 0.2;
    shift.current += (wanted - shift.current) * ease;
    const up = (from.up ?? 0) + ((to.up ?? 0) - (from.up ?? 0)) * f;
    raise.current += (up - raise.current) * ease;
    (camera as THREE.PerspectiveCamera).setViewOffset(size.width, size.height, shift.current * size.width, (compact ? -0.12 : raise.current) * size.height, size.width, size.height);
  });
  return null;
}

function Atmosphere({ palette }: { palette: Palette }) {
  const { scene } = useThree();
  const base = useMemo(() => new THREE.Color(palette.background), [palette.background]);
  const heat = useMemo(() => new THREE.Color(palette.vermilion).multiplyScalar(0.045).add(new THREE.Color(palette.background).multiplyScalar(0.97)), [palette]);
  useEffect(() => {
    scene.fog = new THREE.Fog(palette.background, 24, 58);
    scene.background = new THREE.Color(palette.background);
  }, [scene, palette.background]);
  useFrame(() => {
    // In the second chapter the air thickens and warms: the period end.
    const w = during(story.p, 1, 1);
    const fog = scene.fog as THREE.Fog;
    fog.color.copy(base).lerp(heat, w);
    fog.near = 24 - w * 9;
    fog.far = 58 - w * 16;
    (scene.background as THREE.Color).copy(fog.color);
  });
  return null;
}

function Register({ field, palette, compact }: { field: Field; palette: Palette; compact: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const spacing = compact ? 0.62 : 0.5;
  const geometry = useMemo(() => new THREE.BoxGeometry(0.17, 1, 0.17).translate(0, 0.5, 0), []);
  const c = useMemo(
    () => ({
      ice: new THREE.Color(palette.ice),
      gold: new THREE.Color(palette.gold).multiplyScalar(palette.glow),
      vermilion: new THREE.Color(palette.vermilion).multiplyScalar(1.15),
      violet: new THREE.Color(palette.violet),
      out: new THREE.Color(),
    }),
    [palette],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = field.sales.length;

  useFrame((state) => {
    const m = mesh.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    const p = story.p;
    const surge = during(p, 1, 1);
    const reveal = Math.max(during(p, 5, 6), smoothstep(7.6, 8, p) * 0.9); // exceptions and related parties shown
    const chosen = Math.max(during(p, 6, 6), smoothstep(7.6, 8, p)); // samples shown
    const recede = Math.max(during(p, 2, 4), during(p, 7, 7)) * 0.55; // the register falls back while the eye is elsewhere

    for (let i = 0; i < count; i++) {
      const s = field.sales[i];
      const x = (s.week - (field.weeks - 1) / 2) * spacing;
      const z = (s.customer - (field.customers - 1) / 2) * spacing;
      const breath = Math.sin(t * 0.6 + s.week * 0.31 + s.customer * 0.47) * 0.035;
      const jitter = surge * s.periodEnd * (0.55 + 0.45 * Math.sin(t * 5.1 + i * 1.7));
      const h = 0.18 + s.height * 3.1 * (1 + jitter * 1.9) + breath;
      const lift = s.sampled ? chosen * 0.5 : 0;
      dummy.position.set(x, lift, z);
      dummy.scale.set(1 + (s.sampled ? chosen * 0.5 : 0), Math.max(0.05, h), 1 + (s.sampled ? chosen * 0.5 : 0));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);

      c.out.copy(c.ice);
      if (s.relatedParty) c.out.lerp(c.violet, reveal);
      const hot = Math.max(s.flag ? reveal : 0, surge * s.periodEnd * 0.85);
      c.out.lerp(c.vermilion, hot);
      if (s.sampled) c.out.lerp(c.gold, chosen);
      // Columns that are not the subject fall back, so the eye finds the few.
      const lit = s.sampled ? chosen : s.flag || s.relatedParty ? reveal : 0;
      const fall = Math.max(recede, Math.max(reveal, chosen) * (1 - lit) * (1 - palette.dim));
      c.out.multiplyScalar(1 - fall * 0.72);
      m.setColorAt(i, c.out);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  // Hovering a column names the invoice, while the detection and sampling
  // chapters are in view.
  const move = (e: ThreeEvent<PointerEvent>) => {
    if (story.p < 4.6 || story.p > 6.6 || e.instanceId === undefined) return;
    e.stopPropagation();
    setHover({ sale: field.sales[e.instanceId], x: e.clientX, y: e.clientY });
  };

  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, count]} onPointerMove={move} onPointerOut={() => setHover(null)} frustumCulled={false}>
      <meshLambertMaterial toneMapped={false} />
    </instancedMesh>
  );
}

// A row of sales, each unpacked into the documents that prove it. A plate
// that is missing is drawn as an empty vermilion frame.
function Documents({ palette }: { palette: Palette }) {
  const present = useRef<THREE.InstancedMesh>(null);
  const absent = useRef<THREE.InstancedMesh>(null);
  const plate = useMemo(() => new THREE.BoxGeometry(0.92, 0.085, 0.62), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const slots = useMemo(() => {
    const have: { x: number; k: number }[] = [];
    const lack: { x: number; k: number }[] = [];
    trails.forEach((trail, i) => {
      const x = (i - (trails.length - 1) / 2) * 1.32;
      documentNames.forEach((_, k) => (trail.missing.includes(k) ? lack : have).push({ x, k }));
    });
    return { have, lack };
  }, []);

  useFrame((state) => {
    const w = during(story.p, 2, 2);
    const t = state.clock.elapsedTime;
    const place = (mesh: THREE.InstancedMesh | null, list: { x: number; k: number }[], pulse: boolean) => {
      if (!mesh) return;
      list.forEach((slot, i) => {
        // Plates rise into place one after another as the chapter arrives.
        const arrive = smoothstep(slot.k * 0.07, slot.k * 0.07 + 0.45, w);
        const s = pulse ? arrive * (0.96 + 0.04 * Math.sin(t * 3 + slot.x)) : arrive;
        dummy.position.set(slot.x, 0.1 + slot.k * 0.21 * arrive, STACK_Z);
        dummy.scale.setScalar(Math.max(0.0001, s));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    place(present.current, slots.have, false);
    place(absent.current, slots.lack, true);
  });

  return (
    <>
      <instancedMesh ref={present} args={[plate, undefined, slots.have.length]} frustumCulled={false}>
        <meshLambertMaterial color={palette.ice} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={absent} args={[plate, undefined, slots.lack.length]} frustumCulled={false}>
        <meshBasicMaterial color={palette.vermilion} wireframe toneMapped={false} />
      </instancedMesh>
    </>
  );
}

// The ledger: a chain of gold blocks. A light runs along it as each hash is
// carried into the next block. In the proof, the visitor breaks it.
function Ledger({ palette }: { palette: Palette }) {
  const blocks = useRef<THREE.InstancedMesh>(null);
  const links = useRef<THREE.InstancedMesh>(null);
  const block = useMemo(() => new THREE.BoxGeometry(0.78, 0.56, 0.56), []);
  const link = useMemo(() => new THREE.BoxGeometry(1, 0.07, 0.07), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => ({ gold: new THREE.Color(palette.gold), vermilion: new THREE.Color(palette.vermilion), out: new THREE.Color() }), [palette]);
  const tilt = useRef<number[]>(Array(CHAIN_COUNT).fill(0));

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const focus = Math.max(during(story.p, 3, 4), during(story.p, 7, 7));
    const run = (t * 3.2) % (CHAIN_COUNT + 6);
    const ease = 1 - Math.exp(-dt * 8);
    for (let i = 0; i < CHAIN_COUNT; i++) {
      const x = (i - (CHAIN_COUNT - 1) / 2) * CHAIN_GAP;
      const broken = story.brokenAt >= 0 && i >= story.brokenAt;
      const struck = story.brokenAt === i;
      tilt.current[i] += ((struck ? 1 : 0) - tilt.current[i]) * ease;
      dummy.position.set(x, 0.42 + tilt.current[i] * 0.3, CHAIN_Z);
      dummy.rotation.set(0, 0, tilt.current[i] * 0.42);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      blocks.current?.setMatrixAt(i, dummy.matrix);
      const carry = Math.exp(-((i - run) ** 2) / 1.6);
      c.out.copy(broken ? c.vermilion : c.gold).multiplyScalar(broken ? 1.25 : (0.75 + focus * 0.35 + carry * 0.9) * palette.glow);
      blocks.current?.setColorAt(i, c.out);

      if (i < CHAIN_COUNT - 1) {
        const cut = story.brokenAt >= 0 && i + 1 >= story.brokenAt;
        dummy.position.set(x + CHAIN_GAP / 2 - (cut ? 0.08 : 0), 0.42, CHAIN_Z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(cut ? 0.12 : CHAIN_GAP - 0.78, 1, 1);
        dummy.updateMatrix();
        links.current?.setMatrixAt(i, dummy.matrix);
        c.out.copy(cut ? c.vermilion : c.gold).multiplyScalar(cut ? 1.2 : (0.6 + carry * 0.8) * palette.glow);
        links.current?.setColorAt(i, c.out);
      }
    }
    for (const m of [blocks.current, links.current]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh ref={blocks} args={[block, undefined, CHAIN_COUNT]} frustumCulled={false}>
        <meshLambertMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={links} args={[link, undefined, CHAIN_COUNT - 1]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}

// Four frames stand between a caller and the ledger: the four layers that
// enforce an identity's permissions. A client's write passes through all of
// them. An auditor's stops at the first.
function Gates({ palette }: { palette: Palette }) {
  const group = useRef<THREE.Group>(null);
  const client = useRef<THREE.InstancedMesh>(null);
  const auditor = useRef<THREE.Mesh>(null);
  const frame = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(0.04, 2.1, 2.5)), []);
  const dot = useMemo(() => new THREE.SphereGeometry(0.11, 16, 12), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const materials = useRef<THREE.LineBasicMaterial[]>([]);
  const start = -22;
  const chainHead = -((CHAIN_COUNT - 1) / 2) * CHAIN_GAP;

  useFrame((state) => {
    const w = during(story.p, 4, 4);
    const t = state.clock.elapsedTime;
    if (group.current) group.current.visible = w > 0.01;
    materials.current.forEach((m, i) => {
      // The first frame flashes when it stops the auditor's write.
      const hit = i === 0 ? Math.max(0, 1 - Math.abs(((t * 0.42) % 1) - 0.62) * 9) : 0;
      m.opacity = w * (0.5 + hit * 0.5);
      m.color.set(hit > 0.2 ? palette.vermilion : palette.ice);
    });
    for (let i = 0; i < 4; i++) {
      const u = (t * 0.3 + i / 4) % 1;
      dummy.position.set(start + (chainHead - start) * u, 0.42, CHAIN_Z + 0.55);
      dummy.scale.setScalar(w * (u > 0.97 ? (1 - u) / 0.03 : 1));
      dummy.updateMatrix();
      client.current?.setMatrixAt(i, dummy.matrix);
    }
    if (client.current) client.current.instanceMatrix.needsUpdate = true;
    if (auditor.current) {
      const u = (t * 0.42) % 1;
      const travel = Math.min(u / 0.6, 1);
      auditor.current.position.set(start + (GATES[0] - 0.12 - start) * travel, 0.42, CHAIN_Z - 0.55);
      auditor.current.scale.setScalar(w * (u > 0.6 ? Math.max(0, 1 - (u - 0.6) / 0.25) : 1));
    }
  });

  return (
    <group ref={group}>
      {GATES.map((x, i) => (
        <lineSegments key={x} geometry={frame} position={[x, 1.05, CHAIN_Z]}>
          <lineBasicMaterial ref={(m) => m && (materials.current[i] = m)} color={palette.ice} transparent toneMapped={false} />
        </lineSegments>
      ))}
      <instancedMesh ref={client} args={[dot, undefined, 4]} frustumCulled={false}>
        <meshBasicMaterial color={palette.ice} toneMapped={false} />
      </instancedMesh>
      <mesh ref={auditor} geometry={dot}>
        <meshBasicMaterial color={palette.vermilion} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Ground({ palette }: { palette: Palette }) {
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(120, 120, palette.grid, palette.grid);
    const m = g.material as THREE.LineBasicMaterial;
    m.transparent = true;
    m.opacity = 0.55;
    m.toneMapped = false;
    return g;
  }, [palette.grid]);
  return <primitive object={grid} position={[0, -0.01, 0]} />;
}

export default function Scene({ field, palette, compact }: { field: Field; palette: Palette; compact: boolean }) {
  // Pointer events are read from the page root, because the page's text sits
  // above the canvas.
  const source = useMemo(() => document.getElementById("root")!, []);
  return (
    <Canvas
      camera={{ position: shots[0].pos, fov: 38, near: 0.1, far: 140 }}
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      eventSource={source}
      eventPrefix="client"
      flat
    >
      <Atmosphere palette={palette} />
      <Rig compact={compact} />
      <hemisphereLight args={["#ffffff", palette.background, 2.2]} />
      <directionalLight position={[8, 14, 10]} intensity={1.5} />
      <Ground palette={palette} />
      <Register field={field} palette={palette} compact={compact} />
      <Documents palette={palette} />
      <Ledger palette={palette} />
      <Gates palette={palette} />
      {!compact && palette.glow > 1 && (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.55} luminanceThreshold={1.02} luminanceSmoothing={0.2} />
          <Vignette eskil={false} offset={0.22} darkness={0.62} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
