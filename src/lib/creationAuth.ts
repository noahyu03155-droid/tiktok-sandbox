// Shared ownership check for every /api/creation/projects/[projectId]/...
// route (the top-level CRUD route and all 7 mirrored storyboard sub-routes).
// A project is only visible/editable by the member who owns it, or by an
// admin (who can see every member's folder per the Creation section's
// "admin sees everyone as thumbnails" requirement).
import { getCurrentUser, type CurrentUser } from "./session";
import { getCreationProject } from "./db";
import type { CreationProject } from "./types";

export type ProjectAccessResult =
  | { ok: true; user: CurrentUser; project: CreationProject }
  | { ok: false; status: number; error: string };

export function requireProjectAccess(projectId: string): ProjectAccessResult {
  const user = getCurrentUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in" };
  const project = getCreationProject(projectId);
  if (!project) return { ok: false, status: 404, error: "Project not found" };
  if (project.ownerId !== user.userId && user.role !== "admin") {
    return { ok: false, status: 403, error: "You don't have access to this project" };
  }
  return { ok: true, user, project };
}
