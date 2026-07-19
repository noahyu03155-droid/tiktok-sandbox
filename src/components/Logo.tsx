// Phase 19 rebrand: "The Pawmart" → COTORX.
//
// Phase 74: redone from the Phase 47 icon+wordmark lockup to a pure
// outline/stroke wordmark (Rajdhani 300, hollow -webkit-text-stroke).
//
// Phase 75d: the thin outline read as too subtle — not "tech" enough on
// its own. Redone again to lean into the cyan→indigo gradient + glow
// language already established elsewhere in the app (Manual Edit modal's
// dark tech UI, its crossing-blade icon badge): a small glowing
// "status LED" square precedes a bold gradient-filled wordmark with a
// soft cyan glow behind it. Reads as tech at a glance even on the light
// backgrounds Logo is used on (header, login/register cards) since the
// gradient is vivid and self-illuminating rather than relying on a dark
// backdrop. The favicon (src/app/icon.tsx) is unaffected — still its own
// small rounded-square + play-triangle mark, unreadable as text at
// 16-32px anyway.
export default function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const fontSize = size === "sm" ? 18 : 24;
  const dot = size === "sm" ? 5 : 6;
  return (
    <span className="inline-flex items-center gap-1.5 leading-none select-none">
      <span
        aria-hidden
        style={{
          width: dot,
          height: dot,
          borderRadius: 1,
          background: "linear-gradient(135deg, #22d3ee, #6366f1)",
          boxShadow: "0 0 6px rgba(34,211,238,0.9), 0 0 2px rgba(99,102,241,0.8)",
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-wordmark), sans-serif",
          fontWeight: 600,
          fontSize,
          letterSpacing: "0.06em",
          backgroundImage: "linear-gradient(90deg, #0891b2 0%, #22d3ee 40%, #6366f1 100%)",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          filter: "drop-shadow(0 0 5px rgba(34,211,238,0.35))",
        }}
      >
        COTORX
      </span>
    </span>
  );
}
