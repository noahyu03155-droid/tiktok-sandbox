"use client";

import { useRouter } from "next/navigation";
import StoryboardCanvas from "./StoryboardCanvas";
import { CREATION_SEED_STAGES } from "@/lib/creation";
import type { CreationProject, UserRole } from "@/lib/types";

// Thin wrapper so the generalized StoryboardCanvas (built for both the
// Video Analysis flow and this one) can be dropped straight onto a
// standalone Creation project's own storyboard, with its own API base path
// and its own 6-beat seed stages instead of a GeneratedScript's.
export default function CreationCanvasClient({ project, role }: { project: CreationProject; role: UserRole }) {
  const router = useRouter();
  // Non-admin ("member") accounts have exactly one implicit canvas — visiting
  // /creation for them isn't a project list, it's a server redirect straight
  // BACK into this same project (see src/app/creation/page.tsx). Pointing
  // Close at "/creation" for a member therefore just bounces them right back
  // to where they started, which looks like the button does nothing. Admins
  // do have a real project list at /creation, so that's still the right
  // destination for them.
  const closeHref = role === "admin" ? "/creation" : "/";
  return (
    <StoryboardCanvas
      apiBase={`/api/creation/projects/${project.id}/storyboard`}
      initialStoryboard={project.storyboard}
      seedStages={CREATION_SEED_STAGES}
      onClose={() => router.push(closeHref)}
    />
  );
}
