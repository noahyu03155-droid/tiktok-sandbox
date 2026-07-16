import { NextResponse } from "next/server";
import { fetchFastMossCategories } from "@/lib/fastmoss";
import { getFastmossCategoryValidity } from "@/lib/db";

export const dynamic = "force-dynamic";

interface CategoryNode {
  c_code: string;
  c_name: string;
  sub?: CategoryNode[];
}

// Keeps a node if it was itself confirmed to have video data, OR if any of
// its descendants were — so a parent category whose own broad
// product_category_id wasn't individually tested-positive but which still
// has a valid child stays visible/expandable. Only prunes a subtree that's
// entirely dead-ends. Nodes that were never tested at all (tree grew since
// the last scan, or a probe errored out and was left "unknown") are kept —
// we only remove what we affirmatively confirmed has zero data.
function pruneTree(nodes: CategoryNode[], validIds: Set<string>): CategoryNode[] {
  const out: CategoryNode[] = [];
  for (const n of nodes) {
    const prunedSub = n.sub && n.sub.length > 0 ? pruneTree(n.sub, validIds) : undefined;
    const keepSelf = validIds.has(n.c_code);
    const keepForChildren = !!prunedSub && prunedSub.length > 0;
    if (keepSelf || keepForChildren) {
      out.push(prunedSub ? { ...n, sub: prunedSub } : { ...n });
    }
  }
  return out;
}

export async function GET() {
  if (!process.env.FASTMOSS_API_KEY) {
    return NextResponse.json({ error: "FASTMOSS_API_KEY isn't set yet — see README." }, { status: 400 });
  }
  try {
    const categories = (await fetchFastMossCategories()) as CategoryNode[];
    const scan = getFastmossCategoryValidity();

    if (!scan) {
      return NextResponse.json({ categories, scan: null });
    }

    const validIds = new Set(scan.validIds);
    const pruned = pruneTree(categories || [], validIds);
    return NextResponse.json({
      categories: pruned,
      scan: { scannedAt: scan.scannedAt, totalNodes: scan.totalNodes, totalTested: scan.totalTested, totalBefore: (categories || []).length, totalAfterTopLevel: pruned.length },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load FastMoss categories." }, { status: 500 });
  }
}
