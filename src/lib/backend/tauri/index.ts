import type { Backend } from "../types";
import { tauriPty } from "./pty";
import { tauriDb, tauriWorkspaceMeta } from "./db";
import { tauriConduct } from "./conduct";
import {
  tauriAnswerAgentRequest,
  tauriApprovals,
  tauriCapturePane,
  tauriCheckpoints,
  tauriEditor,
  tauriExplorer,
  tauriCli,
  tauriCodexSwitcher,
  tauriFastMcpSsh,
  tauriKebaccSwitcher,
  tauriFastpick,
  tauriGit,
  tauriLog,
  tauriMcp,
  tauriProject,
  tauriScope,
  tauriSearch,
  tauriSession,
  tauriShell,
  tauriSync,
  tauriTelemetry,
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
  readonly checkpoints = tauriCheckpoints;
  readonly project = tauriProject;
  readonly system = tauriSystem;
  readonly shell = tauriShell;
  readonly fastpick = tauriFastpick;
  readonly codexSwitcher = tauriCodexSwitcher;
  readonly fastMcpSsh = tauriFastMcpSsh;
  readonly kebaccSwitcher = tauriKebaccSwitcher;
  readonly cli = tauriCli;
  readonly mcp = tauriMcp;
  readonly scope = tauriScope;
  readonly session = tauriSession;
  readonly search = tauriSearch;
  readonly sync = tauriSync;
  readonly telemetry = tauriTelemetry;
  readonly log = tauriLog;
  readonly approvals = tauriApprovals;
  readonly meta = tauriWorkspaceMeta;
  readonly conduct = tauriConduct;
  readonly answerAgentRequest = tauriAnswerAgentRequest;
  readonly capturePane = tauriCapturePane;
}
