import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getUserById, listCreationProjectsByOwner } from "@/lib/db";
import CreationMemberProjectsContent from "@/components/CreationMemberProjectsContent";

export const dynamic = "force-dynamic";

// Admin-only drill-in from the /creation member-folders grid — view (and
// open/delete) one specific member's projects.
export default function CreationMemberPage({ params }: { params: { ownerId: string } }) {
  const user = getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/creation");

  const member = getUserById(params.ownerId);
  if (!member) notFound();

  const projects = listCreationProjectsByOwner(params.ownerId);
  return <CreationMemberProjectsContent username={member.username} projects={projects} />;
}
