import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET: this member's bookmarked products. Unlike favoriteVideos, these are
// returned as-stored (no live dereference) — see the User.favoriteProducts
// doc comment in src/lib/types.ts for why: FastMoss trend batches rotate
// out, so there's no durable record left to re-read a product against
// later; the display fields are snapshotted at favorite-time instead.
export async function GET() {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const products = [...(user.favoriteProducts || [])].sort(
    (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
  );
  return NextResponse.json({ products });
}

// POST { productId, title, imageUrl?, price? } — idempotent by productId.
export async function POST(req: NextRequest) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const productId = body?.productId;
  const title = body?.title;
  if (typeof productId !== "string" || !productId) {
    return NextResponse.json({ error: "productId is required" }, { status: 400 });
  }
  if (typeof title !== "string" || !title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl : null;
  const price = typeof body?.price === "string" ? body.price : null;

  const existing = (user.favoriteProducts || []).find((f) => f.productId === productId);
  if (existing) return NextResponse.json({ favoriteId: existing.id });

  const entry = { id: crypto.randomUUID(), productId, title, imageUrl, price, addedAt: new Date().toISOString() };
  updateUser(user.id, { favoriteProducts: [...(user.favoriteProducts || []), entry] });
  return NextResponse.json({ favoriteId: entry.id });
}
