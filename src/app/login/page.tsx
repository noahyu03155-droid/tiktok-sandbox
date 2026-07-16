"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import Logo from "@/components/Logo";

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
    <form onSubmit={handleSubmit} className="w-full max-w-sm bg-panel border border-edge rounded-xl p-6">
      <div className="mb-6">
        <Logo />
        <p className="text-xs text-zinc-500 mt-2">{t("loginTitle")}</p>
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
        <a href="/register" className="text-brand-400 hover:text-brand-300 underline">
          {t("registerLink")}
        </a>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ink px-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
