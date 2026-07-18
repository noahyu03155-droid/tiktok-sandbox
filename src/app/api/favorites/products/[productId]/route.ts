import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

// DELETE — un-favorite by productId.
export async function DELETE(_req: Request, { params }: { params: { productId: string } }) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const next = (user.favoriteProducts || []).filter((f) => f.productId !== params.productId);
  updateUser(user.id, { favoriteProducts: next });
  return NextResponse.json({ ok: true });
}
