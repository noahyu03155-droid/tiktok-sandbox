import { redirect } from "next/navigation";
import CreatorsPageContent from "@/components/CreatorsPageContent";
import { getCurrentUser } from "@/lib/session";
import { getUserById } from "@/lib/db";
import { canSeeTab } from "@/lib/accessTier";

export const dynamic = "force-dynamic";

// Direct-URL guard to match the nav: a VIP-tier member doesn't get a
// "Creator Tracker" link in HeaderBar, but could still type/bookmark this
// URL directly — see src/lib/accessTier.ts for the tier→tab rules. A real
// admin (or an untagged/business/admin-tag member) always passes.
export default function CreatorsPage() {
  const sessionUser = getCurrentUser();
  const dbUser = sessionUser ? getUserById(sessionUser.userId) : null;
  if (sessionUser && !canSeeTab("creators", sessionUser.role === "admin", dbUser?.accessTier ?? null)) {
    redirect("/");
  }
  return <CreatorsPageContent />;
}
