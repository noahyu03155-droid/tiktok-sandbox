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

// Sized as a bold statement piece, not a footnote: "md" (landing hero) is
// display-scale, "sm" (login card / pricing) is still prominently large —
// the user explicitly asked for this after an earlier, tiny version felt
// like fine print rather than the brand's signature line.
export default function SloganFlow({ size = "md", className = "" }: { size?: "sm" | "md"; className?: string }) {
  const text = size === "sm" ? "text-lg sm:text-xl" : "text-2xl sm:text-4xl";
  const gap = size === "sm" ? "gap-2" : "gap-2.5 sm:gap-4";
  const arrow = size === "sm" ? "text-base" : "text-xl sm:text-2xl";
  return (
    <div className={`flex items-center justify-center flex-wrap ${gap} ${className}`}>
      {STEPS.map((step, i) => (
        <div key={step} className="flex items-center gap-2 sm:gap-2.5">
          <span
            className={`${text} font-bold tracking-tight bg-gradient-to-r from-brand-500 via-sky-400 to-purple-500 bg-clip-text text-transparent whitespace-nowrap`}
          >
            {step}
          </span>
          {i < STEPS.length - 1 && <span className={`${arrow} text-zinc-400`}>→</span>}
        </div>
      ))}
    </div>
  );
}
