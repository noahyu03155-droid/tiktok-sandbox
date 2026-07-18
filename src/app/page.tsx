import HomePageContent from "@/components/HomePageContent";
import { listVideos } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { canAccessVideo } from "@/lib/videoAuth";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const user = getCurrentUser();
  // Each member's own Video Analysis board, isolated from other members —
  // see src/lib/videoAuth.ts. A real admin still sees every member's manual
  // imports here (same "admin sees everyone" precedent as Creation).
  const videos = listVideos().filter(
    (v) => !v.is_reference && v.source !== "trend" && v.source !== "creator" && (!user || canAccessVideo(v, user))
  );
  return <HomePageContent videos={videos} />;
}
