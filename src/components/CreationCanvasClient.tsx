"use client";

import { useRouter } from "next/navigation";
import StoryboardCanvas from "./StoryboardCanvas";
import { CREATION_SEED_STAGES } from "@/lib/creation";
import type { CreationProject } from "@/lib/types";

// Thin wrapper so the generalized StoryboardCanvas (built for both the
// Video Analysis flow and this one) can be dropped straight onto a
// standalone Creation project's own storyboard, with its own API base path
// and its own 6-beat seed stages instead of a GeneratedScript's.
export default function CreationCanvasClient({ project }: { project: CreationProject }) {
  const router = useRouter();
  return (
    <StoryboardCanvas
      apiBase={`/api/creation/projects/${project.id}/storyboard`}
      initialStoryboard={project.storyboard}
      seedStages={CREATION_SEED_STAGES}
      onClose={() => router.push("/creation")}
    />
  );
}
