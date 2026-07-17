// Server component (no "use client") purely so it can read real, already-
// cached video thumbnails straight off the DB for the landing-page showcase
// (RegisterLanding.tsx's fanned deck + scrolling strip) — everything
// interactive/localized lives in that client component and RegisterForm.
import { listVideos } from "@/lib/db";
import RegisterLanding from "@/components/RegisterLanding";

export const dynamic = "force-dynamic";

export default function RegisterPage() {
  // Purely decorative — just the thumbnail image URL, nothing else about
  // these videos (title/transcript/stats) is read or passed to the client.
  // /api/media/[...path] already serves these with no auth check, so this
  // isn't exposing anything that wasn't already publicly fetchable.
  const thumbnails = listVideos()
    .filter((v) => !!v.thumbnail_path)
    .slice(0, 24)
    .map((v) => `/api/media/${v.thumbnail_path!.split(/[\\/]/).pop()}`);

  return <RegisterLanding thumbnails={thumbnails} />;
}
