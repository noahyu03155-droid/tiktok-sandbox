import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

// Step 1 of Shopify OAuth: redirect the browser to Shopify's authorization
// screen. Visit this URL once (in the browser, logged into your own machine
// running the app) to connect the store — after approving, Shopify redirects
// back to /api/shopify/oauth/callback which exchanges the code for a
// permanent access token and saves it, so this only needs to be done once.
export async function GET(req: NextRequest) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!domain || !clientId) {
    return NextResponse.json(
      { error: "Set SHOPIFY_STORE_DOMAIN and SHOPIFY_CLIENT_ID in .env first, then restart the server." },
      { status: 500 }
    );
  }

  const state = crypto.randomBytes(16).toString("hex");
  // Prefer an explicit APP_URL over req.nextUrl.origin — behind Railway's
  // (and most PaaS) reverse proxy, the Host header Next.js sees can resolve
  // to an internal address like localhost:8080 instead of the public
  // domain, which silently sends Shopify the wrong redirect_uri and bounces
  // the OAuth callback to a dead localhost URL. Set APP_URL in the
  // Variables tab to your real https://<domain> to make this deterministic.
  const appUrl = (process.env.APP_URL || req.nextUrl.origin).replace(/\/$/, "");
  const redirectUri = `${appUrl}/api/shopify/oauth/callback`;
  const scope = "read_products";

  const authorizeUrl =
    `https://${domain}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set("shopify_oauth_state", state, { httpOnly: true, maxAge: 600, path: "/" });
  return res;
}
