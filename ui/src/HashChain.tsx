// The ledger drawn as what it is: a chain of records, each holding the hash
// of the one before. Click a record to alter it and every record after it
// stops verifying. It is the product's central guarantee in one gesture.
//
// This is the only 3D in the application, and it is loaded on the sign-in
// screen alone, so the working screens carry none of its weight.

import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const COUNT = 7;
const GAP = 1.62;

// Faces are flat colours from the design tokens, lightest on top, so the
// blocks read as a drawing, not a render. Order: side, top, front.
const faces = {
  sound: ["#dce6f4", "#ffffff", "#f1f5fb"],
  hover: ["#cfdcf0", "#f4f8fd", "#e4ecf8"],
  broken: ["#f3cfca", "#fff6f5", "#fbe3e0"],
};
const colour = { edge: "#1f4e9e", link: "#1f4e9e", brokenEdge: "#b3261e" };

function faceMaterials([side, top, front]: string[]) {
  const m = (c: string) => new THREE.MeshBasicMaterial({ color: c });
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z.
  return [m(side), m(side), m(top), m(top), m(front), m(front)];
}

function Block({
  index,
  broken,
  tampered,
  still,
  onPick,
}: {
  index: number;
  broken: boolean;
  tampered: boolean;
  still: boolean;
  onPick: (index: number) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const box = useMemo(() => new THREE.BoxGeometry(1, 0.72, 0.72), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(box), [box]);
  const materials = useMemo(() => ({ sound: faceMaterials(faces.sound), hover: faceMaterials(faces.hover), broken: faceMaterials(faces.broken) }), []);
  const x = (index - (COUNT - 1) / 2) * GAP;

  // Refs are moved directly; no React state changes per frame.
  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = still ? 0 : state.clock.elapsedTime;
    const lift = tampered ? 0.34 : still ? 0 : Math.sin(t * 0.9 + index * 0.7) * 0.05;
    const tilt = tampered ? 0.38 : 0;
    // With motion reduced there is one frame per change, so jump to the pose.
    const ease = still ? 1 : 0.12;
    g.position.y += (lift - g.position.y) * ease;
    g.rotation.z += (tilt - g.rotation.z) * ease;
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(true);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    setHover(false);
    document.body.style.cursor = "";
  };

  return (
    <group ref={group} position={[x, 0, 0]}>
      <mesh
        geometry={box}
        material={broken ? materials.broken : hover ? materials.hover : materials.sound}
        onPointerOver={over}
        onPointerOut={out}
        onClick={(e) => {
          e.stopPropagation();
          onPick(index);
        }}
      />
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={broken ? colour.brokenEdge : colour.edge} />
      </lineSegments>
    </group>
  );
}

function Link({ index, broken }: { index: number; broken: boolean }) {
  const x = (index - (COUNT - 1) / 2) * GAP + GAP / 2;
  // A broken link is drawn short, so the gap is visible.
  const length = broken ? 0.16 : GAP - 1;
  return (
    <mesh position={[broken ? x - 0.2 : x, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
      <cylinderGeometry args={[0.035, 0.035, length, 12]} />
      <meshBasicMaterial color={broken ? colour.brokenEdge : colour.link} />
    </mesh>
  );
}

// Scales the drawing to the width it is given.
function Fit() {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    camera.zoom = Math.max(34, Math.min(84, size.width / 13.5));
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size.width, invalidate]);
  return null;
}

function Chain({ brokenAt, still, onPick }: { brokenAt: number | null; still: boolean; onPick: (i: number) => void }) {
  const group = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!group.current || still) return;
    group.current.rotation.y = -0.42 + Math.sin(state.clock.elapsedTime * 0.25) * 0.1;
  });
  return (
    <group ref={group} rotation={[0.46, -0.42, 0]}>
      {Array.from({ length: COUNT }, (_, i) => (
        <Block key={i} index={i} broken={brokenAt !== null && i >= brokenAt} tampered={brokenAt === i} still={still} onPick={onPick} />
      ))}
      {Array.from({ length: COUNT - 1 }, (_, i) => (
        <Link key={i} index={i} broken={brokenAt !== null && i + 1 >= brokenAt} />
      ))}
    </group>
  );
}

export default function HashChain() {
  const [brokenAt, setBrokenAt] = useState<number | null>(null);
  const still = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  const pick = (i: number) => setBrokenAt((current) => (current === i ? null : i));

  return (
    <div className="flex h-full w-full flex-col justify-center">
      <div className="h-[42vh] min-h-64">
        <Canvas flat orthographic camera={{ zoom: 62, position: [0, 0, 10], near: 0.1, far: 50 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }} frameloop={still ? "demand" : "always"}>
          <Fit />
          <Chain brokenAt={brokenAt} still={still} onPick={pick} />
        </Canvas>
      </div>
      <div className="mx-auto min-h-16 w-full max-w-xl px-10 text-center" aria-live="polite">
        {brokenAt === null ? (
          <>
            <p className="text-[15px] font-medium text-ink">Every record carries the hash of the one before it.</p>
            <p className="mt-1 text-sm text-ink-2">Click a record to alter it.</p>
          </>
        ) : (
          <>
            <p className="text-[15px] font-medium text-fail">
              Record {brokenAt + 1} was altered. {COUNT - brokenAt === 1 ? "It no longer verifies." : `It and the ${COUNT - brokenAt - 1} after it no longer verify.`}
            </p>
            <button onClick={() => setBrokenAt(null)} className="mt-1 text-sm font-medium text-brand hover:text-brand-deep">
              Restore the chain
            </button>
          </>
        )}
      </div>
    </div>
  );
}
