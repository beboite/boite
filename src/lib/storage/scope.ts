import { invoke } from "@tauri-apps/api/core";

// Registers project cwds as the filesystem trust boundary backend-side.
// Editor/explorer/git commands reject paths outside these roots.
export function registerProjectRoots(roots: string[]): Promise<void> {
  return invoke("register_project_roots", { roots });
}
