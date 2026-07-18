import { NextRequest, NextResponse } from "next/server";
import { getVideo } from "@/lib/db";
import { videoAccessError } from "@/lib/videoAuth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const video = getVideo(params.id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
  const accessErr = videoAccessError(video);
  if (accessErr) return NextResponse.json({ error: accessErr.error }, { status: accessErr.status });
  return NextResponse.json({ video });
}
