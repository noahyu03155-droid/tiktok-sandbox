import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCreationProject } from "@/lib/db";
import CreationCanvasClient from "@/components/CreationCanvasClient";

export const dynamic = "force-dynamic";

export default function CreationProjectPage({ params }: { params: { projectId: string } }) {
  const user = getCurrentUser();
  if (!user) redirect("/login");

  const project = getCreationProject(params.projectId);
  if (!project) notFound();
  if (project.ownerId !== user.userId && user.role !== "admin") notFound();

  return <CreationCanvasClient project={project} role={user.role} />;
}
