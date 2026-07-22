"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PLANS, BILLING_CYCLES, planCyclePrice, seatCyclePrice } from "@/lib/billing";
import type { PlanId, BillingCycle } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import LogoutButton from "./LogoutButton";
import LanguageToggle from "./LanguageToggle";
import SloganFlow from "./SloganFlow";

// The gate every non-admin account has to clear before reaching the rest of
// the app (see src/middleware.ts's billing check) — reachable either right
// after registration (RegisterForm -> /onboarding -> here) or any time
// later via the same redirect if a plan lapses. Layout mirrors the
// reference screenshot the user provided (billing-cycle tabs across the
// top, 3 plan cards with a colored header band, struck-through original
// price + cycle discount, a seat +/- stepper, grouped feature checklist,
// bottom CTA) — the plan data itself comes from src/lib/billing.ts, the
// same source of truth /api/billing/select-plan validates against
// server-side, so nothing here can drift from what actually gets charged.
export default function PricingPageContent({
  currentPlan,
  currentBillingCycle,
  currentSeats,
  planStatus,
}: {
  currentPlan: PlanId | null;
  currentBillingCycle: BillingCycle | null;
  currentSeats: number;
  planStatus: "active" | "none" | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";
  const { locale } = useLocale();
  const zh = locale === "zh";

  // Small local copy table for the page chrome (headings, buttons, errors)
  // — the plan/feature data itself lives in src/lib/billing.ts (nameZh/
  // nameEn etc.) since that's shared with server-side validation; this is
  // just page-only strings, so it doesn't need to go through the global
  // translations.ts dictionary.
  const copy = {
    heading: zh ? "选择适合你的方案" : "Choose the plan that fits you",
    subheading: zh
      ? "解锁视频拆解、AI 脚本生成、分镜画布、手动剪辑等全部功能"
      : "Unlock video breakdowns, AI script generation, storyboard canvas, and manual editing",
    save: zh ? "省" : "Save ",
    perMonth: zh ? "/月" : "/mo",
    billedMonthly: zh ? "按月计费" : "Billed monthly",
    billedTotal: (label: string, total: number) => (zh ? `${label}共 $${total}` : `${label} total $${total}`),
    seatsLabel: (n: number) => (zh ? `额外席位（含 ${n} 个基础席位）` : `Extra seats (${n} included)`),
    seatPricePerMonth: (p: number) => (zh ? `+$${p}/月/人` : `+$${p}/mo/seat`),
    noExtraSeats: zh ? "不支持加购" : "Not addable",
    noExtraSeatsTooltip: zh ? "该方案不支持加购子账号，仅旗舰版支持加购" : "This plan doesn't support extra seats — only Business does",
    currentPlan: zh ? "当前方案" : "Current plan",
    purchasing: zh ? "购买中…" : "Processing…",
    switchPlan: zh ? "切换到此方案" : "Switch to this plan",
    buyNow: zh ? "立即购买" : "Buy now",
    footer: zh
      ? "价格以美元计，随时可在此页面切换方案或调整席位。如需更大用量或专属功能，请联系我们定制方案。"
      : "Prices in USD. Switch plans or adjust seats here anytime. Need more volume or custom features? Contact us.",
    purchaseFailed: zh ? "购买失败，请重试" : "Purchase failed, please try again",
    networkError: zh ? "网络错误，请重试" : "Network error, please try again",
  };

  const [cycleId, setCycleId] = useState<BillingCycle>(currentBillingCycle || "annual");
  const [seatsByPlan, setSeatsByPlan] = useState<Record<PlanId, number>>({
    starter: 0,
    pro: currentPlan === "pro" ? currentSeats : 0,
    business: currentPlan === "business" ? currentSeats : 0,
  });
  const [purchasingPlan, setPurchasingPlan] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Promo / affiliate code — validated server-side (/api/promo-codes/
  // validate, plan-gate-exempt) before it's shown as applied; the ACTUAL
  // discount is recomputed server-side again at purchase, so nothing here
  // is trusted for money math. Applied code discounts every displayed
  // price via `discounted()` below so the buyer sees real numbers.
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<{ code: string; percentOff: number; kind: string; trialDays?: number } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  async function applyPromo() {
    const code = promoInput.trim();
    if (!code) return;
    setPromoChecking(true);
    setPromoError(null);
    try {
      const res = await fetch("/api/promo-codes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.valid) throw new Error(data.error || (zh ? "无效的优惠码" : "Invalid code"));
      setPromo({ code: data.code, percentOff: data.percentOff, kind: data.kind, trialDays: data.trialDays });
    } catch (e: any) {
      setPromo(null);
      setPromoError(e.message || (zh ? "无效的优惠码" : "Invalid code"));
    } finally {
      setPromoChecking(false);
    }
  }

  const discounted = (v: number) => (promo ? Math.round(v * (1 - promo.percentOff / 100)) : v);

  // Self-heal a stale paywall: if an admin granted this account a plan from
  // the User Data page (DB active, but this browser's cookie still says
  // planActive=false), refresh-session re-signs the cookie and we leave the
  // pricing page immediately — no re-login, no fake "purchase" needed.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/billing/refresh-session", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.active) {
          router.push(next);
          router.refresh();
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cycle = BILLING_CYCLES.find((c) => c.id === cycleId) || BILLING_CYCLES[0];

  function adjustSeats(planId: PlanId, delta: number) {
    setSeatsByPlan((cur) => {
      const plan = PLANS.find((p) => p.id === planId);
      if (!plan) return cur;
      const nextVal = Math.max(0, Math.min(plan.maxExtraSeats, (cur[planId] || 0) + delta));
      return { ...cur, [planId]: nextVal };
    });
  }

  async function purchase(planId: PlanId) {
    setPurchasingPlan(planId);
    setError(null);
    try {
      const res = await fetch("/api/billing/select-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planId, billingCycle: cycleId, seats: seatsByPlan[planId] || 0, promoCode: promo?.code || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || copy.purchaseFailed);
        setPurchasingPlan(null);
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError(copy.networkError);
      setPurchasingPlan(null);
    }
  }

  return (
    <div className="min-h-screen bg-ink py-10 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-end items-center gap-2 mb-2">
          <LanguageToggle />
          <LogoutButton />
        </div>
        <div className="text-center mb-8">
          <h1 className="text-2xl md:text-3xl font-semibold text-zinc-900">{copy.heading}</h1>
          <p className="text-sm text-zinc-500 mt-2">{copy.subheading}</p>
          <SloganFlow size="sm" className="mt-4" />
        </div>

        {/* billing cycle tabs */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex rounded-full border border-edge bg-panel p-1 gap-1">
            {BILLING_CYCLES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCycleId(c.id)}
                className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${
                  cycleId === c.id ? "bg-pawpink-500 text-white shadow" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {zh ? c.labelZh : c.labelEn}
                {c.discount > 0 && (
                  <span className={`ml-1.5 text-[10px] ${cycleId === c.id ? "text-white/80" : "text-pawpink-500"}`}>
                    {copy.save}{Math.round(c.discount * 100)}%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Promo / affiliate code entry — one code applies page-wide. */}
        <div className="flex justify-center items-center gap-2 mb-6 flex-wrap">
          <input
            value={promoInput}
            onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && applyPromo()}
            placeholder={zh ? "优惠码 / 达人推广码" : "Discount / creator code"}
            className="px-3 py-2 rounded-lg bg-panel border border-edge text-sm text-zinc-900 outline-none focus:border-brand-500 font-mono w-56"
          />
          <button
            onClick={applyPromo}
            disabled={promoChecking || !promoInput.trim()}
            className="px-4 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-700 disabled:opacity-40 text-white text-sm"
          >
            {promoChecking ? (zh ? "验证中…" : "Checking…") : zh ? "应用" : "Apply"}
          </button>
          {promo && (
            <span className="text-sm text-emerald-600 font-medium">
              ✓ {promo.code}{" "}
              {promo.kind === "trial"
                ? zh
                  ? `免费试用 ${promo.trialDays ?? 7} 天`
                  : `${promo.trialDays ?? 7}-day free trial`
                : `−${promo.percentOff}%`}
              <button onClick={() => { setPromo(null); setPromoInput(""); }} className="text-zinc-400 hover:text-red-500 ml-1">✕</button>
            </span>
          )}
          {promoError && <span className="text-sm text-red-500">{promoError}</span>}
        </div>

        {error && <p className="text-center text-sm text-red-500 mb-4">{error}</p>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-start">
          {PLANS.map((plan) => {
            const price = planCyclePrice(plan, cycle);
            const seatPrice = seatCyclePrice(plan, cycle);
            const extraSeats = seatsByPlan[plan.id] || 0;
            const isCurrent = planStatus === "active" && currentPlan === plan.id;
            const isPopular = plan.id === "pro";
            return (
              <div
                key={plan.id}
                className="rounded-2xl border overflow-hidden flex flex-col bg-white"
                style={{
                  borderColor: isPopular ? plan.accent : "#e4e4e7",
                  boxShadow: isPopular ? `0 0 0 1.5px ${plan.accent}` : undefined,
                }}
              >
                <div className="px-5 pt-5 pb-4" style={{ background: `linear-gradient(135deg, ${plan.accent}, ${plan.accent}cc)` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-white font-semibold text-base">{zh ? plan.nameZh : plan.nameEn}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/20 text-white shrink-0">{zh ? plan.badgeZh : plan.badgeEn}</span>
                  </div>
                  <p className="text-white/80 text-xs mt-1">{zh ? plan.taglineZh : plan.taglineEn}</p>
                </div>

                <div className="px-5 pt-4">
                  <div className="flex items-baseline gap-1">
                    {promo && <span className="text-lg text-zinc-400 line-through">${price.perMonth}</span>}
                    <span className="text-3xl font-bold text-zinc-900">${discounted(price.perMonth)}</span>
                    <span className="text-sm text-zinc-500">{copy.perMonth}</span>
                  </div>
                  {cycle.discount > 0 ? (
                    <p className="text-xs text-zinc-400 mt-1">
                      <span className="line-through">${plan.monthlyUsd * cycle.months}</span>
                      <span className="ml-1.5 font-medium" style={{ color: plan.accent }}>
                        {copy.billedTotal(zh ? cycle.labelZh : cycle.labelEn, discounted(price.total))}
                      </span>
                    </p>
                  ) : (
                    <p className="text-xs text-zinc-400 mt-1">{copy.billedMonthly}</p>
                  )}

                  {/* extra-seat stepper */}
                  <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-edge bg-panel px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[11px] text-zinc-600 leading-snug">{copy.seatsLabel(plan.seatsIncluded)}</p>
                      {plan.extraSeatAllowed && extraSeats > 0 && (
                        <p className="text-[11px] mt-0.5 font-medium" style={{ color: plan.accent }}>
                          {copy.seatPricePerMonth(seatPrice.perMonth)}
                        </p>
                      )}
                    </div>
                    {plan.extraSeatAllowed ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => adjustSeats(plan.id, -1)}
                          disabled={extraSeats === 0}
                          className="w-6 h-6 rounded-full border border-edge2 text-zinc-600 disabled:opacity-30 flex items-center justify-center"
                        >
                          −
                        </button>
                        <span className="w-5 text-center text-sm text-zinc-900 tabular-nums">{extraSeats}</span>
                        <button
                          type="button"
                          onClick={() => adjustSeats(plan.id, 1)}
                          disabled={extraSeats >= plan.maxExtraSeats}
                          className="w-6 h-6 rounded-full border border-edge2 text-zinc-600 disabled:opacity-30 flex items-center justify-center"
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10.5px] text-zinc-400 shrink-0 text-right" title={copy.noExtraSeatsTooltip}>
                        {copy.noExtraSeats}
                      </span>
                    )}
                  </div>
                </div>

                <div className="px-5 py-4 flex-1">
                  {plan.sections.map((section) => (
                    <div key={section.titleZh} className="mb-3.5 last:mb-0">
                      <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide mb-1.5">{zh ? section.titleZh : section.titleEn}</p>
                      <ul className="space-y-1.5">
                        {section.rows.map((row) => (
                          <li key={row.labelZh} className="flex items-start justify-between gap-2 text-[13px]">
                            <span className="text-zinc-600">{zh ? row.labelZh : row.labelEn}</span>
                            <span className="text-zinc-900 font-medium text-right">{zh ? row.valueZh : row.valueEn}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                <div className="px-5 pb-5">
                  <button
                    type="button"
                    onClick={() => purchase(plan.id)}
                    disabled={purchasingPlan !== null || isCurrent}
                    className="w-full h-10 rounded-lg text-sm font-medium text-white disabled:opacity-60 transition-opacity"
                    style={{ background: isCurrent ? "#a1a1aa" : plan.accent }}
                  >
                    {isCurrent ? copy.currentPlan : purchasingPlan === plan.id ? copy.purchasing : planStatus === "active" ? copy.switchPlan : copy.buyNow}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-center text-[11px] text-zinc-400 mt-8">{copy.footer}</p>
      </div>
    </div>
  );
}
