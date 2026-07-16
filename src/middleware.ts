import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

// Paths that don't require login.
const PUBLIC_PATHS = ["/login", "/api/login", "/register", "/api/register"];

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
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
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
