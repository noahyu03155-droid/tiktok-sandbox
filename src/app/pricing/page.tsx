import { Suspense } from "react";
import { getCurrentUser } from "@/lib/session";
import { getUserById } from "@/lib/db";
import PricingPageContent from "@/components/PricingPageContent";

export const dynamic = "force-dynamic";

// Reached either straight after registration (RegisterForm -> /onboarding
// -> here, once middleware.ts sees planActive=false) or any time later if
// someone's plan lapses — src/middleware.ts is what actually enforces the
// gate; this page is just the picker. Still requires a logged-in session
// (middleware exempts /pricing from the PLAN check, not from login itself),
// so getCurrentUser() should never be null in practice here.
export default function PricingPage() {
  const sessionUser = getCurrentUser();
  const dbUser = sessionUser ? getUserById(sessionUser.userId) : null;
  return (
    <Suspense fallback={null}>
      <PricingPageContent
        currentPlan={dbUser?.plan ?? null}
        currentBillingCycle={dbUser?.billingCycle ?? null}
        currentSeats={dbUser?.seats ?? 0}
        planStatus={dbUser?.planStatus ?? "none"}
      />
    </Suspense>
  );
}
