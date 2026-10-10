// Theme state. The interface is printed in the inks of Indian banknotes:
// a palette is one note's colours. Night is the dark palette. The UV lamp is
// a mode on top of any palette: the page goes dark violet and exceptions
// fluoresce, the way a note's hidden marks do under ultraviolet light.
// The choices are kept on the <html> element so CSS variables do the work.

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
export type Palette = "stone" | "magenta" | "lavender" | "marigold" | "peacock" | "night";

export const palettes: { id: Palette; name: string; note: string; swatch: [string, string, string] }[] = [
  { id: "stone", name: "Stone", note: "The grey of the ₹500 note, with its colour-shift green", swatch: ["#e3e2dc", "#1e5f8c", "#f2a93b"] },
  { id: "magenta", name: "Magenta", note: "The deep pink of the ₹2000 note", swatch: ["#f6e6ef", "#a3125f", "#ffc93c"] },
  { id: "lavender", name: "Lavender", note: "The lavender of the ₹100 note", swatch: ["#ebe8f6", "#5b47b0", "#7ce0c3"] },
  { id: "marigold", name: "Marigold", note: "The bright yellow of the ₹200 note", swatch: ["#f6e9b8", "#9a5b00", "#2d7a3e"] },
  { id: "peacock", name: "Peacock", note: "The fluorescent blue of the ₹50 note", swatch: ["#dcf0f5", "#0a7c98", "#ffb547"] },
  { id: "night", name: "Night", note: "Intaglio ink on a dark sheet", swatch: ["#12161b", "#5bb8e8", "#f2a93b"] },
];

const KEY = "sanchay-palette";
const UV_KEY = "sanchay-uv";
const listeners = new Set<() => void>();

const html = () => document.documentElement;

export function getPalette(): Palette {
  return (html().dataset.palette as Palette) || "stone";
}

export function getTheme(): Theme {
  return getPalette() === "night" || html().dataset.uv === "on" ? "dark" : "light";
}

export function isUv(): boolean {
  return html().dataset.uv === "on";
}

function apply(palette: Palette, uv: boolean) {
  const h = html();
  h.dataset.palette = palette;
  h.dataset.theme = palette === "night" || uv ? "dark" : "light";
  if (uv) h.dataset.uv = "on";
  else delete h.dataset.uv;
  listeners.forEach((fn) => fn());
}

export function setPalette(p: Palette) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* kept for this visit only */
  }
  apply(p, isUv());
}

export function setUv(on: boolean) {
  try {
    localStorage.setItem(UV_KEY, on ? "on" : "off");
  } catch {
    /* kept for this visit only */
  }
  apply(getPalette(), on);
}

// The old light and dark switch, kept for the parts that only care which it is.
export function setTheme(theme: Theme) {
  setPalette(theme === "dark" ? "night" : getPalette() === "night" ? "stone" : getPalette());
}

export function initTheme() {
  let p: Palette = "stone";
  let uv = false;
  try {
    const stored = localStorage.getItem(KEY) as Palette | null;
    if (stored && palettes.some((x) => x.id === stored)) p = stored;
    else if (localStorage.getItem("revenue-audit-theme") === "dark") p = "night";
    uv = localStorage.getItem(UV_KEY) === "on";
  } catch {
    /* defaults */
  }
  apply(p, uv);
}

function useSubscribe<T>(read: () => T): T {
  const [v, set] = useState<T>(read);
  useEffect(() => {
    const fn = () => set(read());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  return [useSubscribe(getTheme), setTheme];
}

export function usePalette(): [Palette, (p: Palette) => void] {
  return [useSubscribe(getPalette), setPalette];
}

export function useUv(): [boolean, (on: boolean) => void] {
  return [useSubscribe(isUv), setUv];
}

// Reads a design token, so canvas and WebGL drawings use the same colours as
// the page.
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
