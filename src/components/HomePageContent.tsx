"use client";

import UrlInputBar from "./UrlInputBar";
import VideoGrid from "./VideoGrid";
import { useLocale } from "@/lib/i18n";
import type { VideoRecord } from "@/lib/types";

export default function HomePageContent({ videos }: { videos: VideoRecord[] }) {
  const { t } = useLocale();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-zinc-900 mb-1">{t("pasteHeading")}</h2>
        <p className="text-sm text-zinc-500 mb-4">{t("pasteSubheading")}</p>
        <UrlInputBar />
      </div>
      <div>
        <h3 className="text-sm font-medium text-zinc-700 mb-3">
          {t("boardHeading")}（{videos.length}）
        </h3>
        <VideoGrid initialVideos={videos} />
      </div>
    </div>
  );
}
