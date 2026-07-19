import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { listCreationProjectsByOwner, listCreationOwnersSummary, listUsers } from "@/lib/db";
import CreationPageContent from "@/components/CreationPageContent";

export const dynamic = "force-dynamic";

// Every login account gets its own Creation space, and now every account —
// not just admin — gets the full multi-project list + "New project" button
// (previously a regular "member" account was auto-redirected straight into
// a single implicit canvas with no list/button at all; the only way to give
// a member more than one project used to be admin creating extra projects
// on their OWN account named after that member, a workaround rather than a
// real feature). The admin account ADDITIONALLY sees a "one folder per
// member" browse section below its own project list (see the `owners` prop,
// only populated for admin) since admin still needs to look into each
// member's individual work.
export default function CreationPage() {
  const user = getCurrentUser();
  if (!user) redirect("/login");

  const myProjects = listCreationProjectsByOwner(user.userId);

  const owners =
    user.role === "admin"
      ? (() => {
          const summaryByOwner = new Map(listCreationOwnersSummary().map((s) => [s.ownerId, s]));
          return listUsers()
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
        })()
      : [];

  return <CreationPageContent role={user.role} myProjects={myProjects} owners={owners} />;
}
