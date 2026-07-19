import type { Metadata } from "next";
import { Rajdhani } from "next/font/google";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n";
import HeaderBar from "@/components/HeaderBar";
import MainShell from "@/components/MainShell";
import { getCurrentUser } from "@/lib/session";
import { getUserById } from "@/lib/db";

// The COTORX wordmark's font (see Logo.tsx) — squared-off, angular
// letterforms read as more technical/precise than a standard geometric
// sans, which is the point at this weight rendered as a thin outline
// stroke rather than a filled shape (chosen over Space Grotesk and a
// couple of other geometric candidates specifically for this outline
// treatment; an earlier, more decorative/sci-fi Orbitron experiment was
// tried and reverted in Phase 39/41 — this sits in between: sharp but not
// costume-y). Everything else (body copy, dense dashboard UI) stays on the
// default sans so data-heavy screens (Trends, Creation, User Data) stay
// readable. Exposed as a CSS variable so Logo.tsx can opt in without every
// page importing next/font itself. "300" is the outline wordmark's actual
// weight; "600" stays loaded in case anything ever wants a solid-fill
// version of the same family.
const wordmarkFont = Rajdhani({ subsets: ["latin"], weight: ["300", "600"], variable: "--font-wordmark" });

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
