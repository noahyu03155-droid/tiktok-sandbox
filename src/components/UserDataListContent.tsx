"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/translations";
import type { AccessTier } from "@/lib/types";

interface MemberSummary {
  id: string;
  username: string;
  createdAt: string;
  hasProfile: boolean;
  preferredCategoryLabel: string | null;
  accessTier: AccessTier | null;
}

// Colors echo the plan accent hexes on the /pricing cards (src/lib/billing.ts)
// so a tag here reads as "the same Starter/Pro/Business" at a glance.
const TIER_BADGE_STYLE: Record<AccessTier, string> = {
  starter: "bg-pink-500/10 text-pink-500",
  pro: "bg-rose-500/10 text-rose-500",
  business: "bg-purple-500/10 text-purple-500",
};

const TIER_LABEL_KEY: Record<AccessTier, TranslationKey> = {
  starter: "userDataTierStarter",
  pro: "userDataTierPro",
  business: "userDataTierBusiness",
};

// Admin-only grid of every member account — mirrors the styling of the
// existing member-folders grid on /creation (src/components/CreationPageContent.tsx)
// for visual consistency, but links into /user-data/[id]'s keyword graph
// instead of a project list. A search box lets the admin jump straight to
// one member's folder by username instead of scrolling the whole grid —
// pure client-side filter since the full member list is already fetched.
export default function UserDataListContent({ members }: { members: MemberSummary[] }) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.username.toLowerCase().includes(q));
  }, [members, query]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900 mb-1">{t("userDataHeading")}</h1>
      <p className="text-sm text-zinc-500 mb-4">{t("userDataHeadingHint")}</p>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("userDataSearchPlaceholder")}
        className="w-full max-w-xs mb-6 rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-400"
      />
      {members.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("userDataEmpty")}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("userDataSearchEmpty")}</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((m) => (
            <Link
              key={m.id}
              href={`/user-data/${m.id}`}
              className="rounded-xl border border-edge bg-panel p-4 hover:border-brand-500 transition-colors block"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="w-10 h-10 rounded-full bg-panel2 flex items-center justify-center text-zinc-700 text-sm font-semibold">
                  {m.username.slice(0, 1).toUpperCase()}
                </div>
                {m.accessTier && (
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${TIER_BADGE_STYLE[m.accessTier]}`}>
                    {t(TIER_LABEL_KEY[m.accessTier])}
                  </span>
                )}
              </div>
              <p className="text-sm font-medium text-zinc-900 truncate">@{m.username}</p>
              {m.preferredCategoryLabel && (
                <p className="text-[11px] text-zinc-500 mt-1 truncate">{m.preferredCategoryLabel}</p>
              )}
              <p className={`text-[11px] mt-1 ${m.hasProfile ? "text-emerald-400" : "text-zinc-600"}`}>
                {m.hasProfile ? t("userDataProfileComplete") : t("userDataProfileIncomplete")}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
