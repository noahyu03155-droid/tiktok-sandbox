"use client";

import { useLocale } from "@/lib/i18n";

export default function LanguageToggle() {
  const { locale, toggleLocale } = useLocale();

  return (
    <button
      onClick={toggleLocale}
      className="text-xs text-zinc-500 hover:text-zinc-900 border border-edge rounded-full px-3 py-1.5 transition-colors"
      title="Switch language / 切换语言"
    >
      {locale === "en" ? "中文" : "EN"}
    </button>
  );
}
