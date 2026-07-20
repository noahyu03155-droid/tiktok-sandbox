"use client";

// The app's step-flow tagline — Create → Optimize → Trend → Operate →
// Result — spelling out the first 5 letters of the product name (COTORX)
// as the actual workflow: analyze/generate a video (Create), refine it
// (Optimize), ride what's trending (Trend), run it across accounts
// (Operate), see the payoff (Result). Shown on the outward-facing pages a
// prospective user sees around signup — the marketing landing page
// (RegisterLanding.tsx), /login, and /pricing — for consistent branding
// across that funnel. Not shown inside the logged-in app itself, where
// HeaderBar's shorter appTagline already does that job.
const STEPS = ["Create", "Optimize", "Trend", "Operate", "Result"];

// Sized as a bold statement piece, not a footnote — but ALWAYS on a single
// line (the user explicitly asked for both). Fixed Tailwind text sizes
// can't guarantee that, because this renders in wildly different widths
// (narrow max-w-sm login card vs. full-width landing hero), so the font
// size is fluid: container-query units (cqw) scale the text to whatever
// width the parent actually has, with clamp() keeping it inside sane
// min/max bounds. The whole 5-word + 4-arrow row measures ~26em, so
// 3.6cqw fits it with a small margin at ANY container width. Gaps and
// arrows are em-based so they shrink/grow with the text.
export default function SloganFlow({ size = "md", className = "" }: { size?: "sm" | "md"; className?: string }) {
  const fontSize =
    size === "sm" ? "clamp(0.72rem, 3.6cqw, 1.35rem)" : "clamp(0.9rem, 3.6cqw, 2.1rem)";
  return (
    <div className={`w-full ${className}`} style={{ containerType: "inline-size" }}>
      <div
        className="flex items-center justify-center flex-nowrap whitespace-nowrap"
        style={{ fontSize, gap: "0.5em" }}
      >
        {STEPS.map((step, i) => (
          <div key={step} className="flex items-center" style={{ gap: "0.5em" }}>
            <span className="font-bold tracking-tight bg-gradient-to-r from-brand-500 via-sky-400 to-purple-500 bg-clip-text text-transparent">
              {step}
            </span>
            {i < STEPS.length - 1 && (
              <span className="text-zinc-400" style={{ fontSize: "0.8em" }}>
                →
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
