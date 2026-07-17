"use client";

// Register page redesign — styled after a reference SaaS landing page the
// user liked: a floating pill navbar, a big bold headline with an italic
// accent line + a fanned deck of real video thumbnails on the right, then a
// dark "showcase" band with a horizontally auto-scrolling strip of more real
// thumbnails, and finally the actual sign-up form. Since this account's job
// eventually is to be sold as a paid subscription, the whole page is meant
// to read as a proper marketing/landing page rather than a bare login box.
//
// The thumbnails are REAL images already fetched/cached by this app's own
// TikTok pipeline (see the server component in src/app/register/page.tsx,
// which reads them via listVideos()) — not anything scraped from a
// reference site. If the install is brand new and hasn't analyzed any
// videos yet, both the deck and the strip fall back to plain gradient tiles
// so the page never looks broken.
import { Suspense } from "react";
import { useLocale } from "@/lib/i18n";
import Logo from "@/components/Logo";
import LanguageToggle from "@/components/LanguageToggle";
import RegisterForm from "@/components/RegisterForm";

// Fanned-deck placement for up to 5 cards — hand-tuned offsets/rotations so
// they read as a loosely shuffled stack, same visual idea as the reference.
const DECK_LAYOUT = [
  { x: -40, y: 40, rotate: -8, z: 1 },
  { x: 30, y: 70, rotate: 6, z: 2 },
  { x: -10, y: 10, rotate: -3, z: 3 },
  { x: 70, y: 20, rotate: 9, z: 2 },
  { x: 10, y: -20, rotate: -12, z: 1 },
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

export default function RegisterLanding({ thumbnails }: { thumbnails: string[] }) {
  const { t } = useLocale();

  const deckImages = thumbnails.slice(0, 5);
  // Pad the deck with nulls (renders a gradient placeholder tile) so the
  // fanned layout always has 5 cards even on a fresh install with little/no
  // cached video data yet.
  while (deckImages.length < 5) deckImages.push(null as unknown as string);

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

        {/* Fanned deck of real analyzed-video thumbnails */}
        <div className="relative h-[380px] sm:h-[440px] flex items-center justify-center lg:justify-end">
          <div className="relative w-56 h-full">
            {deckImages.map((src, i) => {
              const layout = DECK_LAYOUT[i];
              return (
                <ThumbCard
                  key={i}
                  src={src}
                  className="absolute w-36 sm:w-40 left-1/2 top-1/2"
                  style={{
                    zIndex: layout.z,
                    transform: `translate(-50%, -50%) translate(${layout.x}px, ${layout.y}px) rotate(${layout.rotate}deg)`,
                  }}
                />
              );
            })}
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

      {/* Sign-up form */}
      <div id="register-form" className="flex items-center justify-center px-4 py-20 scroll-mt-24">
        <Suspense fallback={null}>
          <RegisterForm />
        </Suspense>
      </div>
    </div>
  );
}
