// Workspace transport accessor. Phase 3 wires the local desktop only, so the
// active backend is a module singleton. Phase 4 turns this into a switchable
// workspace store (local <-> remote) with an epoch that invalidates in-flight
// async work; the backend() call site stays the same.
import type { Backend } from "./types";
import { TauriBackend } from "./tauri";

const active: Backend = new TauriBackend();

export function backend(): Backend {
  return active;
}

export type { Backend } from "./types";
