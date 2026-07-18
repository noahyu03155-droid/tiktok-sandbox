"use client";

// Register page — this is the app's default entry point for anyone without
// a session (see middleware.ts, which sends unauthenticated visits here
// instead of /login; still reachable via the navbar's "Log in" link), so
// it's meant to read as a proper marketing/landing page rather than a bare
// login box, since the account is eventually sold as a paid subscription.
//
// Phase 41: rebuilt the hero to match a reference the user pointed to
// (Packify.ai) — plain borderless white navbar, a CENTERED headline with a
// gradient-colored accent line, a centered subtitle, and two centered pill
// CTAs (a solid black primary + an outlined secondary), instead of the
// earlier two-column split + thick black frame from Phases 35/39. The
// actual sign-up form still sits directly below the hero (not a separate
// page) so a visitor can register without much scrolling — just no longer
// crammed side-by-side with the headline.
//
// The showcase strip's thumbnails are REAL images already fetched/cached by
// this app's own TikTok pipeline (see the server component in
// src/app/register/page.tsx, which reads them via listVideos()) — not
// anything scraped from a reference site. If the install is brand new and
// hasn't analyzed any videos yet, it falls back to plain gradient tiles so
// the page never looks broken.
import { Suspense, useState } from "react";
import { useLocale } from "@/lib/i18n";
import Logo from "@/components/Logo";
import LanguageToggle from "@/components/LanguageToggle";
import RegisterForm from "@/components/RegisterForm";

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

export default function RegisterLanding({ thumbnails }: { thumbnails: string[] }) {
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

  const stripSource = thumbnails.length > 0 ? thumbnails : new Array(10).fill(null);
  // Doubled so the CSS animation (translateX -50%) loops seamlessly.
  const stripImages = [...stripSource, ...stripSource];

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

      {/* Sign-up form, directly below the hero — a visitor can register
          without much scrolling, but no longer crammed side-by-side with
          the headline (see Phase 41 note at the top of this file). */}
      <div id="register-form" className="flex items-center justify-center px-4 pt-10 pb-20 scroll-mt-24">
        <div className="w-full max-w-sm">
          <p className="text-xs font-bold tracking-wide text-brand-500 uppercase mb-3 text-center">
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

      {/* Dark showcase band — horizontally auto-scrolling strip of real
          analyzed-video thumbnails. */}
      <div className="bg-zinc-900 py-14 overflow-hidden">
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
    </div>
  );
}
