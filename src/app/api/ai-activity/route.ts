import { NextResponse } from "next/server";
import { getAiActivity } from "@/lib/aiActivity";

// Polled by the floating robot assistant; must never be statically cached.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getAiActivity());
}
