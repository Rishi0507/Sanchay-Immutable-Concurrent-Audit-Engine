import { ReactNode, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./theme";

// A figure counts up from zero the first time it shows, and again only when it
// changes. Text around the number ("₹ ", " Cr") stays as it is.
export function Figure({ value }: { value: ReactNode }) {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : null;
  const match = text?.match(/-?[\d,]*\.?\d+/);
  const target = match ? Number(match[0].replace(/,/g, "")) : NaN;
  const [shown, setShown] = useState(target);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    if (prefersReducedMotion() || last.current === target) {
      setShown(target);
      last.current = target;
      return;
    }
    const from = last.current ?? 0;
    last.current = target;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 850);
      setShown(from + (target - from) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  if (!text || !match || !Number.isFinite(target)) return <>{value}</>;
  const decimals = (match[0].split(".")[1] ?? "").length;
  const grouped = match[0].includes(",");
  const body = grouped ? shown.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : shown.toFixed(decimals);
  return (
    <>
      {text.slice(0, match.index)}
      {body}
      {text.slice((match.index ?? 0) + match[0].length)}
    </>
  );
}

