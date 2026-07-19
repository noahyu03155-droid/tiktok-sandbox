import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserById, updateUser } from "@/lib/db";

export const dynamic = "force-dynamic";

// DELETE — remove one "Your Works" entry by its own id (not by url, since
// url isn't guaranteed unique here — see the POST doc comment in
// src/app/api/works/route.ts).
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = getUserById(sessionUser.userId);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const next = (user.myWorks || []).filter((w) => w.id !== params.id);
  updateUser(user.id, { myWorks: next });
  return NextResponse.json({ ok: true });
}
