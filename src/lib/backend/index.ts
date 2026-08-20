// Workspace transport accessor. backend() returns the active transport; the
// switchable workspace store lives in active.svelte.ts (runes need a .svelte.ts
// file). Façades call backend() at use time, so a workspace switch is picked up
// without any of them changing.
export {
  backend,
  backendFor,
  backendForPath,
  localBackend,
  workspace,
} from "./active.svelte";
export type { Backend } from "./types";
export type {
  SyncApi,
  SyncConflict,
  SyncField,
  SyncJob,
  SyncNotes,
  SyncPhase,
  SyncProbe,
  SyncSource,
  SyncStatus,
  SyncSyntax,
} from "./types";
