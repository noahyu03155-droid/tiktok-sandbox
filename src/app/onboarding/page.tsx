"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/translations";
import Logo from "@/components/Logo";

// Each option pairs a stored `value` (never shown to the user, never sent
// anywhere but useful for the "other" occupation special-case below) with
// a `labelKey` translation key — avoids constructing dynamic `t()` keys
// (which would need `as any` casts and lose type-checking).
const AGE_RANGES: { value: string; labelKey: TranslationKey }[] = [
  { value: "under18", labelKey: "onboardingAgeUnder18" },
  { value: "18to24", labelKey: "onboardingAge18to24" },
  { value: "25to34", labelKey: "onboardingAge25to34" },
  { value: "35to44", labelKey: "onboardingAge35to44" },
  { value: "45to54", labelKey: "onboardingAge45to54" },
  { value: "over55", labelKey: "onboardingAgeOver55" },
];

const OCCUPATIONS: { value: string; labelKey: TranslationKey }[] = [
  { value: "student", labelKey: "onboardingOccupationStudent" },
  { value: "office", labelKey: "onboardingOccupationOffice" },
  { value: "freelance", labelKey: "onboardingOccupationFreelance" },
  { value: "fulltimeCreator", labelKey: "onboardingOccupationFulltimeCreator" },
  { value: "parent", labelKey: "onboardingOccupationParent" },
  { value: "other", labelKey: "onboardingOccupationOther" },
];

const EXPERIENCE_LEVELS: { value: string; labelKey: TranslationKey }[] = [
  { value: "none", labelKey: "onboardingExperienceNone" },
  { value: "few", labelKey: "onboardingExperienceFew" },
  { value: "some", labelKey: "onboardingExperienceSome" },
  { value: "veteran", labelKey: "onboardingExperienceVeteran" },
];

const CONTENT_STYLES: { value: string; labelKey: TranslationKey }[] = [
  { value: "review", labelKey: "onboardingStyleReview" },
  { value: "comedy", labelKey: "onboardingStyleComedy" },
  { value: "expert", labelKey: "onboardingStyleExpert" },
  { value: "skit", labelKey: "onboardingStyleSkit" },
  { value: "aesthetic", labelKey: "onboardingStyleAesthetic" },
];

function OnboardingForm() {
  const { t } = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [ageRange, setAgeRange] = useState<string | null>(null);
  const [occupation, setOccupation] = useState<string | null>(null);
  const [occupationOther, setOccupationOther] = useState("");
  const [interests, setInterests] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<string | null>(null);
  const [contentStyle, setContentStyle] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function goNext() {
    router.push(next);
    router.refresh();
  }

  function labelFor(list: { value: string; labelKey: TranslationKey }[], value: string | null): string | null {
    if (!value) return null;
    const found = list.find((o) => o.value === value);
    return found ? t(found.labelKey) : null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ageRange: labelFor(AGE_RANGES, ageRange),
          occupation: occupation === "other" ? occupationOther.trim() || null : labelFor(OCCUPATIONS, occupation),
          interests: interests.trim() || null,
          experienceLevel: labelFor(EXPERIENCE_LEVELS, experienceLevel),
          contentStyle: labelFor(CONTENT_STYLES, contentStyle),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }
      goNext();
    } catch (err: any) {
      setError(err.message || "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  function OptionGroup({
    options,
    value,
    onChange,
  }: {
    options: { value: string; labelKey: TranslationKey }[];
    value: string | null;
    onChange: (v: string) => void;
  }) {
    return (
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            type="button"
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              value === opt.value
                ? "bg-brand-500 border-brand-500 text-white"
                : "border-edge text-zinc-500 hover:text-zinc-900 hover:border-edge2"
            }`}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-md bg-panel border border-edge rounded-xl p-6">
      <div className="mb-6">
        <Logo />
        <p className="text-xs text-zinc-500 mt-2">{t("onboardingTitle")}</p>
        <p className="text-[11px] text-zinc-600 mt-1">{t("onboardingHint")}</p>
      </div>

      <div className="space-y-5 mb-6">
        <div>
          <label className="block text-xs text-zinc-500 mb-2">{t("onboardingAgeLabel")}</label>
          <OptionGroup options={AGE_RANGES} value={ageRange} onChange={setAgeRange} />
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-2">{t("onboardingOccupationLabel")}</label>
          <OptionGroup options={OCCUPATIONS} value={occupation} onChange={setOccupation} />
          {occupation === "other" && (
            <input
              value={occupationOther}
              onChange={(e) => setOccupationOther(e.target.value)}
              placeholder={t("onboardingOccupationOtherPlaceholder")}
              className="mt-2 w-full px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
            />
          )}
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-2">{t("onboardingInterestsLabel")}</label>
          <input
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            placeholder={t("onboardingInterestsPlaceholder")}
            className="w-full px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
          />
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-2">{t("onboardingExperienceLabel")}</label>
          <OptionGroup options={EXPERIENCE_LEVELS} value={experienceLevel} onChange={setExperienceLevel} />
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-2">{t("onboardingStyleLabel")}</label>
          <OptionGroup options={CONTENT_STYLES} value={contentStyle} onChange={setContentStyle} />
        </div>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
      >
        {submitting ? t("onboardingSaving") : t("onboardingSubmit")}
      </button>
      <button
        type="button"
        onClick={goNext}
        className="w-full py-2 mt-2 text-xs text-zinc-500 hover:text-zinc-700 transition-colors"
      >
        {t("onboardingSkip")}
      </button>
    </form>
  );
}

export default function OnboardingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ink px-4">
      <Suspense fallback={null}>
        <OnboardingForm />
      </Suspense>
    </div>
  );
}
