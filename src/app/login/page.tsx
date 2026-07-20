"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import Logo from "@/components/Logo";
import SloganFlow from "@/components/SloganFlow";

function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useLocale();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      const next = searchParams.get("next") || "/";
      router.push(next);
      router.refresh();
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm bg-panel/95 backdrop-blur-sm border border-edge rounded-xl p-6 shadow-2xl shadow-black/40">
      <div className="mb-6">
        <Logo />
        <p className="text-xs text-zinc-500 mt-2">{t("loginTitle")}</p>
        <SloganFlow size="sm" className="mt-3" />
      </div>
      <label className="block text-xs text-zinc-500 mb-1">{t("usernameLabel")}</label>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full mb-3 px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
        autoFocus
      />
      <label className="block text-xs text-zinc-500 mb-1">{t("passwordLabel")}</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full mb-4 px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
      />
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
      >
        {loading ? t("loggingIn") : t("loginButton")}
      </button>
      <p className="text-xs text-zinc-500 mt-4 text-center">
        {t("noAccountYet")}{" "}
        {/* Jumps straight to the sign-up form section instead of the top of
            the marketing landing page — see RegisterLanding.tsx's
            #register-form scroll-on-mount effect for why this is a hash
            link rather than relying on native browser anchor scrolling. */}
        <a href="/register#register-form" className="text-brand-400 hover:text-brand-300 underline">
          {t("registerLink")}
        </a>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-ink px-4 overflow-hidden">
      {/* Looping, blurred backdrop of a creator filming — purely ambiance
          behind the login card, not interactive. object-cover fills the
          viewport regardless of aspect ratio; scale-110 hides the soft
          edge the blur filter would otherwise leave visible at the video's
          actual boundary. Muted+playsInline is required for autoplay to be
          allowed on mobile browsers. Hotlinked from Pexels (free-to-use,
          no attribution required per their license) rather than bundled
          into the repo, so there's no extra asset to ship/host ourselves. */}
      <video
        autoPlay
        muted
        loop
        playsInline
        poster="https://images.pexels.com/videos/7482042/pexels-photo-7482042.jpeg?auto=compress&cs=tinysrgb&w=1600"
        className="absolute inset-0 w-full h-full object-cover scale-110 blur-md brightness-[0.55] saturate-[0.85]"
      >
        <source src="https://videos.pexels.com/video-files/7482042/7482042-uhd_1440_2560_25fps.mp4" type="video/mp4" />
      </video>
      {/* Dark + brand-tinted gradient wash on top of the blur for contrast
          and a bit of tech/premium color, same navy-to-black direction as
          the rest of the app's dark surfaces. */}
      <div className="absolute inset-0 bg-gradient-to-b from-ink/70 via-ink/60 to-ink/85" />
      <div className="absolute inset-0 bg-gradient-to-tr from-sky-500/10 via-transparent to-purple-500/10" />
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
