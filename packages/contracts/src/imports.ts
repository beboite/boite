import type { AccountId, ProjectId, ProviderId, ThreadId, Timestamp } from './ids';
import type { PairedSession } from './pairing';
import type { ThreadSummary } from './threads';

// ---------------------------------------------------------------------------
// Imports: a session an agent ran outside Boite, read from its own transcript
// files and turned into a thread the agent can resume.
// ---------------------------------------------------------------------------

/** One session an account's agent kept on disk for a project's folder. Claude Code today. */
export interface ImportableSession {
  providerId: ProviderId;
  accountId: AccountId;
  /** Accounts that can import this same file; older cores supply only accountId. */
  accountIds?: AccountId[];
  /** The agent's own id for the session, what a resumed turn hands back to it. */
  sessionId: string;
  /** The transcript file, absolute. */
  file: string;
  /** The title: the agent's own when the transcript carries one, else the first prompt's first line. */
  title: string;
  /** The first prompt's time. */
  startedAt: Timestamp;
  /** The file's last write. */
  updatedAt: Timestamp;
  bytes: number;
  /** The thread that already carries this session, so it is not imported twice. */
  threadId: ThreadId | null;
}

/** The longest text of one system block `threads.agentShape` sends; the rest stays on disk. */
export const AGENT_SHAPE_BLOCK_MAX = 32_000;
/** The text of every system block together, after which blocks keep their size but lose their text. */
export const AGENT_SHAPE_TEXT_BUDGET = 200_000;
/** System blocks and tools listed by `threads.agentShape`; the rest are counted in the totals only. */
export const AGENT_SHAPE_ITEMS_MAX = 256;

/** One block of the system prompt the agent sent. */
export interface AgentShapeBlock {
  /** Its length in characters, whole. */
  chars: number;
  /** Its text, cut at `AGENT_SHAPE_BLOCK_MAX` or by `AGENT_SHAPE_TEXT_BUDGET`. */
  text: string;
  truncated: boolean;
}

/** One tool definition the agent sent. */
export interface AgentShapeTool {
  name: string;
  descriptionChars: number;
  /** The whole definition as JSON: name, description and input schema. */
  chars: number;
}

/**
 * What the agent's last API request started with: the system prompt and tool
 * definitions Claude Code wrote into its session transcript (CLI 2.1.300 and
 * later), and the request's parameters. `status` says why the rest is empty:
 * `no-session` before the first turn, `no-transcript` when the file is gone,
 * `unrecorded` when the CLI wrote no request shape (older than 2.1.300).
 * Sizes are characters; `estimatedTokens` is characters divided by four, an
 * estimate and not the provider's count.
 */
export interface AgentShape {
  threadId: ThreadId;
  status: 'ready' | 'no-session' | 'no-transcript' | 'unrecorded';
  sessionId: string | null;
  /** The Claude Code version that wrote the request. */
  version: string | null;
  /** When the request was sent. */
  at: Timestamp | null;
  model: string | null;
  effort: string | null;
  /** The `thinking` type, with its token budget when it has one. */
  thinking: string | null;
  betas: string[];
  maxTokens: number | null;
  /** In the order they were sent. */
  system: AgentShapeBlock[];
  /** Largest first. */
  tools: AgentShapeTool[];
  /** System blocks and tools past `AGENT_SHAPE_ITEMS_MAX`, counted in `chars` but not listed. */
  omitted: { system: number; tools: number };
  chars: { system: number; tools: number };
  estimatedTokens: number;
}

export interface ImportsRpcMethods {
  /** Every paired client still able to connect. */
  'sessions.list': { params: Record<string, never>; result: PairedSession[] };
  /** Forget a paired client: its sockets close and its token opens nothing any more. Owner only. */
  'sessions.revoke': { params: { sessionId: string }; result: { ok: true } };

  /**
   * The sessions the project's folder has on disk across every account whose
   * agent keeps transcripts (Claude Code: `<config dir>/projects/<folder>/*.jsonl`),
   * newest first. A file with no prompt is left out.
   */
  'imports.list': { params: { projectId: ProjectId }; result: ImportableSession[] };
  /**
   * One session read whole into a new thread: one finished turn per prompt,
   * the answers with their reasoning and tool calls, the session id set so
   * the next turn resumes it. Refused by name when the session is already a
   * thread, the account's agent keeps no transcripts, or the file has no prompt.
   */
  'imports.run': {
    params: { projectId: ProjectId; accountId: AccountId; sessionId: string };
    result: ThreadSummary;
  };
}

export interface ImportsRpcEvents {
  /** A session was created or revoked: the list to re-read is `sessions.list`. */
  'sessions.updated': { sessionId: string; state: 'created' | 'revoked' };
}
