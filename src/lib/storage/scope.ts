import { backend } from "$lib/backend";

// Registers project cwds as the filesystem trust boundary backend-side.
// Editor/explorer/git commands reject paths outside these roots.
export function registerProjectRoots(roots: string[]): Promise<void> {
  return backend().scope.registerProjectRoots(roots);
}
