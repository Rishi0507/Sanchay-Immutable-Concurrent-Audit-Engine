// Theme state. Graphite is the default; the light theme is a printed page.
// The choice is kept on the <html> element so CSS variables do the work.

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const KEY = "revenue-audit-theme";
const listeners = new Set<(t: Theme) => void>();

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(KEY, theme);
  listeners.forEach((fn) => fn(theme));
}

export function initTheme() {
  const stored = localStorage.getItem(KEY);
  document.documentElement.dataset.theme = stored === "light" ? "light" : "dark";
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(getTheme());
  useEffect(() => {
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return [theme, setTheme];
}

// Reads a design token, so canvas and WebGL drawings use the same colours as
// the page.
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
