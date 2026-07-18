// Server component (no "use client") purely so it can read real, already-
// cached video thumbnails straight off the DB for the landing-page showcase
// (RegisterLanding.tsx's fanned deck + scrolling strip) — everything
// interactive/localized lives in that client component and RegisterForm.
import { listVideos } from "@/lib/db";
import RegisterLanding from "@/components/RegisterLanding";

export const dynamic = "force-dynamic";

export default function RegisterPage() {
  // Purely decorative. Restricted to source:"trend"/"creator" videos — the
  // shared FastMoss/Creator-Tracker catalog every member browses — rather
  // than the full unfiltered listVideos(), which since the Phase 45
  // ownership work can also contain OTHER MEMBERS' PRIVATE "manual"
  // Video-Analysis imports. Showcasing someone's own pasted-in video (and
  // their handle) on the public marketing page would leak private content;
  // catalog videos are already public TikTok Shop content, so there's
  // nothing new exposed by showing those. Author handle is included now
  // (still nothing from title/transcript/stats) for the floating-video
  // showcase grid's name/role captions.
  const showcaseVideos = listVideos()
    .filter((v) => !!v.thumbnail_path && (v.source === "trend" || v.source === "creator"))
    .slice(0, 24)
    .map((v) => ({
      thumb: `/api/media/${v.thumbnail_path!.split(/[\\/]/).pop()}`,
      author: v.author || null,
    }));

  return <RegisterLanding showcaseVideos={showcaseVideos} />;
}
