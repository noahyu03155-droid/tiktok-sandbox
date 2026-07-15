import { NextRequest, NextResponse } from "next/server";
import { setShopifyToken } from "@/lib/db";

// Step 2 of Shopify OAuth: Shopify redirects here after the merchant
// approves the install, with a one-time ?code=. We exchange that code for a
// permanent (offline) access token and persist it in data/db.json.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const shop = url.searchParams.get("shop");
  const expectedState = req.cookies.get("shopify_oauth_state")?.value;

  if (!code || !shop) {
    return new NextResponse("Missing code or shop param.", { status: 400 });
  }
  if (!expectedState || state !== expectedState) {
    return new NextResponse("State mismatch — please restart the install from /api/shopify/oauth/install.", {
      status: 400,
    });
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new NextResponse("Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env first.", { status: 500 });
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    return new NextResponse(`Token exchange failed (${tokenRes.status}): ${text}`, { status: 500 });
  }

  const data = await tokenRes.json();
  if (!data.access_token) {
    return new NextResponse(`No access_token in response: ${JSON.stringify(data)}`, { status: 500 });
  }

  setShopifyToken(data.access_token);

  return new NextResponse(
    `<html><body style="font-family:sans-serif;padding:40px;">
      <h2>Shopify connected ✓</h2>
      <p>You can close this tab. The Script Generator's product search will work now — no need to touch .env again.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
