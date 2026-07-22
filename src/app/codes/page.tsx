import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import CodesPageContent from "@/components/CodesPageContent";

export const dynamic = "force-dynamic";

// Admin-only "Code Generator" — create discount codes (buyer gets % off at
// checkout) and affiliate codes (buyer gets % off AND the creator whose
// code it is earns a tracked commission on every purchase). Management +
// per-code revenue/commission tallies all live in CodesPageContent.
export default function CodesPage() {
  const user = getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <CodesPageContent />
    </div>
  );
}
