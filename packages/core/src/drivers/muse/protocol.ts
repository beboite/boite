import type { PermissionMode, ToolStatus } from '@boite/contracts';

/** What the host records as `clientInfo.name` on every approval it logs. */
export const CLIENT_NAME = 'boite';

export const CLIENT_TITLE = 'Boite';

/** The one MSP envelope version this driver speaks. */
export const SCHEMA_VERSION = 1;

/** The provider routing of every Muse model; `echo` is the host's own fake. */
export const META_PROVIDER = 'meta';

export const STDERR_MAX = 400;

/** The descriptor's only model, "the agent keeps its own". Never sent on the wire. */
export const AGENT_OWN_MODEL = 'default';

/** How long a probe waits for `initialize` and `model/list` before giving up. */
export const PROBE_TIMEOUT_MS = 20_000;

/** How long a failed request waits for the child's exit before blaming itself. */
export const EXIT_GRACE_MS = 500;

/** How long a stopped turn waits for its `turn/completed` before the host is closed. */
export const INTERRUPT_DEADLINE_MS = 30_000;

/** Muse names its shell tool on its own; the card carries the usual one when a command is known. */
export const COMMAND_TOOL_NAME = 'Bash';

export const SUBAGENT_TOOL_NAME = 'Task';

/** `ReasoningEffort` on the wire. A thread effort outside it never reaches `turn/start`. */
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** The scale `muse --help` advertises, for a model whose catalog row lists none. */
export const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** `muse --reasoning-effort` defaults to this. */
export const DEFAULT_EFFORT = 'high';

// ---------------------------------------------------------------------------
// The slice of the MSP schema this driver speaks
// ---------------------------------------------------------------------------

/** `ApprovalMode`: preconfigured on the host, selected on the wire. */
type ApprovalMode = 'allowAll' | 'promptUnmatched' | 'onRequest' | 'denyUnmatched';

/** `InitializeResult`, the fields read here. */
export interface InitializeResult {
  museHome?: string;
  schema?: { version?: number; fingerprint?: string };
  serverInfo?: { version?: string };
}

/** `Session`, the fields read here. */
export interface MuseSessionRecord {
  sessionId: string;
  modelId?: string | null;
  approvalMode?: { mode?: string } | null;
}

/** `TokenUsage`. */
export interface MuseTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `Item`, flattened: the fields of the kinds this driver draws. */
export interface MuseItem {
  itemId: string;
  kind: string;
  revision?: number;
  status?: string;
  turnId?: string | null;
  text?: string;
  summary?: string[];
  tool?: string;
  args?: string;
  visibleOutput?: string;
  failureReason?: string;
  commandText?: string;
  objective?: string;
  role?: string;
  result?: { summary?: string; text?: string };
  trigger?: string;
  outcome?: string;
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

/** `ApprovalRequirementRef`: which stage of a multi-stage approval a decision is for. */
interface RequirementRef {
  approvalId: string;
  sourceIndex: number;
}

/** `ApprovalChoice`. */
export interface ApprovalChoice {
  choiceId: string;
  decision: string;
  label?: string;
  scope?: string;
}

/** `ApprovalSubject`. `kind` is an open discriminator: shell, fileAccess, network, tool and more. */
interface ApprovalSubject {
  kind?: string;
  access?: string;
  command?: string;
  path?: string;
  host?: string;
  port?: number;
  toolName?: string;
  target?: string;
}

/** `approval/requested` and `approval/updated`, the fields read here. */
export interface ApprovalParams {
  approvalId?: string;
  turnId?: string;
  toolName?: string;
  rawArgs?: string;
  protectedWrite?: boolean;
  judgeEscalated?: boolean;
  currentRequirementId?: RequirementRef;
  availableChoices?: ApprovalChoice[];
  subject?: ApprovalSubject;
}

/** `UserInputQuestion`. */
export interface MuseQuestion {
  id?: string;
  header?: string;
  question?: string;
  options?: { label?: string; description?: string }[];
  selection?: { mode?: string };
}

/** `UserInputAnswer`. */
export interface MuseAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
}

/** `ModelCatalogEntry`, the fields the probe reads. */
interface MuseModel {
  modelId?: string;
  displayLabel?: string;
  providerId?: string;
  profileId?: string | null;
  isDefault?: boolean;
}

/** `ModelListResult`. */
export interface MuseModelList {
  models?: MuseModel[];
  providerId?: string;
  profileId?: string | null;
  source?: string;
}

/**
 * The thread's permission mode as the two things Muse takes. The approval mode
 * goes on the wire, on `session/start` and through `session/setApprovalMode`,
 * so it follows a change on a warm host. The sandbox flags are fixed for the
 * host's lifetime (`muse serve --help` says so), so they are part of the
 * session key and a change there opens a new host.
 *
 * `acceptEdits` is `promptUnmatched` plus one rule of this driver: a write
 * inside the thread's folder that Muse itself did not flag as protected or
 * escalated is approved without a card. `plan` is a host that can neither
 * write nor run a shell, and whatever is left unmatched is denied rather than
 * asked. `bypassPermissions` and `dontAsk` allow everything and drop the
 * shell sandbox.
 */
export const MODE_POSTURE: Record<PermissionMode, { approvalMode: ApprovalMode; flags: readonly string[] }> = {
  default: { approvalMode: 'promptUnmatched', flags: [] },
  acceptEdits: { approvalMode: 'promptUnmatched', flags: [] },
  plan: { approvalMode: 'denyUnmatched', flags: ['--disable-write', '--disable-shell'] },
  bypassPermissions: { approvalMode: 'allowAll', flags: ['--disable-sandbox'] },
  dontAsk: { approvalMode: 'allowAll', flags: ['--disable-sandbox'] },
};

/** A probe lists models and runs nothing: no writes, no shell, no durable session log. */
export const PROBE_FLAGS = ['--no-session-log', '--disable-write', '--disable-shell'] as const;

export type Timer = ReturnType<typeof setTimeout>;

export interface ToolView {
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/** One approval still open, and the stage its next decision is for. */
export interface OpenApproval {
  approvalId: string;
  turnId: string | null;
  requirement: RequirementRef;
  choices: ApprovalChoice[];
  subject: ApprovalSubject;
  toolName: string;
  rawArgs: string;
  protectedWrite: boolean;
  judgeEscalated: boolean;
  /** The stage a decision was already sent for; a later stage needs another card. */
  decidedStage: number | null;
  asking: boolean;
  /** Settles a card still waiting when the host resolved the approval on its own. */
  external: (decision: 'allow' | 'deny') => void;
  externally: Promise<'allow' | 'deny'>;
}
