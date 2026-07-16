import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { listCreationProjectsByOwner, listCreationOwnersSummary, listUsers, getOrCreateDefaultCreationProject } from "@/lib/db";
import CreationPageContent from "@/components/CreationPageContent";

export const dynamic = "force-dynamic";

// Every login account gets its own Creation space. Regular ("member")
// accounts get exactly ONE implicit canvas — no project list, no "new
// project" button — so landing here just jumps straight to it (creating it
// on the very first visit). Only the admin account keeps the full
// multi-project list + everyone's-folders view, since admin needs to
// browse into each member's individual work.
export default function CreationPage() {
  const user = getCurrentUser();
  if (!user) redirect("/login");

  if (user.role !== "admin") {
    const project = getOrCreateDefaultCreationProject(user.userId);
    redirect(`/creation/${project.id}`);
  }

  const myProjects = listCreationProjectsByOwner(user.userId);

  const summaryByOwner = new Map(listCreationOwnersSummary().map((s) => [s.ownerId, s]));
  const owners = listUsers()
    .filter((u) => u.role === "member")
    .map((u) => {
      const summary = summaryByOwner.get(u.id);
      return {
        ownerId: u.id,
        username: u.username,
        projectCount: summary?.projectCount ?? 0,
        lastUpdatedAt: summary?.lastUpdatedAt ?? u.createdAt,
      };
    })
    .sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());

  return <CreationPageContent role={user.role} myProjects={myProjects} owners={owners} />;
}
