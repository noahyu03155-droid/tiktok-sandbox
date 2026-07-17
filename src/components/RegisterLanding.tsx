"use client";

// Register page redesign — styled after a reference SaaS landing page the
// user liked: a floating pill navbar, a big bold headline with an italic
// accent line + the actual sign-up form right in the hero (under a "Sign up
// now" label, previously a fanned deck of thumbnails — replaced so a visitor
// can register without scrolling), then a dark "showcase" band with a
// horizontally auto-scrolling strip of real thumbnails. Since this account's
// job eventually is to be sold as a paid subscription, the whole page is
// meant to read as a proper marketing/landing page rather than a bare login
// box. This is also now the app's default entry point for anyone without a
// session — see middleware.ts, which sends unauthenticated visits here
// instead of /login (still reachable via the navbar's "Log in" link).
//
// The showcase strip's thumbnails are REAL images already fetched/cached by
// this app's own TikTok pipeline (see the server component in
// src/app/register/page.tsx, which reads them via listVideos()) — not
// anything scraped from a reference site. If the install is brand new and
// hasn't analyzed any videos yet, it falls back to plain gradient tiles so
// the page never looks broken.
import { Suspense } from "react";
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

  const stripSource = thumbnails.length > 0 ? thumbnails : new Array(10).fill(null);
  // Doubled so the CSS animation (translateX -50%) loops seamlessly.
  const stripImages = [...stripSource, ...stripSource];

  return (
    <div className="min-h-screen bg-ink">
      {/* Floating pill navbar */}
      <div className="sticky top-4 z-30 px-4">
        <div className="max-w-5xl mx-auto flex items-center gap-4 bg-white/90 backdrop-blur border border-edge rounded-full shadow-lg shadow-zinc-900/5 px-5 py-2.5">
          <Logo size="sm" />
          <div className="ml-auto flex items-center gap-3">
            <LanguageToggle />
            <a href="/login" className="text-sm text-zinc-600 hover:text-zinc-900 font-medium">
              {t("registerLoginNav")}
            </a>
            <a
              href="#register-form"
              className="text-sm bg-zinc-900 hover:bg-black text-white font-medium rounded-full px-4 py-2 transition-colors whitespace-nowrap"
            >
              {t("registerHeroCta")}
            </a>
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="max-w-5xl mx-auto px-6 pt-16 pb-20 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-zinc-900 leading-[1.05]">
            <span>{t("registerHeroHeadline1")}</span>
            <br />
            <span className="italic font-serif font-medium text-zinc-500">{t("registerHeroHeadline2")}</span>
          </h1>
          <p className="mt-6 text-base text-zinc-500 leading-relaxed max-w-md">{t("registerHeroSubtitle")}</p>
          <a
            href="#register-form"
            className="mt-8 inline-block bg-zinc-900 hover:bg-black text-white font-medium rounded-full px-6 py-3 text-sm transition-colors"
          >
            {t("registerHeroCta")}
          </a>
        </div>

        {/* Sign-up form, right in the hero — replaces the old fanned thumbnail
            deck so a visitor can register without scrolling at all. */}
        <div id="register-form" className="flex items-center justify-center lg:justify-end scroll-mt-24">
          <div className="w-full max-w-sm">
            <p className="text-xs font-bold tracking-wide text-brand-500 uppercase mb-3 text-center lg:text-left">
              {t("registerSignUpNowLabel")}
            </p>
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
