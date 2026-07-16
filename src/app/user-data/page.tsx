import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { listUsers } from "@/lib/db";
import UserDataListContent from "@/components/UserDataListContent";

export const dynamic = "force-dynamic";

// Admin-only directory of every member account, each linking into their
// own keyword mind-map (see /user-data/[userId]).
export default function UserDataPage() {
  const user = getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const members = listUsers()
    .filter((u) => u.role === "member")
    .map((u) => ({
      id: u.id,
      username: u.username,
      createdAt: u.createdAt,
      hasProfile: !!u.creatorProfile?.completedAt,
      preferredCategoryLabel: u.preferredCategoryLabel || null,
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return <UserDataListContent members={members} />;
}
