import { NextRequest, NextResponse } from "next/server";
import { getVideo, updateVideoRecord } from "@/lib/db";

export const dynamic = "force-dynamic";

// Lets the user pick "Old" vs "New" as the final version of one script beat
// after a refine — a pure metadata flip, no AI call, but persisted so the
// choice survives a page reload.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; scriptId: string } }
) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const stageIndex = body.stageIndex;
  const version = body.version;
  if (typeof stageIndex !== "number") {
    return NextResponse.json({ error: "stageIndex is required" }, { status: 400 });
  }
  if (version !== "current" && version !== "previous") {
    return NextResponse.json({ error: "version must be 'current' or 'previous'" }, { status: 400 });
  }

  const scriptIdx = video.generated_scripts.findIndex((s) => s.id === params.scriptId);
  if (scriptIdx === -1) return NextResponse.json({ error: "script not found" }, { status: 404 });
  const script = video.generated_scripts[scriptIdx];
  const stage = script.stages[stageIndex];
  if (!stage) return NextResponse.json({ error: "stage not found" }, { status: 404 });

  const newStages = script.stages.map((s, i) =>
    i === stageIndex ? { ...s, selectedVersion: version as "current" | "previous" } : s
  );
  const newScripts = video.generated_scripts.map((s, i) =>
    i === scriptIdx ? { ...s, stages: newStages } : s
  );
  updateVideoRecord(params.id, { generated_scripts: newScripts });

  return NextResponse.json({ script: newScripts[scriptIdx] });
}
