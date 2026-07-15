import HomePageContent from "@/components/HomePageContent";
import { listVideos } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const videos = listVideos().filter((v) => !v.is_reference && v.source !== "trend" && v.source !== "creator");
  return <HomePageContent videos={videos} />;
}
