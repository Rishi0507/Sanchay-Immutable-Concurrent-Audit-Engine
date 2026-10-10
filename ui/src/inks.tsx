// The ink picker and the UV lamp switch, used on the front page and in the workspace.

import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";
import { Palette, palettes, usePalette, useUv } from "./theme";

export function PalettePicker({ compact, onDark }: { compact?: boolean; onDark?: boolean }) {
  const [palette, setPalette] = usePalette();
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Ink">
      {palettes.map((p) => (
        <button
          key={p.id}
          role="radio"
          aria-checked={palette === p.id}
          onClick={() => setPalette(p.id as Palette)}
          title={`${p.name}: ${p.note}`}
          className={cx(
            "relative overflow-hidden rounded-full transition-transform duration-150 hover:scale-110",
            compact ? "h-6 w-6" : "h-8 w-8",
            palette === p.id ? (onDark ? "ring-2 ring-white ring-offset-2 ring-offset-transparent" : "ring-2 ring-ink ring-offset-2 ring-offset-paper") : "",
          )}
          style={{ background: `conic-gradient(${p.swatch[0]} 0 50%, ${p.swatch[1]} 50% 80%, ${p.swatch[2]} 80% 100%)` }}
        >
          <span className="sr-only">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

export function UvSwitch({ onDark }: { onDark?: boolean }) {
  const [uv, setUv] = useUv();
  return (
    <button
      onClick={() => setUv(!uv)}
      aria-pressed={uv}
      title="Under ultraviolet light the exceptions glow"
      className={cx(
        "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[14px] font-bold transition-[background-color,box-shadow,color] duration-200",
        uv ? "border-[#b26bff] bg-[#2a0f5c] text-[#f8ff3c] shadow-[0_0_24px_rgba(160,90,255,0.65)]" : onDark ? "border-white/25 text-spine-ink hover:border-white/50" : "border-line text-ink hover:border-brand",
      )}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7 3h6l-1 6H8z" />
        <path d="M10 9v3M5 15l2-2M15 15l-2-2M10 17v1" />
      </svg>
      UV lamp {uv ? "on" : "off"}
    </button>
  );
}


// One small button for the ink, opening the palettes upward. It keeps the
// side navigation short enough that every section shows on a laptop screen.
export function InkButton() {
  const [palette, setPalette] = usePalette();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const now = palettes.find((p) => p.id === palette) ?? palettes[0];
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        title={`Ink: ${now.name}`}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-white/25 pr-3 pl-1.5 text-[14px] font-bold text-spine-ink transition-colors hover:border-white/50"
      >
        <span className="h-6 w-6 rounded-full" style={{ background: `conic-gradient(${now.swatch[0]} 0 50%, ${now.swatch[1]} 50% 80%, ${now.swatch[2]} 80% 100%)` }} />
        Ink
      </button>
      {open && (
        <div className="view absolute bottom-full left-0 z-50 mb-2 w-[250px] rounded-xl border border-line bg-paper p-1.5 text-ink shadow-[0_20px_50px_rgba(0,0,0,0.35)]" role="radiogroup" aria-label="Ink">
          {palettes.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={palette === p.id}
              onClick={() => {
                setPalette(p.id as Palette);
                setOpen(false);
              }}
              className={cx("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-wash", palette === p.id && "bg-brand-wash")}
            >
              <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: `conic-gradient(${p.swatch[0]} 0 50%, ${p.swatch[1]} 50% 80%, ${p.swatch[2]} 80% 100%)` }} />
              <span className="min-w-0">
                <span className="block text-[14px] font-bold">{p.name}</span>
                <span className="block truncate text-[12px] text-ink-2">{p.note}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
