import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { deletePromoCode, listPromoCodes, updatePromoCode } from "@/lib/db";

export const dynamic = "force-dynamic";

// Admin-only per-code operations: PATCH toggles/edits, DELETE removes the
// code outright (its usage history goes with it — deactivate instead of
// deleting to keep the commission log).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body?.active === "boolean") patch.active = body.active;
  if (Number.isFinite(Number(body?.percentOff))) patch.percentOff = Math.max(1, Math.min(90, Math.round(Number(body.percentOff))));
  if (Number.isFinite(Number(body?.commissionPercent))) patch.commissionPercent = Math.max(0, Math.min(90, Math.round(Number(body.commissionPercent))));
  if (typeof body?.affiliateName === "string") patch.affiliateName = body.affiliateName.trim().slice(0, 80) || null;

  updatePromoCode(params.id, patch);
  const updated = listPromoCodes().find((c) => c.id === params.id) || null;
  if (!updated) return NextResponse.json({ error: "Code not found" }, { status: 404 });
  return NextResponse.json({ code: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const user = getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  deletePromoCode(params.id);
  return NextResponse.json({ ok: true });
}
