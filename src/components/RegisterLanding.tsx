"use client";

// Register page — this is the app's default entry point for anyone without
// a session (see middleware.ts, which sends unauthenticated visits here
// instead of /login; still reachable via the navbar's "Log in" link), so
// it's meant to read as a proper marketing homepage rather than a bare
// login box, since the account is eventually sold as a paid subscription.
//
// Phase 41: rebuilt the hero to match a reference (Packify.ai) — plain
// borderless white navbar, a CENTERED headline with a gradient accent line,
// centered subtitle, two centered pill CTAs.
//
// Phase 42: per the user's explicit note that the homepage doesn't need to
// force the sign-up form front-and-center ("不规定要有那个sign up板块"),
// restructured this into an actual content-driven marketing homepage,
// mirroring the STRUCTURE (not the content/claims) of what's below Packify's
// own hero — a proof strip, a numbered "how it works," a feature grid, then
// a final CTA banner. The sign-up form moved from directly under the hero
// down to its own section near the bottom (still reachable instantly via
// either "Get started" button, which scrolls + highlights it). Deliberately
// does NOT copy Packify's fabricated-sounding elements (customer logo wall,
// "200,000+ brands," testimonials) since COTORX has no real data to back
// those claims — every section below describes COTORX's own actual,
// shipped features.
import { Suspense, useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/translations";
import Logo from "@/components/Logo";
import LanguageToggle from "@/components/LanguageToggle";
import RegisterForm from "@/components/RegisterForm";

const HOW_STEPS: { titleKey: TranslationKey; bodyKey: TranslationKey }[] = [
  { titleKey: "registerHowStep1Title", bodyKey: "registerHowStep1Body" },
  { titleKey: "registerHowStep2Title", bodyKey: "registerHowStep2Body" },
  { titleKey: "registerHowStep3Title", bodyKey: "registerHowStep3Body" },
];

const FEATURES: { icon: string; titleKey: TranslationKey; bodyKey: TranslationKey }[] = [
  { icon: "🔍", titleKey: "registerFeatureBreakdownTitle", bodyKey: "registerFeatureBreakdownBody" },
  { icon: "✍️", titleKey: "registerFeatureScriptTitle", bodyKey: "registerFeatureScriptBody" },
  { icon: "🗂️", titleKey: "registerFeatureStoryboardTitle", bodyKey: "registerFeatureStoryboardBody" },
  { icon: "📈", titleKey: "registerFeatureTrendsTitle", bodyKey: "registerFeatureTrendsBody" },
  { icon: "🎥", titleKey: "registerFeatureCreatorTitle", bodyKey: "registerFeatureCreatorBody" },
  { icon: "🎯", titleKey: "registerFeatureInsightsTitle", bodyKey: "registerFeatureInsightsBody" },
];

function ThumbCard({
  src,
  className = "",
  borderClassName = "border-white",
  style,
}: {
  src: string | null;
  className?: string;
  // Kept as its own prop (rather than folded into className) since Tailwind
  // doesn't merge/override conflicting utility classes by source order in
  // the className string — the hero deck needs a white border, the dark
  // showcase strip needs a dark one, and both must reliably win.
  borderClassName?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-2xl overflow-hidden border-4 ${borderClassName} shadow-2xl shadow-zinc-900/20 bg-panel2 aspect-[9/16] shrink-0 ${className}`}
      style={style}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-brand-100 to-brand-400" />
      )}
    </div>
  );
}

interface ShowcaseVideo {
  thumb: string;
  author: string | null;
}

// Small circular badge on each floating-grid card — reuses the same
// play-triangle glyph as the Logo/favicon mark (see Logo.tsx's Phase 47
// note) purely for brand consistency, standing in for a platform icon the
// way Spyglass.so's reference grid uses an Instagram bubble.
function PlayBadge() {
  return (
    <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-white shadow flex items-center justify-center">
      <svg width="10" height="10" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M13 10.8L22.5 16L13 21.2V10.8Z" fill="#18181b" />
      </svg>
    </div>
  );
}

// Spyglass.so-style floating/staggered grid of real analyzed-video
// thumbnails — alternating columns are nudged up/down (translate-y) so the
// grid doesn't read as a flat, boring table. Each card gets a name (the
// video's real TikTok author handle) + role caption underneath, same
// two-line pattern as the reference. Falls back to a generic label when a
// video has no author on record rather than inventing one.
function FloatingShowcaseGrid({ videos, t }: { videos: ShowcaseVideo[]; t: (key: TranslationKey) => string }) {
  const cards = videos.length > 0 ? videos.slice(0, 8) : new Array(8).fill({ thumb: null, author: null });
  return (
    <div className="grid grid-cols-4 gap-3 sm:gap-4">
      {cards.map((v: ShowcaseVideo, i: number) => (
        <div key={i} className={i % 2 === 1 ? "mt-6 sm:mt-8" : ""}>
          <div className="relative rounded-xl overflow-hidden border border-edge shadow-lg shadow-zinc-900/10 bg-panel2 aspect-[9/16]">
            {v.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={v.thumb} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-brand-100 to-brand-400" />
            )}
            <PlayBadge />
          </div>
          <p className="mt-1.5 text-xs font-semibold text-zinc-900 truncate">
            {v.author ? `@${v.author}` : t("registerShowcaseAnonymous")}
          </p>
          <p className="text-[11px] text-zinc-500">{t("registerShowcaseRoleCreator")}</p>
        </div>
      ))}
    </div>
  );
}

export default function RegisterLanding({ showcaseVideos }: { showcaseVideos: ShowcaseVideo[] }) {
  const { t } = useLocale();
  // "Get started" used to be a bare #register-form anchor link — on desktop
  // the sign-up panel already sits in view next to the headline, so a hash
  // jump was a visual no-op and felt broken. This scrolls explicitly (so it
  // still does something useful on narrow/short viewports) AND briefly
  // rings the sign-up card, so clicking always produces a visible reaction
  // even when there's nowhere left to scroll to.
  const [pulseForm, setPulseForm] = useState(false);
  function handleGetStarted(e: React.MouseEvent) {
    e.preventDefault();
    document.getElementById("register-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    setPulseForm(true);
    window.setTimeout(() => setPulseForm(false), 1200);
  }

  // Arriving here via a link that already points at the sign-up section
  // (e.g. the login page's "Register" link, now /register#register-form)
  // should land directly on it instead of the top of the marketing page —
  // same destination "Get started" scrolls to above. Done as an explicit
  // effect rather than relying on the browser's native hash-scroll-on-load,
  // since that can land in the wrong spot here: the page has async-loaded
  // showcase thumbnails above this section that shift its position after
  // the browser's initial (pre-hydration) scroll attempt already happened.
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#register-form") return;
    const el = document.getElementById("register-form");
    if (!el) return;
    // A tick after mount so images/layout above have settled before we
    // measure the scroll target's position.
    const timer = window.setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
    return () => window.clearTimeout(timer);
  }, []);

  const thumbnails = showcaseVideos.map((v) => v.thumb);
  const stripSource = thumbnails.length > 0 ? thumbnails : new Array(10).fill(null);
  // Doubled so the CSS animation (translateX -50%) loops seamlessly.
  const stripImages = [...stripSource, ...stripSource];
  // A different slice for the floating grid than the marquee strip uses, so
  // the two showcase moments on the page don't feel like the exact same
  // content repeated.
  const floatingVideos = showcaseVideos.slice(8, 16);

  return (
    <div className="min-h-screen bg-ink">
      {/* Plain borderless navbar. */}
      <div className="px-4 sm:px-6 py-5">
        <div className="max-w-6xl mx-auto flex items-center gap-4">
          <Logo size="sm" />
          <div className="ml-auto flex items-center gap-3">
            <LanguageToggle />
            <a
              href="/login"
              className="text-sm bg-zinc-900 hover:bg-black text-white font-medium rounded-full px-4 py-2 transition-colors whitespace-nowrap"
            >
              {t("registerLoginNav")}
            </a>
          </div>
        </div>
      </div>

      {/* Hero — centered headline with a gradient accent line, centered
          subtitle, two centered pill CTAs. */}
      <div className="max-w-3xl mx-auto px-6 pt-12 sm:pt-16 pb-6 text-center">
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-zinc-900 leading-[1.08]">
          <span>{t("registerHeroHeadline1")}</span>
          <br />
          <span className="bg-gradient-to-r from-brand-500 via-sky-400 to-purple-500 bg-clip-text text-transparent">
            {t("registerHeroHeadline2")}
          </span>
        </h1>
        <p className="mt-6 text-lg text-zinc-500 leading-relaxed max-w-xl mx-auto">{t("registerHeroSubtitle")}</p>
        <div className="mt-8 flex items-center justify-center gap-3 flex-wrap">
          <button
            onClick={handleGetStarted}
            className="bg-zinc-900 hover:bg-black text-white font-medium rounded-full px-6 py-3 text-sm transition-colors"
          >
            {t("registerHeroCta")}
          </button>
          <a
            href="/login"
            className="bg-white hover:bg-panel2 text-zinc-900 font-medium rounded-full px-6 py-3 text-sm border border-edge transition-colors"
          >
            {t("registerLoginNav")}
          </a>
        </div>
      </div>

      {/* Dark showcase band — horizontally auto-scrolling strip of real
          analyzed-video thumbnails. Sits right under the hero as a quick
          "proof" beat, mirroring where Packify puts its trust strip. */}
      <div className="bg-zinc-900 py-14 mt-6 overflow-hidden">
        <div className="max-w-3xl mx-auto text-center px-6 mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold text-white">{t("registerShowcaseHeadline")}</h2>
          <p className="mt-2 text-sm text-zinc-400">{t("registerShowcaseSubtitle")}</p>
        </div>
        <div className="flex w-max animate-marquee gap-4 px-4">
          {stripImages.map((src, i) => (
            <ThumbCard key={i} src={src} className="w-28 sm:w-32" borderClassName="border-zinc-700" />
          ))}
        </div>
      </div>

      {/* How it works — 3 numbered steps. */}
      <div className="max-w-5xl mx-auto px-6 py-20">
        <h2 className="text-2xl sm:text-3xl font-bold text-zinc-900 text-center mb-14">
          {t("registerHowHeadline")}
        </h2>
        <div className="grid sm:grid-cols-3 gap-10">
          {HOW_STEPS.map((step, i) => (
            <div key={step.titleKey}>
              <div className="w-10 h-10 rounded-full bg-zinc-900 text-white flex items-center justify-center font-bold text-sm mb-4">
                {i + 1}
              </div>
              <h3 className="text-base font-semibold text-zinc-900 mb-2">{t(step.titleKey)}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{t(step.bodyKey)}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Feature grid — "one platform" style card grid. */}
      <div className="bg-panel py-20">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-zinc-900 text-center mb-14">
            {t("registerFeaturesHeadline")}
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map((f) => (
              <div key={f.titleKey} className="bg-white border border-edge rounded-2xl p-6">
                <div className="text-2xl mb-3">{f.icon}</div>
                <h3 className="text-sm font-semibold text-zinc-900 mb-1.5">{t(f.titleKey)}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{t(f.bodyKey)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Final CTA — Spyglass.so-style split: a floating grid of real
          analyzed-video thumbnails on the left, the actual conversion point
          (headline + sign-up form) on the right. Previously this was two
          separate centered sections (a CTA banner, then the form below it)
          — merged + moved side-by-side per the reference. */}
      <div id="register-form" className="max-w-6xl mx-auto px-6 py-20 scroll-mt-24">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div className="hidden lg:block">
            <FloatingShowcaseGrid videos={floatingVideos} t={t} />
          </div>
          <div className="text-center lg:text-left">
            <h2 className="text-2xl sm:text-4xl font-black tracking-tight text-zinc-900 mb-3 leading-tight">
              {t("registerFinalCtaHeadline")}
            </h2>
            <p className="text-base text-zinc-500 mb-8">{t("registerFinalCtaSubtitle")}</p>
            <div className="flex justify-center lg:justify-start">
              <div className="w-full max-w-sm">
                <p className="text-xs font-bold tracking-wide text-brand-500 uppercase mb-3 text-center lg:text-left">
                  {t("registerSignUpNowLabel")}
                </p>
                <div
                  className={`rounded-2xl transition-shadow duration-300 ${
                    pulseForm ? "ring-4 ring-brand-400 ring-offset-2" : ""
                  }`}
                >
                  <Suspense fallback={null}>
                    <RegisterForm />
                  </Suspense>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
