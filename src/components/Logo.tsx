// Phase 19 rebrand: "The Pawmart" → COTORX.
//
// Phase 47: redone again — the Phase 42 version (plain "COTOR" wordmark
// plus a separate solid-black square badge just around the "X") read as an
// unfinished placeholder rather than an actual logo once it was sitting
// next to real content. This drops the letter-in-a-box treatment entirely
// in favor of a proper icon+wordmark lockup: a small rounded-square outline
// containing a play triangle (this is fundamentally a video tool — the mark
// reads as "video" at a glance) sitting beside the full "COTORX" wordmark,
// set tight in Space Grotesk. Same monochrome black — still pure black/white,
// no color introduced. The mark on its own (no wordmark) is reused as-is for
// the browser tab favicon — see src/app/icon.tsx.
export default function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const textSize = size === "sm" ? "text-lg" : "text-2xl";
  const markPx = size === "sm" ? 22 : 28;
  return (
    <div className="leading-none select-none flex items-center gap-2" style={{ fontFamily: "var(--font-wordmark), sans-serif" }}>
      <svg width={markPx} height={markPx} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
        <rect x="2" y="2" width="28" height="28" rx="8" stroke="#18181b" strokeWidth="2.5" />
        <path d="M13 10.8L22.5 16L13 21.2V10.8Z" fill="#18181b" />
      </svg>
      <span className={`${textSize} font-bold text-zinc-900 tracking-tight`}>COTORX</span>
    </div>
  );
}
