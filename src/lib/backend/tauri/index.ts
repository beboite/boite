import type { Backend } from "../types";
import { tauriPty } from "./pty";
import { tauriDb } from "./db";
import {
  tauriEditor,
  tauriExplorer,
  tauriGit,
  tauriLog,
  tauriProject,
  tauriScope,
  tauriSession,
  tauriShell,
  tauriWorktree,
} from "./rpc";

export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;
  readonly caps = { clientStatus: true };
  readonly pty = tauriPty;
  readonly db = tauriDb;
  readonly git = tauriGit;
  readonly worktree = tauriWorktree;
  readonly explorer = tauriExplorer;
  readonly editor = tauriEditor;
  readonly project = tauriProject;
  readonly shell = tauriShell;
  readonly scope = tauriScope;
  readonly session = tauriSession;
  readonly log = tauriLog;
}
