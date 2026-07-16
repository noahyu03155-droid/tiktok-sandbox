import { NextRequest, NextResponse } from "next/server";
import { buildFastmossVideoUrl, fetchCategoryTrendVideos, formatUsd, toCreatorInfo } from "@/lib/fastmoss";
import type { FastMossVideoResult } from "@/lib/fastmoss";
import { ingestTrendBatch, type RawTrendItem } from "@/lib/trends";

export const dynamic = "force-dynamic";

const REGION = process.env.FASTMOSS_REGION || "US";

function toRawItem(v: FastMossVideoResult, index: number): RawTrendItem {
  return {
    rank: index + 1,
    fastmoss_url: buildFastmossVideoUrl(v.video_id),
    video_url: v.video_url || undefined,
    fastmoss_title: v.desc || undefined,
    product_name: v.product_info?.[0]?.title || undefined,
    product_id: v.product_info?.[0]?.product_id || undefined,
    views: v.play_count ?? undefined,
    likes: v.digg_count ?? undefined,
    comments: v.comment_count ?? undefined,
    gmv: formatUsd(v.gmv) || undefined,
    sales: v.units_sold ?? undefined,
    creator: toCreatorInfo(v.creator),
  };
}

// One-click replacement for the old "go ask Claude to live-scrape FastMoss
// in a logged-in Chrome tab" flow — calls FastMoss's own Open API directly,
// server-side, no browser session needed. Triggered by the "Update" button
// on the Trend Analysis page. Accepts an optional JSON body with a
// categoryId/categoryLabel (from the category picker) and a days window
// (7/28/90) — a bare POST with no body behaves exactly like the old
// hardcoded pets/7-days version.
export async function POST(req: NextRequest) {
  if (!process.env.FASTMOSS_API_KEY) {
    return NextResponse.json(
      {
        error:
          "还没配置 FASTMOSS_API_KEY。去 developers.fastmoss.com 注册账号、在控制台生成一个 API Key，填进 .env（或 Railway 的 Variables）里就能用了。",
      },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const categoryId =
    typeof body?.categoryId === "string" || typeof body?.categoryId === "number" ? body.categoryId : undefined;
  const categoryLabel =
    typeof body?.categoryLabel === "string" && body.categoryLabel.trim()
      ? body.categoryLabel.trim()
      : "Pet Food & Treats";
  const daysRaw = Number(body?.days);
  const days = [7, 28, 90].includes(daysRaw) ? daysRaw : 7;

  const now = new Date();
  const from = new Date(now.getTime() - days * 86400 * 1000);
  const date_from = from.toISOString().slice(0, 10);
  const date_to = now.toISOString().slice(0, 10);

  try {
    const [byViews, bySales] = await Promise.all([
      fetchCategoryTrendVideos("play_count", { days, region: REGION, limit: 20, categoryId }),
      fetchCategoryTrendVideos("units_sold", { days, region: REGION, limit: 20, categoryId }),
    ]);

    if (byViews.length === 0 && bySales.length === 0) {
      return NextResponse.json(
        {
          error: categoryId
            ? `FastMoss 没返回任何符合条件的视频（类目：${categoryLabel}，${days} 天）—— 可能是这个时间窗口/类目确实没有数据，换个类目或时间范围试试。`
            : "FastMoss 没返回任何符合条件的宠物类视频 —— 可能是这周确实没有数据，也可能是 FASTMOSS_PET_CATEGORY_ID 设置得太窄。可以先不设这个变量，让它用关键词兜底搜索。",
        },
        { status: 502 }
      );
    }

    const batch = ingestTrendBatch({
      category: categoryLabel,
      category_id: categoryId != null ? String(categoryId) : null,
      date_from,
      date_to,
      days,
      top_by_views: byViews.map(toRawItem),
      top_by_sales: bySales.map(toRawItem),
    });

    return NextResponse.json({ batch });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "FastMoss 更新失败，请稍后重试。" }, { status: 500 });
  }
}
