import TrendsPageContent from "@/components/TrendsPageContent";
import { getCurrentUser } from "@/lib/session";
import { getUserById } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function TrendsPage() {
  const sessionUser = getCurrentUser();
  const dbUser = sessionUser ? getUserById(sessionUser.userId) : null;
  const preferredCategory =
    dbUser?.preferredCategoryId
      ? { id: dbUser.preferredCategoryId, label: dbUser.preferredCategoryLabel || dbUser.preferredCategoryId }
      : null;
  return <TrendsPageContent preferredCategory={preferredCategory} />;
}
