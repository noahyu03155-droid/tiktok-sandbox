import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

// Paths that don't require login.
// /api/trends/fastmoss-categories is included so the registration page's
// category picker can load the list before the user has an account/session
// — it's read-only public category metadata, nothing sensitive.
const PUBLIC_PATHS = ["/login", "/api/login", "/register", "/api/register", "/api/trends/fastmoss-categories"];

// Paths that DO require a logged-in session but are exempt from the "must
// have an active billing plan" check below — otherwise a freshly-registered,
// not-yet-paid member could never reach /pricing at all (middleware would
// keep redirecting them back to it) or finish the onboarding step that comes
// right before it. See PricingPageContent.tsx / /api/billing/select-plan.
// /api/logout is here too — an unpaid member stuck on /pricing still needs
// to be able to log out (e.g. to try a different account); without this
// exemption the logout POST itself got 402'd by the block below and the
// cookie never actually cleared, so the button silently did nothing.
const PLAN_EXEMPT_PATHS = ["/pricing", "/onboarding", "/api/onboarding", "/api/logout"];
const PLAN_EXEMPT_PREFIXES = ["/api/billing/"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublic =
    PUBLIC_PATHS.some((p) => pathname === p) ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    // Media files need to be fetchable without a login cookie — e.g. a
    // browser directly opening/downloading a rendered MP4 link, or a video
    // element loading a clip URL. URLs are unguessable UUIDs, same trust
    // model as an "unlisted" link.
    pathname.startsWith("/api/media/");

  if (isPublic) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const user = await verifySessionToken(token);

  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    // Anyone without a session lands on the marketing/register page first
    // (RegisterLanding.tsx), not the bare login form — it now has its own
    // inline sign-up panel plus a "Log in" link for existing members. Same
    // `next` param either page reads to forward back to where they were
    // headed after auth.
    const entryUrl = new URL("/register", req.url);
    entryUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(entryUrl);
  }

  // Billing gate — role "admin" (the real site owner) always bypasses this,
  // same as it bypasses every other tier/tab restriction in this app. Every
  // "member" account needs planActive (see auth.ts's doc comment on why
  // that's read off the token instead of a fresh DB lookup) or gets sent to
  // /pricing before reaching anything else.
  const isPlanExempt =
    user.role === "admin" ||
    user.planActive ||
    PLAN_EXEMPT_PATHS.some((p) => pathname === p) ||
    PLAN_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));

  if (!isPlanExempt) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "请先选择付费方案" }, { status: 402 });
    }
    const pricingUrl = new URL("/pricing", req.url);
    pricingUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(pricingUrl);
  }

  // Forward the decoded session onto the request as headers — route
  // handlers and server components can read these (via next/headers) to
  // know who's asking without re-verifying the cookie themselves. Only
  // middleware can set request headers this way; API routes can't trust a
  // client-supplied x-user-* header directly, but they can trust one that
  // arrived via this middleware since it's not part of the public surface.
  const forwarded = new Headers(req.headers);
  forwarded.set("x-user-id", user.userId);
  forwarded.set("x-user-role", user.role);
  forwarded.set("x-username", user.username);
  return NextResponse.next({ request: { headers: forwarded } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
