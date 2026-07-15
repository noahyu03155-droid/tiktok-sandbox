import { notFound } from "next/navigation";
import CreatorDetailClient from "@/components/CreatorDetailClient";
import { getTrackedCreator } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function CreatorDetailPage({ params }: { params: { id: string } }) {
  const creator = getTrackedCreator(params.id);
  if (!creator) return notFound();
  return <CreatorDetailClient initialCreator={creator} />;
}
