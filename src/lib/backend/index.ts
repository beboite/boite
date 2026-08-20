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
// The CLI manager's rows and jobs, which the settings panel and its store both
// read. Re-exported here so a feature imports one module rather than reaching
// past the accessor into the type file.
export type { CliApi, CliDataPath, CliJob, CliJobPhase, CliLatest, CliRow } from "./types";
