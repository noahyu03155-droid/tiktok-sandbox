import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { listCreationProjectsByOwner, listCreationOwnersSummary, listUsers } from "@/lib/db";
import CreationPageContent from "@/components/CreationPageContent";

export const dynamic = "force-dynamic";

// Every login account gets its own Creation space (its own list of
// CreationProjects). An admin additionally sees every member's folder as a
// thumbnail below their own project list — same data /api/creation/owners
// computes, fetched directly here since this is already a server component.
export default function CreationPage() {
  const user = getCurrentUser();
  if (!user) redirect("/login");

  const myProjects = listCreationProjectsByOwner(user.userId);

  let owners: { ownerId: string; username: string; projectCount: number; lastUpdatedAt: string }[] = [];
  if (user.role === "admin") {
    const summaryByOwner = new Map(listCreationOwnersSummary().map((s) => [s.ownerId, s]));
    owners = listUsers()
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
  }

  return <CreationPageContent role={user.role} myProjects={myProjects} owners={owners} />;
}
