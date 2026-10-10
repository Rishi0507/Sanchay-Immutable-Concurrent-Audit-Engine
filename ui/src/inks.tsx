// The ink picker and the UV lamp switch, used on the front page and in the workspace.

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

