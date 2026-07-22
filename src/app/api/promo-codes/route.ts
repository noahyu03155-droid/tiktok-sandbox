import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/session";
import { createPromoCode, getPromoCodeByCode, listPromoCodes } from "@/lib/db";

export const dynamic = "force-dynamic";

// Admin-only management API for the "Code Generator" page (src/app/codes):
// GET lists every code with its usage log; POST creates one. The public
// buyer-facing check lives in ./validate (plan-gate-exempt — see
// middleware.ts), NOT here.
export async function GET() {
  const user = getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  return NextResponse.json({ codes: listPromoCodes() });
}

// Unambiguous alphabet (no 0/O/1/I) for auto-generated codes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(len = 8): string {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const kind = body?.kind === "affiliate" ? "affiliate" : "discount";

  const percentOffRaw = Number(body?.percentOff);
  const percentOff = Number.isFinite(percentOffRaw) ? Math.max(1, Math.min(90, Math.round(percentOffRaw))) : 10;

  const commissionRaw = Number(body?.commissionPercent);
  const commissionPercent =
    kind === "affiliate" && Number.isFinite(commissionRaw) ? Math.max(0, Math.min(90, Math.round(commissionRaw))) : kind === "affiliate" ? 20 : 0;

  const affiliateName =
    kind === "affiliate" && typeof body?.affiliateName === "string" && body.affiliateName.trim()
      ? body.affiliateName.trim().slice(0, 80)
      : null;
  if (kind === "affiliate" && !affiliateName) {
    return NextResponse.json({ error: "Affiliate codes need the creator's name/handle so commissions can be attributed." }, { status: 400 });
  }

  // Custom code if given (letters/numbers, 3-20 chars), else auto-generate;
  // either way uniqueness is enforced against every existing code.
  let code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (code) {
    if (!/^[A-Z0-9]{3,20}$/.test(code)) {
      return NextResponse.json({ error: "Custom codes must be 3-20 letters/numbers." }, { status: 400 });
    }
    if (getPromoCodeByCode(code)) {
      return NextResponse.json({ error: `Code "${code}" already exists.` }, { status: 409 });
    }
  } else {
    do {
      code = randomCode();
    } while (getPromoCodeByCode(code));
  }

  const promo = createPromoCode({ code, kind, percentOff, commissionPercent, affiliateName, active: true });
  return NextResponse.json({ code: promo });
}
