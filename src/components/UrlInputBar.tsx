"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/lib/i18n";

export default function UrlInputBar({ onQueued }: { onQueued?: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { t } = useLocale();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submit failed");
      setUrl("");
      onQueued?.(data.id);
      router.refresh();
    } catch (err: any) {
      setError(err.message || "Submit failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex gap-2 bg-panel border border-edge rounded-xl p-2 focus-within:border-brand-500 transition-colors">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("pastePlaceholder")}
          className="flex-1 bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
        />
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="px-5 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors whitespace-nowrap"
        >
          {loading ? t("submitting") : t("startBreakdown")}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </form>
  );
}
