import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getUserById, listCreationProjectsByOwner } from "@/lib/db";
import { buildProfileBranches } from "@/lib/userGraph";
import UserKeywordGraphPageContent from "@/components/UserKeywordGraphPageContent";

export const dynamic = "force-dynamic";

// Admin-only — the keyword mind-map for one specific member, built purely
// from what they've filled in so far (registration category + onboarding
// answers). Mirrors the admin-gating pattern already used by
// src/app/creation/member/[ownerId]/page.tsx.
export default function UserDataDetailPage({ params }: { params: { userId: string } }) {
  const sessionUser = getCurrentUser();
  if (!sessionUser) redirect("/login");
  if (sessionUser.role !== "admin") redirect("/");

  const target = getUserById(params.userId);
  if (!target || target.role !== "member") notFound();

  const branches = buildProfileBranches(target);
  const projects = listCreationProjectsByOwner(target.id);
  const lastActiveAt = projects[0]?.updatedAt || null;

  return (
    <UserKeywordGraphPageContent
      userId={target.id}
      username={target.username}
      joinedAt={target.createdAt}
      projectCount={projects.length}
      lastActiveAt={lastActiveAt}
      branches={branches}
      customTags={target.customTags || []}
      graphPositions={target.graphPositions || {}}
      graphParentOverrides={target.graphParentOverrides || {}}
    />
  );
}
