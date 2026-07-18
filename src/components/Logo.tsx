// Phase 19 rebrand: "The Pawmart" → COTORX.
//
// Phase 42: redone as a techy, black-and-white minimal mark per the user's
// request — dropped the blue accent color entirely (pure black/white now),
// switched the wordmark to Space Grotesk (a clean geometric sans, see
// --font-wordmark in layout.tsx) instead of the default rounded sans, and
// replaced the old colored "bigger X" treatment with a small inverted
// (black-fill, white-text) square badge around just the X — the kind of
// monochrome logomark badge common on developer-tool/tech brands, giving a
// "tech" read without introducing any color.
export default function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const textSize = size === "sm" ? "text-lg" : "text-2xl";
  const badgeSize = size === "sm" ? "w-6 h-6 text-sm" : "w-8 h-8 text-lg";
  return (
    <div className="leading-none select-none flex items-center gap-1.5" style={{ fontFamily: "var(--font-wordmark), sans-serif" }}>
      <span className={`${textSize} font-bold text-zinc-900 tracking-tight`}>COTOR</span>
      <span
        className={`${badgeSize} inline-flex items-center justify-center bg-zinc-900 text-white font-bold rounded-md`}
      >
        X
      </span>
    </div>
  );
}
