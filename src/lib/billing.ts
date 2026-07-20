// Single source of truth for the 3 subscription plans, the 3 billing
// cycles, and per-seat add-on pricing — shared between the /pricing UI
// (src/components/PricingPageContent.tsx) and the server-side validation in
// /api/billing/select-plan, so the numbers can never drift out of sync
// between what's SHOWN and what's actually CHARGED (well — "charged": see
// select-plan's doc comment, there's no real payment processor wired in
// yet, this just records the selection).
import type { BillingCycle, PlanId } from "./types";

export interface PlanFeatureRow {
  labelZh: string;
  valueZh: string;
}
export interface PlanFeatureSection {
  titleZh: string;
  rows: PlanFeatureRow[];
}

export interface PlanDef {
  id: PlanId;
  nameZh: string;
  nameEn: string;
  taglineZh: string;
  badgeZh: string; // small ribbon label, e.g. "低价试用"
  accent: string; // hex, drives the card's header color
  monthlyUsd: number; // full (undiscounted) monthly price
  seatsIncluded: number;
  extraSeatAllowed: boolean;
  extraSeatMonthlyUsd: number; // price per EXTRA seat, at the monthly rate (discounted the same % as the plan itself per cycle)
  maxExtraSeats: number;
  sections: PlanFeatureSection[];
}

export const PLANS: PlanDef[] = [
  {
    id: "starter",
    nameZh: "标准版",
    nameEn: "Starter",
    taglineZh: "适合刚起步的个人创作者",
    badgeZh: "低价试用",
    accent: "#ec4899",
    monthlyUsd: 29,
    seatsIncluded: 1,
    extraSeatAllowed: false,
    extraSeatMonthlyUsd: 0,
    maxExtraSeats: 0,
    sections: [
      {
        titleZh: "基础权益",
        rows: [
          { labelZh: "视频拆解", valueZh: "15 次/月" },
          { labelZh: "AI 脚本生成", valueZh: "30 次/月" },
          { labelZh: "分镜画布项目", valueZh: "1 个" },
        ],
      },
      {
        titleZh: "高级权益",
        rows: [
          { labelZh: "手动剪辑导出", valueZh: "8 次/月，720p，带水印" },
          { labelZh: "创作者追踪", valueZh: "不含" },
          { labelZh: "团队席位", valueZh: "1 人" },
        ],
      },
      {
        titleZh: "AI 权益",
        rows: [
          { labelZh: "AI 自动字幕", valueZh: "支持" },
          { labelZh: "趋势分析", valueZh: "仅 7 天榜单" },
        ],
      },
    ],
  },
  {
    id: "pro",
    nameZh: "专业版",
    nameEn: "Pro",
    taglineZh: "适合每周稳定出片的创作者/小团队",
    badgeZh: "最受欢迎",
    accent: "#f43f5e",
    monthlyUsd: 69,
    seatsIncluded: 3,
    extraSeatAllowed: true,
    extraSeatMonthlyUsd: 19,
    maxExtraSeats: 20,
    sections: [
      {
        titleZh: "基础权益",
        rows: [
          { labelZh: "视频拆解", valueZh: "60 次/月" },
          { labelZh: "AI 脚本生成", valueZh: "150 次/月" },
          { labelZh: "分镜画布项目", valueZh: "10 个" },
        ],
      },
      {
        titleZh: "高级权益",
        rows: [
          { labelZh: "手动剪辑导出", valueZh: "40 次/月，1080p，无水印" },
          { labelZh: "创作者追踪", valueZh: "最多 25 个" },
          { labelZh: "团队席位", valueZh: "3 人，可加购" },
        ],
      },
      {
        titleZh: "AI 权益",
        rows: [
          { labelZh: "AI 自动字幕", valueZh: "不限次" },
          { labelZh: "趋势分析", valueZh: "完整 7/28/90 天 + 个性化推荐" },
        ],
      },
    ],
  },
  {
    id: "business",
    nameZh: "旗舰版",
    nameEn: "Business",
    taglineZh: "适合代运营公司、多账号矩阵、品牌方",
    badgeZh: "旗舰版",
    accent: "#a21caf",
    monthlyUsd: 129,
    seatsIncluded: 10,
    extraSeatAllowed: true,
    extraSeatMonthlyUsd: 12,
    maxExtraSeats: 50,
    sections: [
      {
        titleZh: "基础权益",
        rows: [
          { labelZh: "视频拆解", valueZh: "不限次" },
          { labelZh: "AI 脚本生成", valueZh: "不限次" },
          { labelZh: "分镜画布项目", valueZh: "不限项目" },
        ],
      },
      {
        titleZh: "高级权益",
        rows: [
          { labelZh: "手动剪辑导出", valueZh: "150 次/月，1080p/4K，无水印" },
          { labelZh: "创作者追踪", valueZh: "不限，含联盟数据" },
          { labelZh: "团队席位", valueZh: "10 人，可加购" },
        ],
      },
      {
        titleZh: "AI 权益",
        rows: [
          { labelZh: "AI 自动字幕", valueZh: "不限次" },
          { labelZh: "趋势分析", valueZh: "完整 + 优先刷新" },
        ],
      },
    ],
  },
];

export const BILLING_CYCLES: { id: BillingCycle; labelZh: string; months: number; discount: number }[] = [
  { id: "monthly", labelZh: "月付", months: 1, discount: 0 },
  { id: "semiannual", labelZh: "半年付", months: 6, discount: 0.15 },
  { id: "annual", labelZh: "年付", months: 12, discount: 0.2 },
];

export function planById(id: string | null | undefined): PlanDef | undefined {
  return PLANS.find((p) => p.id === id);
}
export function cycleById(id: string | null | undefined) {
  return BILLING_CYCLES.find((c) => c.id === id);
}

// Whole-dollar rounding throughout — keeps the UI and the server's
// validation computing byte-for-byte the same numbers.
export function planCyclePrice(plan: PlanDef, cycle: (typeof BILLING_CYCLES)[number]) {
  const perMonth = Math.round(plan.monthlyUsd * (1 - cycle.discount));
  return { perMonth, total: perMonth * cycle.months, originalTotal: plan.monthlyUsd * cycle.months };
}

export function seatCyclePrice(plan: PlanDef, cycle: (typeof BILLING_CYCLES)[number]) {
  const perMonth = Math.round(plan.extraSeatMonthlyUsd * (1 - cycle.discount));
  return { perMonth, total: perMonth * cycle.months };
}
