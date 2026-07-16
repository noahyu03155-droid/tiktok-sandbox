import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n";
import HeaderBar from "@/components/HeaderBar";
import RobotAssistant from "@/components/RobotAssistant";

export const metadata: Metadata = {
  title: "The Pawmart TokBox",
  description: "Paste a TikTok video link, get an instant video card and script breakdown",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LocaleProvider>
          <div className="min-h-screen bg-ink">
            <HeaderBar />
            <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
            <RobotAssistant />
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
