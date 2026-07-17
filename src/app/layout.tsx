import type { Metadata } from "next";
import { Orbitron } from "next/font/google";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n";
import HeaderBar from "@/components/HeaderBar";
import MainShell from "@/components/MainShell";
import { getCurrentUser } from "@/lib/session";

// A geometric/technical display face used ONLY for the COTORX wordmark
// (see Logo.tsx) and the register page's hero headline — everything else
// (body copy, buttons, dense dashboard UI) stays on the default sans so
// long-form/data-heavy screens (Trends, Creation, User Data) stay readable.
// Exposed as a CSS variable on <body> so any component can opt in with
// `style={{ fontFamily: "var(--font-display)" }}` without every page
// needing to import next/font itself.
const displayFont = Orbitron({ subsets: ["latin"], weight: ["700", "800", "900"], variable: "--font-display" });

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
      <body className={displayFont.variable}>
        <LocaleProvider>
          <div className="min-h-screen bg-ink">
            <HeaderBar role={user?.role ?? null} />
            <MainShell>{children}</MainShell>
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
