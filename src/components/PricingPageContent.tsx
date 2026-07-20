"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PLANS, BILLING_CYCLES, planCyclePrice, seatCyclePrice } from "@/lib/billing";
import type { PlanId, BillingCycle } from "@/lib/types";
import LogoutButton from "./LogoutButton";

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

  const [cycleId, setCycleId] = useState<BillingCycle>(currentBillingCycle || "annual");
  const [seatsByPlan, setSeatsByPlan] = useState<Record<PlanId, number>>({
    starter: 0,
    pro: currentPlan === "pro" ? currentSeats : 0,
    business: currentPlan === "business" ? currentSeats : 0,
  });
  const [purchasingPlan, setPurchasingPlan] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        body: JSON.stringify({ plan: planId, billingCycle: cycleId, seats: seatsByPlan[planId] || 0 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "购买失败，请重试");
        setPurchasingPlan(null);
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("网络错误，请重试");
      setPurchasingPlan(null);
    }
  }

  return (
    <div className="min-h-screen bg-ink py-10 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-end mb-2">
          <LogoutButton />
        </div>
        <div className="text-center mb-8">
          <h1 className="text-2xl md:text-3xl font-semibold text-zinc-900">选择适合你的方案</h1>
          <p className="text-sm text-zinc-500 mt-2">解锁视频拆解、AI 脚本生成、分镜画布、手动剪辑等全部功能</p>
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
                {c.labelZh}
                {c.discount > 0 && (
                  <span className={`ml-1.5 text-[10px] ${cycleId === c.id ? "text-white/80" : "text-pawpink-500"}`}>
                    省{Math.round(c.discount * 100)}%
                  </span>
                )}
              </button>
            ))}
          </div>
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
                    <span className="text-white font-semibold text-base">{plan.nameZh}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/20 text-white shrink-0">{plan.badgeZh}</span>
                  </div>
                  <p className="text-white/80 text-xs mt-1">{plan.taglineZh}</p>
                </div>

                <div className="px-5 pt-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold text-zinc-900">${price.perMonth}</span>
                    <span className="text-sm text-zinc-500">/月</span>
                  </div>
                  {cycle.discount > 0 ? (
                    <p className="text-xs text-zinc-400 mt-1">
                      <span className="line-through">${plan.monthlyUsd * cycle.months}</span>
                      <span className="ml-1.5 font-medium" style={{ color: plan.accent }}>
                        {cycle.labelZh}共 ${price.total}
                      </span>
                    </p>
                  ) : (
                    <p className="text-xs text-zinc-400 mt-1">按月计费</p>
                  )}

                  {/* extra-seat stepper */}
                  <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-edge bg-panel px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[11px] text-zinc-600 leading-snug">
                        额外席位（含 {plan.seatsIncluded} 个基础席位）
                      </p>
                      {plan.extraSeatAllowed && extraSeats > 0 && (
                        <p className="text-[11px] mt-0.5 font-medium" style={{ color: plan.accent }}>
                          +${seatPrice.perMonth}/月/人
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
                      <span
                        className="text-[10.5px] text-zinc-400 shrink-0 text-right"
                        title="该方案不支持加购子账号，升级到专业版即可加购"
                      >
                        不支持加购
                      </span>
                    )}
                  </div>
                </div>

                <div className="px-5 py-4 flex-1">
                  {plan.sections.map((section) => (
                    <div key={section.titleZh} className="mb-3.5 last:mb-0">
                      <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide mb-1.5">{section.titleZh}</p>
                      <ul className="space-y-1.5">
                        {section.rows.map((row) => (
                          <li key={row.labelZh} className="flex items-start justify-between gap-2 text-[13px]">
                            <span className="text-zinc-600">{row.labelZh}</span>
                            <span className="text-zinc-900 font-medium text-right">{row.valueZh}</span>
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
                    {isCurrent
                      ? "当前方案"
                      : purchasingPlan === plan.id
                        ? "购买中…"
                        : planStatus === "active"
                          ? "切换到此方案"
                          : "立即购买"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-center text-[11px] text-zinc-400 mt-8">
          价格以美元计，随时可在此页面切换方案或调整席位。如需更大用量或专属功能，请联系我们定制方案。
        </p>
      </div>
    </div>
  );
}
