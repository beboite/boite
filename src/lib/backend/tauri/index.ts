import type { Backend } from "../types";
import { tauriPty } from "./pty";
import { tauriDb, tauriWorkspaceMeta } from "./db";
import {
  tauriAnswerAgentRequest,
  tauriApprovals,
  tauriCapturePane,
  tauriEditor,
  tauriExplorer,
  tauriFastpick,
  tauriGit,
  tauriLog,
  tauriProject,
  tauriScope,
  tauriSession,
  tauriShell,
  tauriSystem,
  tauriWorktree,
} from "./rpc";

export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;
  readonly caps = { clientStatus: true, appLogs: true };
  readonly pty = tauriPty;
  readonly db = tauriDb;
  readonly git = tauriGit;
  readonly worktree = tauriWorktree;
  readonly explorer = tauriExplorer;
  readonly editor = tauriEditor;
  readonly project = tauriProject;
  readonly system = tauriSystem;
  readonly shell = tauriShell;
  readonly fastpick = tauriFastpick;
  readonly scope = tauriScope;
  readonly session = tauriSession;
  readonly log = tauriLog;
  readonly approvals = tauriApprovals;
  readonly meta = tauriWorkspaceMeta;
  readonly answerAgentRequest = tauriAnswerAgentRequest;
  readonly capturePane = tauriCapturePane;
}
