import type { GeneratedScriptStage } from "./types";

// The 6 beats a fresh Creation project's canvas is seeded with. Matches the
// funnel the "Generate video" button's stage-tag gating (planned next) will
// require to all be present and connected before it unlocks: Reaction ->
// Hook -> Pain Point -> Product Intro -> Desired Outcome -> CTA. Seeding
// them up front means a member starts from this shape instead of a blank
// canvas, but every one of these nodes stays freely editable/deletable —
// same freeform rules as the Video Analysis storyboard's seeded nodes.
export const CREATION_SEED_STAGES: GeneratedScriptStage[] = [
  { label: "Reaction", script: "", direction: "" },
  { label: "Hook", script: "", direction: "" },
  { label: "Pain Point", script: "", direction: "" },
  { label: "Product Intro", script: "", direction: "" },
  { label: "Desired Outcome", script: "", direction: "" },
  { label: "CTA", script: "", direction: "" },
];
