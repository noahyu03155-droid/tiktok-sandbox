"use client";

import Link from "next/link";
import { useState } from "react";
import { useLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/translations";
import type { AccessTier } from "@/lib/types";
import UserKeywordGraph from "./UserKeywordGraph";
import type { ProfileBranch } from "@/lib/userGraph";

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

const TIERS: AccessTier[] = ["starter", "pro", "business"];

const TIER_LABEL_KEY: Record<AccessTier, TranslationKey> = {
  starter: "userDataTierStarter",
  pro: "userDataTierPro",
  business: "userDataTierBusiness",
};

const TIER_HINT_KEY: Record<AccessTier, TranslationKey> = {
  starter: "userDataTierStarterHint",
  pro: "userDataTierProHint",
  business: "userDataTierBusinessHint",
};

// Starter/Pro/Business tier selector (names match the 3 billing plans — see
// AccessTier's doc comment in src/lib/types.ts; src/lib/accessTier.ts for
// what each unlocks). Explicit two-step select-then-Save (was save-on-click
// with no visible confirmation): since setting a tier now also ACTIVATES
// the same-named billing plan for the member (see the tier route's doc
// comment), the admin should get an unmistakable "this took effect" moment
// — pick a chip, hit Save, see "✓ Saved — plan activated".
function TierSelector({ userId, initialTier }: { userId: string; initialTier: AccessTier | null }) {
  const { t } = useLocale();
  const [tier, setTier] = useState<AccessTier | null>(initialTier);
  const [savedTier, setSavedTier] = useState<AccessTier | null>(initialTier);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = tier !== savedTier;

  async function save() {
    if (!dirty || saving || tier === null) return;
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const res = await fetch(`/api/user-data/${userId}/tier`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessTier: tier }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed");
      setSavedTier(tier);
      setJustSaved(true);
    } catch {
      setError(t("userDataTierUpdateFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-6">
      <p className="text-xs font-medium text-zinc-500 mb-2">{t("userDataTierLabel")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {TIERS.map((option) => {
          const active = (tier || "business") === option;
          return (
            <button
              key={option}
              type="button"
              onClick={() => {
                setTier(option);
                setJustSaved(false);
              }}
              disabled={saving}
              title={t(TIER_HINT_KEY[option])}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors disabled:opacity-60 ${
                active
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-panel text-zinc-600 border-edge hover:border-zinc-400"
              }`}
            >
              {t(TIER_LABEL_KEY[option])}
            </button>
          );
        })}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="text-xs px-4 py-1.5 rounded-full font-medium text-white bg-brand-500 hover:bg-brand-600 disabled:opacity-40 transition-colors"
        >
          {saving ? "…" : t("userDataTierSave")}
        </button>
        {justSaved && !dirty && <span className="text-xs text-emerald-600">{t("userDataTierSaved")}</span>}
      </div>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  );
}

export default function UserKeywordGraphPageContent({
  userId,
  username,
  joinedAt,
  projectCount,
  lastActiveAt,
  accessTier,
  branches,
  customTags,
  graphPositions,
  graphParentOverrides,
}: {
  userId: string;
  username: string;
  joinedAt: string;
  projectCount: number;
  lastActiveAt: string | null;
  accessTier: AccessTier | null;
  branches: ProfileBranch[];
  customTags: { id: string; label: string; createdAt: string }[];
  graphPositions: Record<string, { x: number; y: number }>;
  graphParentOverrides: Record<string, string>;
}) {
  const { t } = useLocale();
  return (
    <div>
      <Link href="/user-data" className="text-xs text-zinc-500 hover:text-zinc-700 mb-4 inline-block">
        {t("userDataBackToList")}
      </Link>
      <h1 className="text-xl font-semibold text-zinc-900 mb-1">@{username}</h1>
      <p className="text-xs text-zinc-500 mb-4">
        {t("userDataJoinedAt", { date: formatDate(joinedAt) })}
        {" · "}
        {t("userDataProjectCount", { count: projectCount })}
        {lastActiveAt && (
          <>
            {" · "}
            {t("userDataLastActive", { date: formatDate(lastActiveAt) })}
          </>
        )}
      </p>
      <TierSelector userId={userId} initialTier={accessTier} />
      <UserKeywordGraph
        userId={userId}
        username={username}
        branches={branches}
        customTags={customTags}
        graphPositions={graphPositions}
        graphParentOverrides={graphParentOverrides}
      />
    </div>
  );
}
