// Phase 19 rebrand: "The Pawmart" → COTORX. Wordmark is set in a bold
// sans face with the "X" rendered noticeably larger and offset slightly
// below the baseline, so it reads as a small logo-mark rather than just a
// bigger letter — the brand-blue accent color the site already used for
// buttons/active nav carries over onto just the X, while the rest of the
// word stays near-black to match the bold, high-contrast type treatment of
// the reference design.
export default function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const textSize = size === "sm" ? "text-xl" : "text-3xl";
  const xSize = size === "sm" ? "text-3xl" : "text-4xl";
  return (
    <div className="leading-none select-none font-sans">
      <div className={`${textSize} font-black text-zinc-900 tracking-tight flex items-baseline`}>
        <span>COTOR</span>
        <span className={`${xSize} font-black text-brand-500 -ml-0.5 relative top-[0.08em]`}>X</span>
      </div>
    </div>
  );
}
