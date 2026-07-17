"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/translations";
import Logo from "@/components/Logo";

// Each option pairs a stored `value` (never shown to the user or sent
// anywhere) with a `labelKey` translation key — avoids constructing dynamic
// `t()` keys (which would need `as any` casts and lose type-checking).
const AGE_RANGES: { value: string; labelKey: TranslationKey }[] = [
  { value: "under18", labelKey: "onboardingAgeUnder18" },
  { value: "18to24", labelKey: "onboardingAge18to24" },
  { value: "25to34", labelKey: "onboardingAge25to34" },
  { value: "35to44", labelKey: "onboardingAge35to44" },
  { value: "45to54", labelKey: "onboardingAge45to54" },
  { value: "over55", labelKey: "onboardingAgeOver55" },
];

// Occupation is a searchable free-text field, not a fixed button grid —
// these are just suggestions surfaced while typing. Whatever the user types
// (matched or not) IS the occupation; nothing forces a pick from this list.
const OCCUPATION_SUGGESTIONS_EN = [
  "Student", "Teacher", "Nurse", "Software Engineer", "Marketing Manager",
  "Small Business Owner", "Full-time Content Creator", "Stay-at-home Parent",
  "Retail Worker", "Freelance Designer", "Sales Representative", "Real Estate Agent",
  "Financial Analyst", "Chef", "Personal Trainer", "Veterinarian", "Graphic Designer",
  "Photographer", "Consultant", "Engineer", "Accountant", "Lawyer", "Doctor",
  "Pharmacist", "Electrician", "Plumber", "Construction Worker", "Truck Driver",
  "Flight Attendant", "Barista / Bartender", "Hairstylist / Esthetician",
  "Social Media Manager", "HR Manager", "Data Analyst", "Product Manager",
  "Office Worker", "Freelancer", "Retired", "Between Jobs",
];
const OCCUPATION_SUGGESTIONS_ZH = [
  "学生", "教师", "护士", "软件工程师", "市场经理", "个体户/小生意主",
  "全职带货/内容创作", "宝妈/家庭主妇", "零售/门店员工", "自由设计师", "销售",
  "房产经纪人", "金融分析师", "厨师", "私人教练", "兽医", "平面设计师", "摄影师",
  "顾问", "工程师", "会计", "律师", "医生", "药剂师", "电工", "水管工", "建筑工人",
  "货车司机", "空乘", "咖啡师/调酒师", "美发师/美容师", "社媒运营", "人力资源",
  "数据分析师", "产品经理", "上班族", "自由职业", "退休", "待业中",
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
  const { t, locale } = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [ageRange, setAgeRange] = useState<string | null>(null);
  const [occupation, setOccupation] = useState("");
  const [occupationFocused, setOccupationFocused] = useState(false);
  const [interests, setInterests] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<string | null>(null);
  const [contentStyle, setContentStyle] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const occupationSuggestions = locale === "zh" ? OCCUPATION_SUGGESTIONS_ZH : OCCUPATION_SUGGESTIONS_EN;
  const filteredOccupations = occupation.trim()
    ? occupationSuggestions.filter((o) => o.toLowerCase().includes(occupation.trim().toLowerCase())).slice(0, 8)
    : occupationSuggestions.slice(0, 8);

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
          occupation: occupation.trim() || null,
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

        <div className="relative">
          <label className="block text-xs text-zinc-500 mb-2">{t("onboardingOccupationLabel")}</label>
          <input
            value={occupation}
            onChange={(e) => setOccupation(e.target.value)}
            onFocus={() => setOccupationFocused(true)}
            onBlur={() => setTimeout(() => setOccupationFocused(false), 150)} // delay so a suggestion click registers before the list unmounts
            placeholder={t("onboardingOccupationSearchPlaceholder")}
            className="w-full px-3 py-2 rounded-lg bg-panel2 border border-edge text-zinc-900 text-sm outline-none focus:border-brand-500"
          />
          {occupationFocused && filteredOccupations.length > 0 && (
            <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-edge bg-panel shadow-lg">
              {filteredOccupations.map((opt) => (
                <button
                  type="button"
                  key={opt}
                  onMouseDown={() => setOccupation(opt)}
                  className="w-full text-left px-3 py-1.5 text-sm text-zinc-700 hover:bg-panel2"
                >
                  {opt}
                </button>
              ))}
            </div>
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
