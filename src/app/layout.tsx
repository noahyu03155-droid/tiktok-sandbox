import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n";
import HeaderBar from "@/components/HeaderBar";
import MainShell from "@/components/MainShell";
import { getCurrentUser } from "@/lib/session";
import { getUserById } from "@/lib/db";

// A clean geometric sans used only for the COTORX wordmark (see Logo.tsx) —
// gives it a techy, minimal feel without going as decorative/sci-fi as the
// earlier Orbitron experiment (Phase 39, reverted in Phase 41). Everything
// else (body copy, dense dashboard UI) stays on the default sans so
// data-heavy screens (Trends, Creation, User Data) stay readable. Exposed
// as a CSS variable so Logo.tsx can opt in without every page importing
// next/font itself.
const wordmarkFont = Space_Grotesk({ subsets: ["latin"], weight: ["700"], variable: "--font-wordmark" });

// Core selling-point pitch, used both as the page <meta description> and as
// the Open Graph title/description so link previews (iMessage, Messenger,
// etc.) show COTORX's actual value prop instead of a generic tagline. Set
// explicitly rather than relying on Next's OG auto-fallback so unfurls are
// reliable across apps that only read the og: tags.
const TAGLINE = "COTORX";
const PITCH =
  "Paste any viral TikTok, get an AI breakdown of its hook, structure, and selling points — then a new shoppable script and storyboard built around your own product.";

export const metadata: Metadata = {
  title: TAGLINE,
  description: PITCH,
  openGraph: {
    title: TAGLINE,
    description: PITCH,
    siteName: TAGLINE,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: TAGLINE,
    description: PITCH,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the session here (via next/headers under the hood) is what
  // lets HeaderBar know whether to show the admin-only "User Data" nav
  // item — it can't call getCurrentUser() itself since it's a client
  // component. Using headers()/cookies() anywhere in a server component
  // automatically opts that route into dynamic rendering, so no extra
  // `export const dynamic` is needed here.
  const sessionUser = getCurrentUser();
  // The session cookie only carries userId/username/role (see
  // src/lib/session.ts) — accessTier lives on the full DB record, so it's
  // fetched here rather than added to the session payload.
  const dbUser = sessionUser ? getUserById(sessionUser.userId) : null;
  return (
    <html lang="en">
      <body className={wordmarkFont.variable}>
        <LocaleProvider>
          <div className="min-h-screen bg-ink">
            <HeaderBar role={sessionUser?.role ?? null} accessTier={dbUser?.accessTier ?? null} />
            <MainShell>{children}</MainShell>
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
