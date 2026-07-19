// Phase 19 rebrand: "The Pawmart" → COTORX.
//
// Phase 74: redone again, from the Phase 47 icon+wordmark lockup (a
// rounded-square play-triangle badge beside a bold filled "COTORX") to a
// pure outline wordmark — no separate icon mark. Rajdhani at a light
// weight, wide letter-spacing, rendered as a hollow/outline glyph
// (`-webkit-text-stroke` with a near-transparent fill instead of a solid
// one) rather than a filled shape — reads as a thin-line technical/
// blueprint mark instead of a normal bold logotype. The favicon (a small
// fixed-size glyph, not readable as text at 16-32px) keeps its own simple
// rounded-square + play-triangle mark — see src/app/icon.tsx — unaffected
// by this change.
export default function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const fontSize = size === "sm" ? 19 : 25;
  const strokeWidth = size === "sm" ? 1 : 1.1;
  return (
    <span
      className="leading-none select-none inline-block"
      style={{
        fontFamily: "var(--font-wordmark), sans-serif",
        fontWeight: 300,
        fontSize,
        letterSpacing: "0.15em",
        // Near-transparent (not fully transparent) fill: browsers without
        // -webkit-text-stroke support still render faint-but-legible text
        // instead of nothing; browsers that DO support it show the hollow
        // outline look on top, which is what actually reads at normal size.
        color: "rgba(24,24,27,0.08)",
        WebkitTextStroke: `${strokeWidth}px #18181b`,
      }}
    >
      COTORX
    </span>
  );
}
