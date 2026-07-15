import { notFound } from "next/navigation";
import VideoDetailClient from "@/components/VideoDetailClient";
import { getVideo } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function VideoDetailPage({ params }: { params: { id: string } }) {
  const video = getVideo(params.id);
  if (!video) return notFound();
  return <VideoDetailClient initialVideo={video} />;
}
