import type { PermissionMode, ToolStatus } from '@boite/contracts';

/** What the agent sees as `clientInfo.name`. */
export const CLIENT_NAME = 'boite';

export const STDERR_MAX = 400;

/**
 * The model id that means "the agent keeps its own", the same spelling the ACP
 * driver uses. It is the descriptor's only model, and it is never sent on the
 * wire: Codex would refuse it as a model name.
 */
export const AGENT_OWN_MODEL = 'default';

/** How long a probe waits for `initialize` and `model/list` before giving up. */
export const PROBE_TIMEOUT_MS = 20_000;

/** `model/list` pages; a cursor loop that never ends is a bug, not a model list. */
export const PROBE_MAX_PAGES = 10;

/** How long a failed request waits for the child's exit before blaming itself. */
export const EXIT_GRACE_MS = 500;

/** Codex names no tool for a shell command, so the card carries the usual one. */
export const COMMAND_TOOL_NAME = 'Bash';

/** Nor for a patch: `fileChange` is the apply-patch item under another name. */
export const FILE_CHANGE_TOOL_NAME = 'ApplyPatch';

// ---------------------------------------------------------------------------
// The slice of the generated protocol this driver speaks
// ---------------------------------------------------------------------------

/** `AskForApproval`, minus the `granular` object this driver never sends. */
type AskForApproval = 'untrusted' | 'on-request' | 'never';

/** `SandboxMode`. */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** `TurnStatus`. */
type CodexTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

/** `TurnError`. */
export interface CodexTurnError {
  message?: string;
}

/** `Turn`, the fields an answer or a `turn/completed` is read for. */
export interface CodexTurnRecord {
  id: string;
  status: CodexTurnStatus;
  error?: CodexTurnError | null;
}

/** `TokenUsageBreakdown`. */
export interface CodexTokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/** `ReasoningEffortOption`: the effort id plus the sentence the server describes it with. */
interface CodexReasoningEffortOption {
  reasoningEffort?: string;
  description?: string;
}

/** `Model`, the fields the probe reads. The rest of the record is not Boite's business. */
export interface CodexModel {
  id?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
  serviceTiers?: { id: string; name: string; description?: string }[];
  defaultReasoningEffort?: string;
}

/** `ModelListResponse`. */
export interface CodexModelListResponse {
  data?: CodexModel[];
  nextCursor?: string | null;
}

/**
 * `ThreadItem`, flattened. The wire is a tagged union of twenty-odd variants
 * and this driver draws four of them, so the fields are read off one shape
 * rather than discriminated: an item type nobody maps is dropped.
 */
export interface CodexItem {
  type: string;
  id: string;
  status?: string;
  command?: string;
  cwd?: string | null;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  contentItems?: unknown;
}

/**
 * One entry of `item/tool/requestUserInput`'s `questions`. `options` is null on
 * a free-text question and, when it is a list, its entries are either plain
 * strings or objects: both spellings are read, because the wire has carried
 * both and neither is worth a refusal.
 */
export interface CodexQuestion {
  id?: string;
  header?: string;
  question?: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: unknown;
}

/**
 * The thread's permission mode as the pair Codex takes: `approvalPolicy`
 * (`AskForApproval`) and `sandbox` (`SandboxMode`). Both go out on
 * `thread/start` and `thread/resume`.
 *
 * `acceptEdits` is the same pair as `default`: Codex has no "edits without
 * asking, commands with asking" step, and a workspace-write sandbox already
 * lets it edit inside the folder without a question. `plan` is the read-only
 * pair, so nothing can be written and nothing is ever asked.
 *
 * Unlike ACP's `session/set_mode`, Codex has no call that changes the pair on a
 * live thread, so the mode is part of the session key: changing it opens a new
 * process, which resumes the same Codex thread id with the new pair.
 */
export const MODE_POLICY: Record<PermissionMode, { approvalPolicy: AskForApproval; sandbox: SandboxMode }> = {
  default: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'never', sandbox: 'read-only' },
  bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  dontAsk: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

/** What `thread/start` and `thread/resume` answer beside the thread. */
export interface CodexThreadOpened {
  thread: { id: string };
  model?: unknown;
  modelProvider?: unknown;
}

export type Timer = ReturnType<typeof setTimeout>;

/** What one Codex `ThreadItem` is drawn as, or null when the contract has no part for it. */
export interface ToolView {
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}
