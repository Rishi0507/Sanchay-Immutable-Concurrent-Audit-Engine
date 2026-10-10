import { cx } from "./ui";

// The rubber stamp, inked with a little roughness, set down at an angle.
// `word` is what the stamp says; the lines under it are the date and a detail.
export function Stamp({ word, detail, tone = "fail", small, className }: { word: string; detail?: string; tone?: "fail" | "pass" | "wait"; small?: boolean; className?: string }) {
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const color = { fail: "#d4381e", pass: "#0b6e4f", wait: "#a06a00" }[tone];
  const id = `ink-${word.replace(/\W/g, "")}-${small ? "s" : "l"}`;
  return (
    <div className={cx("pointer-events-none absolute", className ?? (small ? "stamp-still -top-3 -right-3" : "stamp -top-10 -right-10 md:-right-16"))} aria-hidden>
      <svg width={small ? 150 : 250} height={small ? 90 : 150} viewBox="0 0 250 150">
        <defs>
          <filter id={`${id}-rough`}>
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" />
            <feDisplacementMap in="SourceGraphic" scale="3" />
          </filter>
          <filter id={`${id}-speckle`}>
            <feTurbulence type="fractalNoise" baseFrequency="2.2" numOctaves="1" seed="3" />
            <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.25" />
          </filter>
          <mask id={`${id}-gaps`}>
            <rect width="250" height="150" fill="white" />
            <rect width="250" height="150" fill="black" filter={`url(#${id}-speckle)`} />
          </mask>
        </defs>
        <g filter={`url(#${id}-rough)`} mask={`url(#${id}-gaps)`} fill="none" stroke={color} opacity="0.9">
          <rect x="6" y="6" width="238" height="138" rx="14" strokeWidth="5" />
          <rect x="15" y="15" width="220" height="120" rx="9" strokeWidth="1.8" />
          <text x="125" y="72" textAnchor="middle" fill={color} stroke="none" fontSize={word.length > 9 ? 34 : 40} fontWeight="800" fontFamily="Anek Latin Variable, sans-serif" letterSpacing="3">
            {word}
          </text>
          <text x="125" y="98" textAnchor="middle" fill={color} stroke="none" fontSize="15" fontWeight="700" fontFamily="Anek Latin Variable, sans-serif">
            SANCHAY {today.toUpperCase()}
          </text>
          {detail && (
            <text x="125" y="120" textAnchor="middle" fill={color} stroke="none" fontSize="12" fontFamily="Geist Mono Variable, monospace">
              {detail}
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}
