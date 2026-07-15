import { NextResponse } from "next/server";
import { fetchFastMossCategories } from "@/lib/fastmoss";

export const dynamic = "force-dynamic";

// Debug/setup helper — proxies FastMoss's product/v1/categoryInfo so the
// team can find the right pet-category id (for FASTMOSS_PET_CATEGORY_ID)
// without leaving the app or writing a curl command by hand. Visit
// /api/trends/fastmoss-categories directly in the browser once you have a
// key set, then Ctrl+F for "Pet" in the JSON.
export async function GET() {
  if (!process.env.FASTMOSS_API_KEY) {
    return NextResponse.json({ error: "FASTMOSS_API_KEY isn't set yet — see README." }, { status: 400 });
  }
  try {
    const categories = await fetchFastMossCategories();
    return NextResponse.json({ categories });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load FastMoss categories." }, { status: 500 });
  }
}
