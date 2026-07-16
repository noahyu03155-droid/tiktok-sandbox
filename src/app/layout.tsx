import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n";
import HeaderBar from "@/components/HeaderBar";
import RobotAssistant from "@/components/RobotAssistant";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "COTORX",
  description: "Paste a TikTok video link, get an instant video card and script breakdown",
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
            <RobotAssistant />
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
