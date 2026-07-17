import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n";
import HeaderBar from "@/components/HeaderBar";
import { getCurrentUser } from "@/lib/session";

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
  const user = getCurrentUser();
  return (
    <html lang="en">
      <body>
        <LocaleProvider>
          <div className="min-h-screen bg-ink">
            <HeaderBar role={user?.role ?? null} />
            <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
