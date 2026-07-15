import { NextRequest, NextResponse } from "next/server";
import { getVideo, updateVideoRecord } from "@/lib/db";
import { getShopifyProduct } from "@/lib/shopify";
import { refineScriptStage } from "@/lib/scriptgen";
import type { GeneratedScriptStage } from "@/lib/types";

export const dynamic = "force-dynamic";

// Regenerates ONE beat of an already-generated script, based on freeform
// user feedback (e.g. "make this punchier" / "mention the 30-day guarantee
// instead"). The beat being replaced is kept as `previousScript` /
// `previousDirection` rather than discarded, so the UI can offer an Old/New
// toggle instead of silently overwriting what might have been the better
// take.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const stageIndex = body.stageIndex;
  const feedback = String(body.feedback || "").trim();
  if (typeof stageIndex !== "number") {
    return NextResponse.json({ error: "stageIndex is required" }, { status: 400 });
  }
  if (!feedback) {
    return NextResponse.json({ error: "feedback is required" }, { status: 400 });
  }

  const scriptIdx = video.generated_scripts.findIndex((s) => s.id === params.scriptId);
  if (scriptIdx === -1) return NextResponse.json({ error: "script not found" }, { status: 404 });
  const script = video.generated_scripts[scriptIdx];
  const stage = script.stages[stageIndex];
  if (!stage) return NextResponse.json({ error: "stage not found" }, { status: 404 });

  try {
    const product = await getShopifyProduct(script.shopify_product_id);
    if (!product) return NextResponse.json({ error: "Shopify product not found" }, { status: 404 });

    // Refine whichever version is currently marked "selected" (the user may
    // have already picked "Old" over a prior regeneration before asking for
    // another pass).
    const baseline =
      stage.selectedVersion === "previous" && stage.previousScript != null
        ? { script: stage.previousScript, direction: stage.previousDirection || "" }
        : { script: stage.script, direction: stage.direction };

    const refined = await refineScriptStage({
      videoTitle: video.title || video.source_url,
      stageLabel: stage.label,
      currentScript: baseline.script,
      currentDirection: baseline.direction,
      feedback,
      product,
    });

    const newStage: GeneratedScriptStage = {
      ...stage,
      script: refined.script,
      direction: refined.direction,
      previousScript: baseline.script,
      previousDirection: baseline.direction,
      selectedVersion: "current",
    };

    const newStages = script.stages.map((s, i) => (i === stageIndex ? newStage : s));
    const newScripts = video.generated_scripts.map((s, i) =>
      i === scriptIdx ? { ...s, stages: newStages } : s
    );
    updateVideoRecord(params.id, { generated_scripts: newScripts });

    return NextResponse.json({ script: newScripts[scriptIdx] });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
