// The landing's 3D story. A year of sales is drawn as notes, and the same
// notes re-form for each chapter: a cloud, the register wall, the thirty
// samples lifting out, the fakes glowing under the UV lamp, a ring of
// companies passing money round, the hash chain, and the signed stacks.
// Scroll position chooses the chapter; the pointer tilts the scene.

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { prefersReducedMotion, token } from "../theme";

export interface StoryState {
  // Chapter position: 0 at the hero, 1 at the register, and so on, fractional between.
  p: number;
  px: number;
  py: number;
}

const N = 1200;
const CH = 8;

// Deterministic choice of samples and fakes, so the picture is the same every visit.
const samples = new Set(Array.from({ length: 30 }, (_, i) => (i * 397 + 211) % N));
const fakes = new Set(Array.from({ length: 64 }, (_, i) => (i * 173 + 59) % N));

function rand(i: number, k: number) {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

interface Formation {
  pos: Float32Array;
  rot: Float32Array;
  scale: Float32Array;
  // 0 plain, 1 dim, 2 sample, 3 fake, 4 under UV but genuine, 5 chain light
  tone: Uint8Array;
}

function formations(): Formation[] {
  const make = (): Formation => ({ pos: new Float32Array(N * 3), rot: new Float32Array(N * 3), scale: new Float32Array(N), tone: new Uint8Array(N) });
  const out: Formation[] = [];

  // 0 The cloud: a slow galaxy of sales behind the hero note.
  const cloud = make();
  for (let i = 0; i < N; i++) {
    const u = rand(i, 1) * Math.PI * 2;
    const v = Math.acos(2 * rand(i, 2) - 1);
    const r = 7 + rand(i, 3) * 7;
    cloud.pos.set([r * Math.sin(v) * Math.cos(u) + 3, r * Math.cos(v) * 0.5, r * Math.sin(v) * Math.sin(u) - 9], i * 3);
    cloud.rot.set([rand(i, 4) * 6, rand(i, 5) * 6, rand(i, 6) * 6], i * 3);
    cloud.scale[i] = 0.75;
  }
  out.push(cloud);

  // 1 The register: every sale in rows, a wall that curves away at the edges.
  const cols = 48;
  const wall = make();
  for (let i = 0; i < N; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = (c - (cols - 1) / 2) * 0.42;
    const y = ((N / cols - 1) / 2 - r) * 0.26;
    wall.pos.set([x, y, -((x / 10) ** 2) * 4], i * 3);
    wall.rot.set([0, -x / 22, 0], i * 3);
    wall.scale[i] = 1;
  }
  out.push(wall);

  // 2 Thirty samples step forward; the rest fall back.
  const pick = make();
  pick.pos.set(wall.pos);
  pick.rot.set(wall.rot);
  for (let i = 0; i < N; i++) {
    if (samples.has(i)) {
      pick.pos[i * 3 + 2] += 3.2;
      pick.pos[i * 3] *= 0.86;
      pick.scale[i] = 1.7;
      pick.tone[i] = 2;
    } else {
      pick.scale[i] = 0.85;
      pick.tone[i] = 1;
    }
  }
  out.push(pick);

  // 3 Under the UV lamp the fakes glow.
  const uv = make();
  uv.pos.set(wall.pos);
  uv.rot.set(wall.rot);
  for (let i = 0; i < N; i++) {
    const fake = fakes.has(i);
    uv.scale[i] = fake ? 1.35 : 1;
    uv.tone[i] = fake ? 3 : 4;
    if (fake) uv.pos[i * 3 + 2] += 0.6;
  }
  out.push(uv);

  // 4 A ring of six companies, the notes piled at each.
  const ring = make();
  for (let i = 0; i < N; i++) {
    const k = i % 6;
    const a = (k / 6) * Math.PI * 2 + Math.PI / 2;
    const rr = Math.sqrt(rand(i, 7)) * 1.05;
    const t = rand(i, 8) * Math.PI * 2;
    ring.pos.set([Math.cos(a) * 4.4 + Math.cos(t) * rr, Math.sin(a) * 3.3 + Math.sin(t) * rr * 0.8, (rand(i, 9) - 0.5) * 1.4], i * 3);
    ring.rot.set([rand(i, 10) - 0.5, rand(i, 11) - 0.5, rand(i, 12) * 6], i * 3);
    ring.scale[i] = 0.9;
    ring.tone[i] = fakes.has(i) ? 3 : 0;
  }
  out.push(ring);

  // 5 The hash chain: every note a link in one helix.
  const chain = make();
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const a = t * Math.PI * 2 * 10;
    chain.pos.set([Math.cos(a) * 2.8, (t - 0.5) * 15, Math.sin(a) * 2.8], i * 3);
    chain.rot.set([0, -a + Math.PI / 2, 0.25], i * 3);
    chain.scale[i] = 1.25;
    chain.tone[i] = 5;
  }
  out.push(chain);

  // 6 Signed: twelve neat stacks lying on the desk.
  const stacks = make();
  for (let i = 0; i < N; i++) {
    const s = i % 12;
    const h = Math.floor(i / 12);
    stacks.pos.set([((s % 4) - 1.5) * 2.5, -1.6 + h * 0.013, (Math.floor(s / 4) - 1) * 1.7], i * 3);
    stacks.rot.set([-Math.PI / 2, 0, (rand(i, 13) - 0.5) * 0.05], i * 3);
    stacks.scale[i] = 2.6;
    stacks.tone[i] = fakes.has(i) && h > 90 ? 3 : 0;
  }
  out.push(stacks);

  // 7 The cloud again, dim, behind the closing invitation.
  const rest = make();
  rest.pos.set(cloud.pos);
  rest.rot.set(cloud.rot);
  for (let i = 0; i < N; i++) {
    rest.pos[i * 3] -= 3;
    rest.scale[i] = 0.7;
    rest.tone[i] = 1;
  }
  out.push(rest);
  return out;
}

// Camera position for each chapter, and how far the view slides sideways so the
// formation stands clear of the chapter's text panel (negative moves it right).
const cams: [number, number, number, number][] = [
  [0, 0, 13, 0],
  [0, 0, 12, -2.8],
  [0, 0.2, 10.5, 2.8],
  [0, 0, 11, -2.8],
  [0, 0, 15, 3.4],
  [7, 2.5, 14, -3.4],
  [0, 9, 12.5, 3.2],
  [0, 0, 14, 0],
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The chapter pair the scroll sits between, and how far the second has taken over.
function blendOf(p: number): [number, number, number] {
  const i = Math.min(CH - 1, Math.max(0, Math.floor(p)));
  const j = Math.min(CH - 1, i + 1);
  return [i, j, smooth(0.3, 0.9, p - i)];
}

function Notes({ story }: { story: MutableRefObject<StoryState> }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const forms = useMemo(formations, []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const still = prefersReducedMotion();
  const palette = useMemo(() => {
    const c = (name: string, k = 1) => new THREE.Color(token(name)).multiplyScalar(k);
    return [c("canvas", 0.95), c("spine-ink-2", 0.32), c("highlight", 2.2), c("fail", 2.6), new THREE.Color("#2a1a5c"), c("shift-a", 1.0)];
  }, []);
  const col = useMemo(() => new THREE.Color(), []);
  const ca = useMemo(() => new THREE.Color(), []);
  const cb = useMemo(() => new THREE.Color(), []);
  const rot = useMemo(() => new THREE.Euler(), []);

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const time = still ? 0 : clock.elapsedTime;
    const [i, j, t] = blendOf(story.current.p);
    const A = forms[i];
    const B = forms[j];
    const spinA = i === 0 ? time * 0.05 : 0;
    const spinB = j === 0 ? time * 0.05 : 0;
    const pulse = (time * 140) % N;
    for (let k = 0; k < N; k++) {
      const o = k * 3;
      // The cloud turns as a whole; other formations hold still.
      const ax = A.pos[o] * Math.cos(spinA) - A.pos[o + 2] * Math.sin(spinA);
      const az = A.pos[o] * Math.sin(spinA) + A.pos[o + 2] * Math.cos(spinA);
      const bx = B.pos[o] * Math.cos(spinB) - B.pos[o + 2] * Math.sin(spinB);
      const bz = B.pos[o] * Math.sin(spinB) + B.pos[o + 2] * Math.cos(spinB);
      // Each note leaves a little after its neighbour, so formations ripple.
      const lag = Math.min(1, Math.max(0, t * 1.4 - (k / N) * 0.4));
      const e = lag * lag * (3 - 2 * lag);
      const bob = i === 0 || j === 0 ? Math.sin(time * 0.8 + k) * 0.06 : 0;
      dummy.position.set(ax + (bx - ax) * e, A.pos[o + 1] + (B.pos[o + 1] - A.pos[o + 1]) * e + bob, az + (bz - az) * e);
      rot.set(A.rot[o] + (B.rot[o] - A.rot[o]) * e, A.rot[o + 1] + (B.rot[o + 1] - A.rot[o + 1]) * e, A.rot[o + 2] + (B.rot[o + 2] - A.rot[o + 2]) * e);
      dummy.rotation.copy(rot);
      const s = A.scale[k] + (B.scale[k] - A.scale[k]) * e;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      m.setMatrixAt(k, dummy.matrix);
      ca.copy(palette[A.tone[k]]);
      cb.copy(palette[B.tone[k]]);
      // The light that runs along the chain as each hash is checked.
      if (B.tone[k] === 5) {
        const d = Math.abs(k - pulse);
        if (d < 40) cb.lerp(palette[2], 1 - d / 40);
      }
      col.copy(ca).lerp(cb, e);
      m.setColorAt(k, col);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]} frustumCulled={false}>
      <boxGeometry args={[0.36, 0.19, 0.012]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

// Money passing round the ring, shown only in the ring chapter.
function Flow({ story }: { story: MutableRefObject<StoryState> }) {
  const pts = useRef<THREE.Points>(null);
  const M = 260;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(M * 3), 3));
    return g;
  }, []);
  const color = useMemo(() => new THREE.Color(token("highlight")).multiplyScalar(2.4), []);
  useFrame(({ clock }) => {
    const p = story.current.p;
    const show = Math.max(0, 1 - Math.abs(p - 4) * 1.6);
    const mat = pts.current?.material as THREE.PointsMaterial | undefined;
    if (mat) mat.opacity = show;
    if (!show) return;
    const arr = geo.attributes.position.array as Float32Array;
    const time = clock.elapsedTime;
    for (let i = 0; i < M; i++) {
      const a = ((i / M) * Math.PI * 2 + time * 0.55) % (Math.PI * 2);
      const w = Math.sin(i * 12.9) * 0.18;
      arr[i * 3] = Math.cos(a + Math.PI / 2) * (4.4 + w);
      arr[i * 3 + 1] = Math.sin(a + Math.PI / 2) * (3.3 + w);
      arr[i * 3 + 2] = Math.cos(i) * 0.3;
    }
    geo.attributes.position.needsUpdate = true;
  });
  return (
    <points ref={pts} geometry={geo}>
      <pointsMaterial color={color} size={0.09} transparent opacity={0} toneMapped={false} depthWrite={false} />
    </points>
  );
}

// The hero note, drawn on a canvas: guilloche, serial number, the amount in
// colour-shift ink and a security thread. It tilts toward the pointer.
function HeroNote({ story }: { story: MutableRefObject<StoryState> }) {
  const mesh = useRef<THREE.Mesh>(null);
  const [tex, setTex] = useState<THREE.CanvasTexture | null>(null);
  useEffect(() => {
    let live = true;
    const draw = () => {
    const W = 1024;
    const H = 512;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    const paper = token("canvas");
    const ink = token("ink");
    const guil = token("guilloche");
    const shiftA = token("shift-a");
    const shiftB = token("shift-b");
    const fail = token("fail");
    g.fillStyle = paper;
    g.beginPath();
    g.roundRect(0, 0, W, H, 34);
    g.fill();
    // Fine waves across the whole note.
    g.strokeStyle = guil;
    g.globalAlpha = 0.5;
    g.lineWidth = 1;
    for (let r = 0; r < 60; r++) {
      g.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = 10 + r * 8.5 + Math.sin(x / 46 + r * 0.5) * 6;
        if (x) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
    }
    // A rosette, as a lathe would cut it.
    g.globalAlpha = 0.85;
    const rose = (cx: number, cy: number, R: number, r: number, d: number, s: number, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 1.2;
      g.beginPath();
      for (let i = 0; i <= 3600; i++) {
        const t = (i / 3600) * Math.PI * 2 * 9;
        const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
        const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
        if (i) g.lineTo(cx + x * s, cy + y * s);
        else g.moveTo(cx + x * s, cy + y * s);
      }
      g.stroke();
    };
    rose(790, 256, 96, 32, 58, 1.55, shiftA);
    rose(790, 256, 80, 22, 40, 1.55, shiftB);
    g.globalAlpha = 1;
    // Security thread.
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, shiftA);
    grad.addColorStop(0.5, shiftB);
    grad.addColorStop(1, shiftA);
    g.fillStyle = grad;
    for (let y = 0; y < H; y += 34) g.fillRect(560, y, 12, 24);
    // Words and figures.
    g.fillStyle = ink;
    g.font = "700 30px 'Anek Latin Variable', sans-serif";
    g.fillText("SANCHAY  SALE INVOICE", 58, 82);
    g.font = "500 22px 'Anek Latin Variable', sans-serif";
    g.globalAlpha = 0.7;
    g.fillText("Ordered, dispatched, delivered, paid. Each step on record.", 58, 120);
    g.globalAlpha = 1;
    const amount = g.createLinearGradient(58, 0, 520, 0);
    amount.addColorStop(0, shiftA);
    amount.addColorStop(1, shiftB);
    g.fillStyle = amount;
    g.font = "800 132px 'Anek Latin Variable', sans-serif";
    g.fillText("₹ 85,816", 52, 300);
    // The serial number grows from left to right.
    const serial = "SPC2526000001";
    let x = 58;
    g.fillStyle = fail;
    [...serial].forEach((ch, i) => {
      const size = 26 + i * 2.6;
      g.font = `700 ${size}px 'Geist Mono Variable', monospace`;
      g.fillText(ch, x, 410);
      x += g.measureText(ch).width + 2;
    });
    g.fillStyle = ink;
    g.globalAlpha = 0.45;
    g.font = "500 9px 'Geist Mono Variable', monospace";
    for (let i = 0; i < 3; i++) g.fillText("GENUINE SALE VERIFIED AGAINST ITS RECORD ".repeat(6), 58, 452 + i * 11);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    if (live) setTex(t);
    };
    // A canvas draws with whatever font is ready, so wait for the real ones.
    Promise.all(["800 132px 'Anek Latin Variable'", "700 30px 'Anek Latin Variable'", "700 30px 'Geist Mono Variable'"].map((f) => document.fonts.load(f)))
      .catch(() => undefined)
      .then(draw);
    return () => {
      live = false;
    };
  }, []);

  useFrame(({ clock }, dt) => {
    const m = mesh.current;
    if (!m) return;
    const { p, px, py } = story.current;
    const gone = smooth(0.15, 0.85, p);
    m.position.set(3.1 + gone * 1.5, 0.35 + gone * 6, 3.5 - gone * 2);
    m.rotation.x += (-py * 0.35 - m.rotation.x) * Math.min(1, dt * 4);
    m.rotation.y += (px * 0.5 + Math.sin(clock.elapsedTime * 0.4) * 0.08 - m.rotation.y) * Math.min(1, dt * 4);
    (m.material as THREE.MeshBasicMaterial).opacity = 1 - gone;
    m.visible = gone < 0.99 && !!tex;
  });

  return (
    <mesh ref={mesh}>
      <planeGeometry args={[5.2, 2.6]} />
      {tex && <meshBasicMaterial map={tex} transparent toneMapped={false} side={THREE.DoubleSide} />}
    </mesh>
  );
}

function Rig({ story }: { story: MutableRefObject<StoryState> }) {
  const { camera, scene } = useThree();
  const target = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  const bg = useMemo(() => ({ base: new THREE.Color(token("spine")), uv: new THREE.Color("#10052b"), now: new THREE.Color() }), []);
  useEffect(() => {
    scene.background = bg.now;
  }, [scene, bg]);
  useFrame((_, dt) => {
    const { p, px, py } = story.current;
    const [i, j, t] = blendOf(p);
    const a = cams[i];
    const b = cams[j];
    const shift = a[3] + (b[3] - a[3]) * t;
    target.set(a[0] + (b[0] - a[0]) * t + px * 0.8 + shift, a[1] + (b[1] - a[1]) * t - py * 0.5, a[2] + (b[2] - a[2]) * t);
    camera.position.lerp(target, Math.min(1, dt * 3));
    look.x += (shift - look.x) * Math.min(1, dt * 3);
    camera.lookAt(look);
    const uv = Math.max(0, 1 - Math.abs(p - 3) * 1.3);
    bg.now.copy(bg.base).lerp(bg.uv, uv);
  });
  return null;
}

export default function Scene({ story, glow = true }: { story: MutableRefObject<StoryState>; glow?: boolean }) {
  return (
    <Canvas camera={{ position: [cams[0][0], cams[0][1], cams[0][2]], fov: 40, near: 0.1, far: 120 }} dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: "high-performance" }}>
      <Rig story={story} />
      <Notes story={story} />
      <Flow story={story} />
      <HeroNote story={story} />
      {glow && (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.9} luminanceThreshold={1.0} luminanceSmoothing={0.25} />
          <Vignette eskil={false} offset={0.2} darkness={0.7} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
