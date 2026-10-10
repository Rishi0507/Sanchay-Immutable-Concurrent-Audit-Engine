// State shared between the page and the 3D scene. The scene reads it every
// frame, so it is a plain object and not React state: scrolling must never
// re-render the page.

import type { Sale } from "./data";

export const story = {
  // Position in the story: 0 is the first chapter at rest, 1 the second.
  p: 0,
  // Block of the gold chain the visitor altered in the proof, or -1.
  brokenAt: -1,
};

export interface Hover {
  sale: Sale;
  x: number;
  y: number;
}

type Listener = (h: Hover | null) => void;
const listeners = new Set<Listener>();

export function setHover(h: Hover | null) {
  listeners.forEach((fn) => fn(h));
}

export function onHover(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 1 while the story is between chapters a and b, easing in and out.
export function during(p: number, a: number, b: number) {
  return smoothstep(a - 0.45, a - 0.05, p) * (1 - smoothstep(b + 0.05, b + 0.45, p));
}
