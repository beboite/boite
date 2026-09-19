/**
 * The client half of Muse Code's session protocol (MSP): `muse serve` over the
 * agent's own stdio, JSON-RPC 2.0 framed as ndjson. Shaped like `codex.ts`,
 * with its own transport rather than `@muse-code/sdk`: the SDK spawns its own
 * child through `node:child_process`, and every agent process here has to go
 * through `procs.spawnChild` to land in the trace and the Job Object.
 *
 * The names are the ones `muse schema generate-ts` writes: `initialize`,
 * `session/start`, `session/resume`, `turn/start`, `turn/interrupt`,
 * `session/compact`, `approval/decide`, `userInput/answer`, and the `item/*`,
 * `turn/*`, `approval/*`, `userInput/*` and `session/*` notifications. Three
 * rules of the wire shape everything below:
 *
 * - Every command carries a client-minted UUIDv7 `commandId`, and a fresh
 *   turn's id is the `commandId` of the `turn/start` that opened it.
 * - Approvals and questions arrive as notifications (`approval/requested`,
 *   `userInput/requested`) and are answered with commands. The server-request
 *   forms of both are refused, which is what the host expects of a client that
 *   decides through `approval/decide`.
 * - An item notification carries the whole item so far. Text already written
 *   from `item/delta` is skipped, only the unseen suffix is drawn.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AccountId,
  AgentTask,
  EffortLevel,
  ImageAttachment,
  MessageId,
  MessagePart,
  ModelInfo,
  PermissionMode,
  ProviderDescriptor,
  ProviderId,
  QuestionAnswer,
  QuestionOption,
  ThreadId,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import pkg from '../../package.json';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild } from '../procs.ts';
import { agentEnv, profileFor, resolveExecutable } from '../providers/loader.ts';
import type {
  Driver,
  ProbeContext,
  ProbeFilter,
  ProbeResult,
  QuestionAsk,
  TurnContext,
  TurnHandle,
  TurnResult,
} from './types.ts';

/** What the host records as `clientInfo.name` on every approval it logs. */
const CLIENT_NAME = 'boite';
const CLIENT_TITLE = 'Boite';
/** The one MSP envelope version this driver speaks. */
const SCHEMA_VERSION = 1;
/** The provider routing of every Muse model; `echo` is the host's own fake. */
const META_PROVIDER = 'meta';
const MINUTE_MS = 60_000;
const STDERR_MAX = 400;
/** The descriptor's only model, "the agent keeps its own". Never sent on the wire. */
const AGENT_OWN_MODEL = 'default';
/** How long a probe waits for `initialize` and `model/list` before giving up. */
const PROBE_TIMEOUT_MS = 20_000;
/** How long a failed request waits for the child's exit before blaming itself. */
const EXIT_GRACE_MS = 500;
/** How long a stopped turn waits for its `turn/completed` before the host is closed. */
const INTERRUPT_DEADLINE_MS = 30_000;
/** Muse names its shell tool on its own; the card carries the usual one when a command is known. */
const COMMAND_TOOL_NAME = 'Bash';
const SUBAGENT_TOOL_NAME = 'Task';
/** `ReasoningEffort` on the wire. A thread effort outside it never reaches `turn/start`. */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
/** The scale `muse --help` advertises, for a model whose catalog row lists none. */
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** `muse --reasoning-effort` defaults to this. */
const DEFAULT_EFFORT = 'high';

// ---------------------------------------------------------------------------
// The slice of the MSP schema this driver speaks
// ---------------------------------------------------------------------------

/** `ApprovalMode`: preconfigured on the host, selected on the wire. */
type ApprovalMode = 'allowAll' | 'promptUnmatched' | 'onRequest' | 'denyUnmatched';

/** `InitializeResult`, the fields read here. */
interface InitializeResult {
  museHome?: string;
  schema?: { version?: number; fingerprint?: string };
  serverInfo?: { version?: string };
}

/** `Session`, the fields read here. */
interface MuseSessionRecord {
  sessionId: string;
  modelId?: string | null;
  approvalMode?: { mode?: string } | null;
}

/** `TokenUsage`. */
interface MuseTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `Item`, flattened: the fields of the kinds this driver draws. */
interface MuseItem {
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
interface ApprovalChoice {
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
interface ApprovalParams {
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
interface MuseQuestion {
  id?: string;
  header?: string;
  question?: string;
  options?: { label?: string; description?: string }[];
  selection?: { mode?: string };
}

/** `UserInputAnswer`. */
interface MuseAnswer {
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
interface MuseModelList {
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
const MODE_POSTURE: Record<PermissionMode, { approvalMode: ApprovalMode; flags: readonly string[] }> = {
  default: { approvalMode: 'promptUnmatched', flags: [] },
  acceptEdits: { approvalMode: 'promptUnmatched', flags: [] },
  plan: { approvalMode: 'denyUnmatched', flags: ['--disable-write', '--disable-shell'] },
  bypassPermissions: { approvalMode: 'allowAll', flags: ['--disable-sandbox'] },
  dontAsk: { approvalMode: 'allowAll', flags: ['--disable-sandbox'] },
};

/** A probe lists models and runs nothing: no writes, no shell, no durable session log. */
const PROBE_FLAGS = ['--no-session-log', '--disable-write', '--disable-shell'] as const;

type Timer = ReturnType<typeof setTimeout>;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

let lastMintMs = 0;
let lastMintSeq = 0;

/**
 * A UUIDv7, which is what MSP wants for every `commandId` and a new session
 * id. Ids minted within one millisecond carry an increasing counter in the
 * random bits, so two commands sent back to back still sort in order.
 */
export function mintUuidV7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  if (now <= lastMintMs) {
    lastMintSeq = (lastMintSeq + 1) & 0x0fff;
    now = lastMintMs;
  } else {
    lastMintMs = now;
    lastMintSeq = 0;
  }
  let ms = now;
  for (let at = 5; at >= 0; at -= 1) {
    bytes[at] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((lastMintSeq >> 8) & 0x0f);
  bytes[7] = lastMintSeq & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// The transport: ndjson JSON-RPC 2.0 over the child's stdio
// ---------------------------------------------------------------------------

/** An MSP error answer: its code, and the `data.kind` and `data.reason` the host sends with it. */
export class MspError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly kind: string | null,
    readonly reason: string | null,
  ) {
    super(message);
    this.name = 'MspError';
  }
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

class MuseRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    private readonly child: SpawnedChild,
    private readonly handlers: RpcHandlers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.feed(chunk);
    });
    child.stdin.on('error', () => undefined);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`the muse host is gone, ${method} was not sent`));
        return;
      }
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** A command: a request whose params carry a fresh `commandId`. */
  command<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.request<T>(method, { commandId: mintUuidV7(), ...params });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** The child is gone: every request still waiting is answered, loudly. */
  fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(new Error(reason));
  }

  private write(payload: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // the pipe is already gone; the exit path says what happened
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.handlers.log('warn', `muse host: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const method = message['method'];
    const id = message['id'];
    if (typeof method === 'string' && id !== undefined && id !== null) {
      // `approval/request` and `userInput/request`: Boite decides both through
      // their notification and a command, so the request form is declined.
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `boite answers ${method} through its notification, not as a request` },
      });
      return;
    }
    if (typeof method === 'string') {
      const params = message['params'];
      this.handlers.notification(
        method,
        params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {},
      );
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    const error = message['error'];
    if (error !== undefined && error !== null) {
      entry.reject(mspErrorOf(entry.method, error));
      return;
    }
    entry.resolve(message['result']);
  }
}

function mspErrorOf(method: string, raw: unknown): MspError {
  const error = (raw ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  const data = (error.data ?? {}) as { kind?: unknown; reason?: unknown };
  const kind = typeof data.kind === 'string' ? data.kind : null;
  const reason = typeof data.reason === 'string' ? data.reason : null;
  const text = typeof error.message === 'string' ? error.message : JSON.stringify(raw);
  return new MspError(method, typeof error.code === 'number' ? error.code : 0, text, kind, reason);
}

/** `initialize` then `initialized`, refusing an envelope this driver does not speak. */
async function handshake(rpc: MuseRpc): Promise<InitializeResult> {
  const result = await rpc.request<InitializeResult>('initialize', {
    clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: pkg.version },
    capabilities: { userInputDialogs: true },
  });
  const version = result.schema?.version;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `the muse host speaks MSP envelope version ${version ?? 'unknown'}, Boite speaks ${SCHEMA_VERSION}: update Muse Code or Boite`,
    );
  }
  rpc.notify('initialized', {});
  return result;
}

// ---------------------------------------------------------------------------
// The turn and what it draws
// ---------------------------------------------------------------------------

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

interface ToolView {
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One `turn/start`, or one `session/compact`, and what it wrote. The parts are
 * drawn the way every other driver draws them: one text part the deltas append
 * to, one part per tool item, one part per approval and per question.
 */
class MuseTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private readonly tools = new Map<string, ToolEntry>();
  /** Per item and field, the text already drawn: a snapshot only adds what is past it. */
  private readonly surfaces = new Map<string, string>();

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private decide: () => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves the moment the outcome is known, before anything is journalled. */
  readonly finished: Promise<void>;
  /** Resolves on `stop()`, so an approval or a question still waiting moves on. */
  readonly stopped: Promise<void>;

  sessionId: string | null;
  /** The Muse turn id: the `commandId` of the `turn/start`, then the one its ack names. */
  turnId: string | null = null;
  usage: Usage | null = null;
  /** `session/tokenUsage` summed over the turn, for a `turn/completed` that carries none. */
  observed: Usage | null = null;
  decided = false;
  isStopped = false;
  settled = false;

  constructor(readonly ctx: TurnContext) {
    this.sessionId = ctx.sessionId;
    this.done = new Promise<TurnResult>((resolve) => {
      this.resolve = resolve;
    });
    this.finished = new Promise<void>((resolve) => {
      this.decide = resolve;
    });
    this.stopped = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  get compacting(): boolean {
    return this.ctx.turn.execution?.operation === 'compact';
  }

  markStopped(): void {
    this.isStopped = true;
    this.wake();
  }

  /** The turn's outcome as `turn/completed` states it. */
  finish(terminal: string, error: string | null): void {
    if (this.decided) return;
    if (terminal === 'cancelled') this.status = 'stopped';
    else if (terminal !== 'completed') {
      this.fail(error ?? `the muse turn ended ${terminal}`);
      return;
    }
    this.decided = true;
    this.decide();
  }

  fail(reason: string): void {
    if (this.decided) return;
    this.decided = true;
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
    this.decide();
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.decided = true;
    this.wake();
    this.decide();
    if (this.messageId !== null) {
      this.ctx.emit.complete(this.messageId, this.status === 'error' ? 'error' : 'complete');
    }
    this.resolve({
      status: this.status,
      sessionId: this.sessionId,
      usage: this.usage ?? this.observed,
      error: this.error ?? undefined,
    });
  }

  // -- parts ----------------------------------------------------------------

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.message(), index, part);
  }

  takeIndex(): number {
    this.textIndex = null;
    this.thinkingIndex = null;
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }

  private writeText(text: string): void {
    if (text.length === 0) return;
    if (this.textIndex === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.textIndex = index;
      this.thinkingIndex = null;
      this.part(index, { type: 'text', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.textIndex, text);
  }

  private writeThinking(text: string): void {
    if (text.length === 0) return;
    if (this.thinkingIndex === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.thinkingIndex = index;
      this.textIndex = null;
      this.part(index, { type: 'thinking', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.thinkingIndex, text);
  }

  private write(kind: 'text' | 'thinking', text: string): void {
    if (kind === 'text') this.writeText(text);
    else this.writeThinking(text);
  }

  /** An `item/delta`: appended as it comes, and remembered so the next snapshot skips it. */
  appendDelta(itemId: string, field: string, kind: 'text' | 'thinking', delta: string): void {
    const key = `${itemId}:${field}`;
    this.surfaces.set(key, (this.surfaces.get(key) ?? '') + delta);
    this.write(kind, delta);
  }

  /**
   * A snapshot of the whole text so far. Only the suffix nobody drew yet goes
   * out; a snapshot that does not extend what was drawn replaces nothing,
   * because a delta already sent cannot be taken back.
   */
  appendSnapshot(itemId: string, field: string, kind: 'text' | 'thinking', text: string | undefined): void {
    if (text === undefined || text.length === 0) return;
    const key = `${itemId}:${field}`;
    const drawn = this.surfaces.get(key) ?? '';
    if (text.length <= drawn.length || !text.startsWith(drawn)) return;
    this.surfaces.set(key, text);
    this.write(kind, text.slice(drawn.length));
  }

  /** Every item notification redraws the same card, found by item id. */
  upsertTool(itemId: string, view: ToolView): void {
    const entry = this.tools.get(itemId) ?? {
      index: this.takeIndex(),
      name: view.name,
      input: null,
      output: null,
      status: 'running' as ToolStatus,
    };
    entry.name = view.name;
    if (view.input !== undefined) entry.input = view.input;
    if (view.output !== null) entry.output = view.output;
    entry.status = view.status;
    this.tools.set(itemId, entry);
    this.part(entry.index, {
      type: 'tool',
      toolId: itemId,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
    });
  }
}

/** One approval still open, and the stage its next decision is for. */
interface OpenApproval {
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

/** One question set still open, settled by an answer, a stop or the host itself. */
interface OpenQuestion {
  settle: () => void;
  settled: Promise<null>;
}

// ---------------------------------------------------------------------------
// The session: one `muse serve` host per thread
// ---------------------------------------------------------------------------

/**
 * One `muse serve` process for a thread: one `initialize`, one `session/start`
 * or `session/resume`, then one `turn/start` per turn. With
 * `warmProcessMinutes` at zero the host goes with the turn; above zero it takes
 * the next turns of the thread until the idle window, a stop, an archive, core
 * shutdown or a changed setup ends it.
 */
class MuseSession {
  private child: SpawnedChild | null = null;
  private rpc: MuseRpc | null = null;
  private starting: Promise<void> | null = null;

  /** The Muse session id: what `ctx.sessionId` stores and `session/resume` takes. */
  private sessionId: string | null = null;
  /** The session's model and approval mode as the host last reported them. */
  private modelId: string | null = null;
  private approvalMode: string | null = null;
  private lastStderr = '';
  private exitCode: number | null = null;
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  private current: MuseTurn | null = null;
  private contextSink: TurnContext['context'] | null = null;
  private readonly items = new Map<string, { kind: string; revision: number }>();
  private readonly approvals = new Map<string, OpenApproval>();
  private readonly questions = new Map<string, OpenQuestion>();
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly onEnded: (session: MuseSession) => void,
  ) {}

  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0;
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: MuseTurn, warmMs: number): void {
    this.warmMs = warmMs;
    this.running += 1;
    this.clearIdle();
    this.queue = this.queue.then(async () => {
      try {
        await this.runTurn(turn);
      } catch (error) {
        turn.fail(messageOf(error));
        this.endTurn(turn, true);
      }
    });
  }

  /**
   * `turn/interrupt`, then the turn's own `turn/completed`. A host that does not
   * confirm within the deadline is closed, and the turn ends stopped anyway.
   */
  stopTurn(turn: MuseTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    if (this.current !== turn) return;
    if (turn.compacting) {
      // A compaction has no turn to interrupt; the stop is the user's to take.
      turn.finish('cancelled', null);
      return;
    }
    this.interrupt(turn);
  }

  private interrupt(turn: MuseTurn): void {
    const rpc = this.rpc;
    const sessionId = this.sessionId;
    if (rpc === null || sessionId === null || turn.turnId === null) return;
    void rpc.command('turn/interrupt', { sessionId, turnId: turn.turnId }).catch((error: unknown) => {
      turn.ctx.log('warn', `muse: turn/interrupt failed: ${messageOf(error)}`);
    });
    const deadline = setTimeout(() => {
      if (turn.decided) return;
      turn.ctx.log('warn', `muse: the host did not confirm the stop in ${INTERRUPT_DEADLINE_MS / 1000} s, closing it`);
      turn.finish('cancelled', null);
      this.closing = true;
    }, INTERRUPT_DEADLINE_MS);
    deadline.unref?.();
    void turn.finished.then(() => {
      clearTimeout(deadline);
    });
  }

  close(reason: string | null, ctx?: TurnContext): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `muse session: ${reason}`);
    this.drop();
  }

  // -- the turn -------------------------------------------------------------

  private async runTurn(turn: MuseTurn): Promise<void> {
    try {
      await this.start(turn.ctx);
    } catch (error) {
      turn.fail(messageOf(error));
      this.endTurn(turn, true);
      return;
    }

    const rpc = this.rpc;
    const sessionId = this.sessionId;
    if (rpc === null || sessionId === null) {
      turn.fail('the muse session went away before the turn');
      this.endTurn(turn, true);
      return;
    }

    turn.sessionId = sessionId;
    this.current = turn;
    this.contextSink = turn.ctx.context;
    const ctx = turn.ctx;
    try {
      await this.align(rpc, sessionId, ctx);
      if (turn.compacting) {
        const result = await rpc.command<{ status?: string; reason?: string }>('session/compact', { sessionId });
        if (result.status === 'noop') {
          turn.fail(`Muse had nothing to compact${result.reason === undefined ? '' : ` (${result.reason})`}`);
        }
      } else {
        const commandId = mintUuidV7();
        // A fresh turn's id is its commandId, known before the ack: an item that
        // arrives ahead of the answer still finds its turn.
        turn.turnId = commandId;
        const effort = effortOf(ctx);
        const started = await rpc.request<{ turnId?: string }>('turn/start', {
          commandId,
          sessionId,
          input: inputOf(ctx.prompt, ctx.attachments),
          ...(ctx.prompt.length === 0 ? {} : { displayText: ctx.prompt }),
          ...(effort === null ? {} : { reasoningEffort: effort }),
        });
        if (typeof started.turnId === 'string' && started.turnId.length > 0) turn.turnId = started.turnId;
        if (turn.isStopped) this.interrupt(turn);
      }
    } catch (error) {
      const code = await this.exitWithin(EXIT_GRACE_MS);
      turn.fail(code === undefined ? commandFailure(error) : this.exitSentence(code));
      this.current = null;
      this.endTurn(turn, true);
      return;
    }

    await turn.finished;
    this.current = null;
    this.endTurn(turn, turn.isStopped);
  }

  /**
   * The thread as it stands for this turn: its model and its approval mode,
   * sent only when the host reports something else. The effort rides on
   * `turn/start` itself.
   */
  private async align(rpc: MuseRpc, sessionId: string, ctx: TurnContext): Promise<void> {
    const model = modelOf(ctx);
    if (model !== null && model !== this.modelId) {
      await rpc.command('session/setModel', { sessionId, model: { modelId: model, providerId: META_PROVIDER } });
      this.modelId = model;
    }
    const mode = MODE_POSTURE[ctx.thread.permissionMode].approvalMode;
    if (mode !== this.approvalMode) {
      await rpc.command('session/setApprovalMode', { sessionId, mode });
      this.approvalMode = mode;
    }
  }

  private endTurn(turn: MuseTurn, drop: boolean): void {
    turn.settle();
    this.running = Math.max(0, this.running - 1);
    if (drop || this.closing || this.warmMs <= 0) {
      this.drop();
      return;
    }
    if (this.running === 0) this.armIdle();
  }

  // -- the process ----------------------------------------------------------

  private start(ctx: TurnContext): Promise<void> {
    if (this.starting === null) this.starting = this.open(ctx);
    return this.starting;
  }

  private async open(ctx: TurnContext): Promise<void> {
    const executable = museExecutable(ctx.provider);
    const posture = MODE_POSTURE[ctx.thread.permissionMode];
    const child = ctx.spawnChild(executable, [...(profileFor(ctx.provider)?.launch?.args ?? []), ...posture.flags], {
      cwd: ctx.thread.cwd,
      env: agentEnv(ctx.provider, ctx.accountEnv),
    });
    this.child = child;
    const rpc = new MuseRpc(child, {
      notification: (method, params) => {
        this.onNotification(method, params);
      },
      log: (level, message) => {
        ctx.log(level, message);
      },
    });
    this.rpc = rpc;
    this.watch(child, ctx, rpc);

    await handshake(rpc);

    if (ctx.sessionId !== null) {
      const resumed = await rpc.command<{ session: MuseSessionRecord }>('session/resume', {
        sessionId: ctx.sessionId,
        excludeItems: true,
      });
      this.adopt(resumed.session);
      return;
    }

    const model = modelOf(ctx);
    const created = await rpc.command<{ session: MuseSessionRecord }>('session/start', {
      sessionId: mintUuidV7(),
      workspaceRoot: ctx.thread.cwd,
      approvalMode: posture.approvalMode,
      ...(model === null ? {} : { modelId: model, providerId: META_PROVIDER }),
    });
    this.adopt(created.session);
  }

  private adopt(session: MuseSessionRecord): void {
    this.sessionId = session.sessionId;
    this.modelId = session.modelId ?? null;
    this.approvalMode = session.approvalMode?.mode ?? null;
  }

  private watch(child: SpawnedChild, ctx: TurnContext, rpc: MuseRpc): void {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text.length === 0) continue;
        this.lastStderr = text.slice(0, STDERR_MAX);
        ctx.log('warn', `muse host: ${this.lastStderr}`);
      }
    });
    this.exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        this.exitCode = code;
        resolve(code);
      });
      child.once('close', () => {
        const sentence = this.exitSentence(this.exitCode);
        rpc.fail(sentence);
        this.current?.fail(sentence);
        if (!this.closing) this.drop();
      });
      child.once('error', (error) => {
        resolve(null);
        const sentence = `the muse host did not start: ${messageOf(error)}`;
        rpc.fail(sentence);
        this.current?.fail(sentence);
        if (!this.closing) this.drop();
      });
    });
  }

  private exitWithin(ms: number): Promise<number | null | undefined> {
    const exited = this.exited;
    if (exited === null) return Promise.resolve(undefined);
    return new Promise<number | null | undefined>((resolve) => {
      const timer = setTimeout(() => {
        resolve(undefined);
      }, ms);
      timer.unref?.();
      void exited.then((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  private exitSentence(code: number | null): string {
    const head = `the muse host exited with code ${code === null ? 'unknown' : code}`;
    return this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
    for (const question of this.questions.values()) question.settle();
    this.questions.clear();
    this.approvals.clear();
    this.rpc?.fail('the muse session was closed');
    this.rpc = null;
    const child = this.child;
    this.child = null;
    if (child !== null) {
      try {
        child.stdin.end();
      } catch {
        // the pipe is already gone
      }
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
    this.onEnded(this);
  }

  private armIdle(): void {
    this.idle = setTimeout(() => {
      this.idle = null;
      this.drop();
    }, this.warmMs);
    this.idle?.unref?.();
  }

  private clearIdle(): void {
    if (this.idle === null) return;
    clearTimeout(this.idle);
    this.idle = null;
  }

  // -- what the host sends --------------------------------------------------

  private onNotification(method: string, params: Record<string, unknown>): void {
    // One host, one session: anything about another session is not this thread's.
    if (typeof params['sessionId'] === 'string' && params['sessionId'] !== this.sessionId) return;
    switch (method) {
      case 'session/modelChanged':
        if (typeof params['modelId'] === 'string') this.modelId = params['modelId'];
        return;
      case 'session/approvalModeChanged':
        if (typeof params['mode'] === 'string') this.approvalMode = params['mode'];
        return;
      case 'session/contextUsage': {
        const used = params['usedTokens'];
        if (typeof used !== 'number') return;
        const window = params['windowTokens'];
        this.contextSink?.({ tokens: used, window: typeof window === 'number' ? window : null });
        return;
      }
      default:
        break;
    }

    const turn = this.current;
    if (turn === null) return;
    switch (method) {
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = params['item'] as MuseItem | undefined;
        if (item !== undefined && typeof item.itemId === 'string') this.onItem(turn, item);
        break;
      }
      case 'item/delta':
        this.onDelta(turn, params);
        break;
      case 'turn/completed': {
        if (turn.compacting || params['turnId'] !== turn.turnId) break;
        const usage = params['usage'] as MuseTokenUsage | undefined;
        if (usage !== undefined) turn.usage = mapUsage(usage);
        const error = params['error'] as { kind?: string; message?: string } | undefined;
        turn.finish(textOf(params['terminal']), turnFailure(error, textOf(params['reason'])));
        break;
      }
      case 'turn/retryScheduled':
        turn.ctx.log(
          'warn',
          `muse: retrying the turn (attempt ${String(params['nextAttempt'])} of ${String(params['maxAttempts'])}): ${textOf(params['reason'])}`,
        );
        break;
      case 'session/tokenUsage': {
        if (params['turnId'] !== turn.turnId) break;
        const usage = params['usage'] as MuseTokenUsage | undefined;
        if (usage !== undefined) turn.observed = addUsage(turn.observed, mapUsage(usage));
        break;
      }
      case 'session/todoListChanged': {
        const items = params['items'];
        if (Array.isArray(items)) turn.ctx.tasks?.(tasksOf(items));
        break;
      }
      case 'approval/requested':
      case 'approval/updated':
        this.onApproval(turn, method, params as ApprovalParams);
        break;
      case 'approval/resolved': {
        const open = this.approvals.get(textOf(params['approvalId']));
        if (open === undefined) break;
        this.approvals.delete(open.approvalId);
        open.external(textOf(params['decision']).startsWith('approved') ? 'allow' : 'deny');
        break;
      }
      case 'userInput/requested':
        void this.onQuestions(turn, params);
        break;
      case 'userInput/settled': {
        const open = this.questions.get(textOf(params['userInputId']));
        if (open === undefined) break;
        this.questions.delete(textOf(params['userInputId']));
        open.settle();
        break;
      }
      case 'session/closed':
        if (!this.closing) turn.fail(`Muse closed the session: ${textOf(params['reason']) || 'no reason given'}`);
        break;
      case 'view/gap':
        turn.ctx.log('warn', 'muse: the host skipped some updates of this turn; the saved session is complete');
        break;
      default:
        // turn/started (the id is already known), session/statusChanged,
        // session/nameChanged and the rest: nothing to draw.
        break;
    }
  }

  private onItem(turn: MuseTurn, item: MuseItem): void {
    const revision = typeof item.revision === 'number' ? item.revision : 0;
    const seen = this.items.get(item.itemId);
    if (seen !== undefined && seen.revision >= revision && revision > 0) return;
    this.items.set(item.itemId, { kind: item.kind, revision });
    const terminal = item.status !== undefined && item.status !== 'inProgress';

    if (item.kind === 'compaction') {
      if (!terminal) return;
      if (item.outcome === 'failed') {
        const reason = item.reason ?? item.failureReason ?? 'Muse could not compact the context';
        if (turn.compacting) turn.fail(reason);
        else turn.ctx.log('warn', `muse: automatic compaction failed: ${reason}`);
        return;
      }
      turn.part(turn.takeIndex(), {
        type: 'compaction',
        trigger: item.trigger === 'auto' ? 'auto' : 'manual',
        preTokens: typeof item.tokensBefore === 'number' ? item.tokensBefore : (turn.ctx.thread.context?.tokens ?? null),
        postTokens: typeof item.tokensAfter === 'number' ? item.tokensAfter : null,
      });
      if (turn.compacting) turn.finish('completed', null);
      return;
    }

    // Items of another turn (a queued one, a replay) are not this card's.
    if (item.turnId !== undefined && item.turnId !== null && item.turnId !== turn.turnId) return;
    switch (item.kind) {
      case 'agentMessage':
        turn.appendSnapshot(item.itemId, 'text', 'text', item.text);
        break;
      case 'reasoning':
        turn.appendSnapshot(item.itemId, 'text', 'thinking', item.text);
        item.summary?.forEach((text, index) => {
          turn.appendSnapshot(item.itemId, `summary.${index}`, 'thinking', text);
        });
        break;
      case 'toolCall':
        turn.upsertTool(item.itemId, toolViewOf(item));
        break;
      case 'subagent':
        turn.upsertTool(item.itemId, {
          name: SUBAGENT_TOOL_NAME,
          input: { objective: item.objective ?? '', ...(item.role === undefined ? {} : { role: item.role }) },
          output: item.result?.summary ?? item.failureReason ?? null,
          status: itemStatus(item.status),
        });
        break;
      default:
        // userMessage is the prompt Boite already shows; userShell, workflow and
        // reminderChild have no part in the contract.
        break;
    }
  }

  private onDelta(turn: MuseTurn, params: Record<string, unknown>): void {
    const itemId = textOf(params['itemId']);
    const delta = textOf(params['delta']);
    if (itemId.length === 0 || delta.length === 0) return;
    const kind = this.items.get(itemId)?.kind;
    const field = typeof params['field'] === 'string' ? params['field'] : 'text';
    if (kind === 'agentMessage' && field === 'text') turn.appendDelta(itemId, field, 'text', delta);
    else if (kind === 'reasoning' && (field === 'text' || field.startsWith('summary.'))) {
      turn.appendDelta(itemId, field, 'thinking', delta);
    }
    // A tool's output delta waits for the item's own snapshot, which carries it whole.
  }

  // -- approvals ------------------------------------------------------------

  private onApproval(turn: MuseTurn, method: string, params: ApprovalParams): void {
    const approvalId = params.approvalId;
    const requirement = params.currentRequirementId;
    if (typeof approvalId !== 'string' || requirement === undefined) return;
    if (typeof params.turnId === 'string' && params.turnId !== turn.turnId) return;

    let open = this.approvals.get(approvalId);
    if (open === undefined) {
      // An update for an approval nobody asked about is a late persistence notice.
      if (method !== 'approval/requested') return;
      let external: (decision: 'allow' | 'deny') => void = () => undefined;
      const externally = new Promise<'allow' | 'deny'>((resolve) => {
        external = resolve;
      });
      open = {
        approvalId,
        turnId: params.turnId ?? null,
        requirement,
        choices: params.availableChoices ?? [],
        subject: params.subject ?? {},
        toolName: params.toolName ?? '',
        rawArgs: params.rawArgs ?? '',
        protectedWrite: params.protectedWrite === true,
        judgeEscalated: params.judgeEscalated === true,
        decidedStage: null,
        asking: false,
        external,
        externally,
      };
      this.approvals.set(approvalId, open);
    } else {
      open.requirement = requirement;
      if (params.availableChoices !== undefined) open.choices = params.availableChoices;
      if (params.subject !== undefined) open.subject = params.subject;
    }

    // A stage already decided, or a card already up for this stage, needs nothing new.
    if (open.asking || open.decidedStage === open.requirement.sourceIndex) return;
    void this.decideApproval(turn, open);
  }

  private async decideApproval(turn: MuseTurn, open: OpenApproval): Promise<void> {
    open.asking = true;
    let answer: 'allow' | 'deny' | 'abort';
    if (this.editAllowed(turn, open)) {
      answer = 'allow';
    } else {
      const { toolName, input, description } = approvalCardOf(open);
      const ticket = turn.ctx.requestPermission(toolName, input, description);
      const index = turn.takeIndex();
      turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
      const picked = await Promise.race([
        ticket,
        turn.stopped.then(() => 'abort' as const),
        open.externally.then((decision) => ({ external: decision })),
      ]);
      if (typeof picked === 'object') {
        // The host settled it on its own: the card shows what it decided, nothing is sent.
        turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: picked.external });
        open.asking = false;
        return;
      }
      answer = picked;
      if (answer !== 'abort') {
        turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: answer });
      }
    }

    const choice = choiceFor(open.choices, answer);
    const rpc = this.rpc;
    const sessionId = this.sessionId;
    open.asking = false;
    if (choice === null || rpc === null || sessionId === null) {
      turn.ctx.log('warn', `muse: no choice to send for approval ${open.approvalId} (${answer})`);
      return;
    }
    open.decidedStage = open.requirement.sourceIndex;
    try {
      await rpc.command('approval/decide', {
        sessionId,
        approvalId: open.approvalId,
        requirementId: open.requirement,
        choiceId: choice.choiceId,
      });
    } catch (error) {
      turn.ctx.log('warn', `muse: approval/decide failed: ${messageOf(error)}`);
    }
  }

  /**
   * `acceptEdits`: a file write inside the thread's folder, which Muse neither
   * marks as a protected path nor escalated through its own judge, is approved
   * without a card, once.
   */
  private editAllowed(turn: MuseTurn, open: OpenApproval): boolean {
    if (turn.ctx.thread.permissionMode !== 'acceptEdits') return false;
    if (open.protectedWrite || open.judgeEscalated) return false;
    const subject = open.subject;
    if (subject.kind !== 'fileAccess') return false;
    if (subject.access !== 'write' && subject.access !== 'readWrite') return false;
    if (typeof subject.path !== 'string' || subject.path.trim().length === 0) return false;
    const root = resolve(turn.ctx.thread.cwd);
    const inside = relative(root, resolve(root, subject.path));
    return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside);
  }

  // -- questions ------------------------------------------------------------

  /**
   * `userInput/requested` carries one or more questions. Each becomes one
   * question card, asked in order; the answers go back together with
   * `userInput/answer`. A stop cancels the set with `userInput/cancel`, and a
   * set the host settled on its own (a timeout) is left alone.
   */
  private async onQuestions(turn: MuseTurn, params: Record<string, unknown>): Promise<void> {
    const userInputId = textOf(params['userInputId']);
    const raw = params['questions'];
    if (userInputId.length === 0 || !Array.isArray(raw) || this.questions.has(userInputId)) return;
    if (typeof params['turnId'] === 'string' && params['turnId'] !== turn.turnId) return;
    let settle: () => void = () => undefined;
    const settled = new Promise<null>((resolve) => {
      settle = () => {
        resolve(null);
      };
    });
    this.questions.set(userInputId, { settle, settled });

    const answers: MuseAnswer[] = [];
    let cancelled = false;
    for (const entry of raw as MuseQuestion[]) {
      const questionId = typeof entry?.id === 'string' ? entry.id : '';
      if (questionId.length === 0) continue;
      const options = optionsOf(entry.options);
      const ask: QuestionAsk = {
        text: questionTextOf(entry),
        options,
        allowText: true,
        multiple: entry.selection?.mode === 'multiple',
      };
      const ticket = turn.ctx.askQuestion(ask);
      const index = turn.takeIndex();
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
      const answer = await Promise.race([ticket, turn.stopped.then(() => null), settled]);
      if (!this.questions.has(userInputId)) return;
      if (answer === null) {
        cancelled = true;
        break;
      }
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
      answers.push(answerOf(questionId, answer, options, ask.multiple));
    }
    this.questions.delete(userInputId);

    const rpc = this.rpc;
    const sessionId = this.sessionId;
    if (rpc === null || sessionId === null) return;
    try {
      if (cancelled) await rpc.command('userInput/cancel', { sessionId, userInputId });
      else await rpc.command('userInput/answer', { sessionId, userInputId, answers });
    } catch (error) {
      turn.ctx.log('warn', `muse: ${cancelled ? 'userInput/cancel' : 'userInput/answer'} failed: ${messageOf(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The executable a turn or a probe spawns. The official Windows installer puts a
 * `muse.cmd` launcher on PATH, which `node:child_process` refuses to spawn, and
 * a versioned binary beside it named by `.muse-version`: that binary is what
 * runs. Anything else is spawned as the profile resolved it.
 */
export function museExecutable(provider: ProviderDescriptor): string {
  const profile = profileFor(provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${provider.id} executable on this machine`, { providerId: provider.id });
  }
  if (!executable.toLowerCase().endsWith('.cmd')) return executable;
  const dir = dirname(executable);
  let version = '';
  try {
    version = readFileSync(join(dir, '.muse-version'), 'utf8').trim();
  } catch {
    // no launcher record: the shim is all there is
  }
  if (/^[\w.-]+$/.test(version)) {
    const binary = join(dir, `muse-bin-${version}.exe`);
    if (existsSync(binary)) return binary;
  }
  throw unavailable(
    `${basename(executable)} is Muse Code's launcher script, which Boite cannot start: install Muse Code from Providers`,
    { providerId: provider.id, executable },
  );
}

/** The model this turn asks for, or null for the agent's own. */
function modelOf(ctx: TurnContext): string | null {
  const model = ctx.thread.model;
  if (model === null || model === AGENT_OWN_MODEL) return null;
  return model;
}

/** The thread's effort when it is one `ReasoningEffort` names, else the host's own. */
function effortOf(ctx: TurnContext): string | null {
  const effort = ctx.thread.effort;
  if (effort === null) return null;
  return (EFFORTS as readonly string[]).includes(effort) ? effort : null;
}

/** `TurnInputPart`s: the prompt as one text part, then one image part per attachment. */
function inputOf(prompt: string, attachments: ImageAttachment[]): Record<string, unknown>[] {
  return [
    ...(prompt.length === 0 ? [] : [{ type: 'text', text: prompt }]),
    ...attachments.map((attachment) => ({ type: 'image', base64Data: attachment.data, mediaType: attachment.mimeType })),
  ];
}

/** Why a command failed, in words: the host's own reason when it gave one. */
function commandFailure(error: unknown): string {
  if (error instanceof MspError && error.reason !== null) return `muse refused ${error.method}: ${error.reason}`;
  return messageOf(error);
}

/** The error a failed turn ends with. A missing login gets the one sentence that fixes it. */
function turnFailure(error: { kind?: string; message?: string } | undefined, reason: string): string | null {
  if (error?.kind === 'authRequired') {
    return `Muse Code is not signed in: sign this account in from Providers (${error.message ?? reason})`;
  }
  if (error?.message !== undefined && error.message.length > 0) return error.message;
  return reason.length > 0 ? reason : null;
}

function itemStatus(status: string | undefined): ToolStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'rejected':
      return 'denied';
    case 'failed':
    case 'cancelled':
    case 'timedOut':
      return 'error';
    default:
      return 'running';
  }
}

/** Muse's tool arguments are model-written JSON, kept as text when they do not parse. */
function argsOf(args: string | undefined): unknown {
  if (args === undefined || args.length === 0) return null;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { args };
  }
}

/** A tool item as a card. A shell command is drawn as `Bash`, like every other agent's. */
function toolViewOf(item: MuseItem): ToolView {
  const output = item.visibleOutput ?? (item.status === 'failed' ? (item.failureReason ?? null) : null);
  if (typeof item.commandText === 'string' && item.commandText.length > 0) {
    return { name: COMMAND_TOOL_NAME, input: { command: item.commandText }, output, status: itemStatus(item.status) };
  }
  return { name: item.tool ?? 'tool', input: argsOf(item.args), output, status: itemStatus(item.status) };
}

/** The card an approval draws: a shell command as `Bash`, anything else under Muse's tool name. */
function approvalCardOf(open: OpenApproval): { toolName: string; input: unknown; description: string | null } {
  const subject = open.subject;
  const input: Record<string, unknown> = { kind: subject.kind ?? 'tool' };
  for (const key of ['command', 'path', 'access', 'host', 'port', 'target'] as const) {
    if (subject[key] !== undefined) input[key] = subject[key];
  }
  const toolName =
    subject.kind === 'shell' ? COMMAND_TOOL_NAME : open.toolName || subject.toolName || subject.kind || 'tool';
  const description =
    subject.command ?? subject.path ?? subject.host ?? subject.target ?? (open.rawArgs.length > 0 ? open.rawArgs : null);
  return { toolName, input, description };
}

/**
 * The `ApprovalChoice` an answer becomes. Allow takes the narrowest approving
 * choice (once before session before persistent), deny the plain denial, and a
 * stop the `abort` choice when the host offers one.
 */
export function choiceFor(choices: ApprovalChoice[], answer: 'allow' | 'deny' | 'abort'): ApprovalChoice | null {
  const rank = (choice: ApprovalChoice): number =>
    (choice.scope === 'once' ? 0 : choice.scope === 'session' ? 2 : 4) +
    (choice.decision.endsWith('PolicyAmendment') ? 1 : 0);
  const pick = (decisions: string[]): ApprovalChoice | null =>
    choices
      .filter((choice) => decisions.includes(choice.decision))
      .sort((left, right) => rank(left) - rank(right))[0] ?? null;
  if (answer === 'allow') return pick(['approved', 'approvedForSession', 'approvedPolicyAmendment']);
  if (answer === 'abort') return pick(['abort']) ?? pick(['denied', 'deniedPolicyAmendment']);
  return pick(['denied', 'deniedPolicyAmendment']);
}

function questionTextOf(entry: MuseQuestion): string {
  const header = textOf(entry.header).trim();
  const body = textOf(entry.question).trim();
  if (header.length > 0 && body.length > 0 && header !== body) return `${header}: ${body}`;
  return body.length > 0 ? body : header;
}

/** Muse options have a label and no id: the label is the id, which is what goes back. */
function optionsOf(raw: MuseQuestion['options']): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: QuestionOption[] = [];
  for (const entry of raw) {
    const label = textOf(entry?.label);
    if (label.length === 0 || options.some((option) => option.id === label)) continue;
    const description = textOf(entry?.description);
    options.push(description.length > 0 ? { id: label, label, description } : { id: label, label });
  }
  return options;
}

/** One `UserInputAnswer`: the picked labels, and the typed text as `freeText`. */
function answerOf(questionId: string, answer: QuestionAnswer, options: QuestionOption[], multiple: boolean): MuseAnswer {
  const labels = answer.optionIds
    .map((id) => options.find((option) => option.id === id)?.label)
    .filter((label): label is string => label !== undefined);
  const text = answer.text?.trim() ?? '';
  const out: MuseAnswer = { questionId };
  if (labels.length > 0) {
    if (multiple) out.selectedLabels = labels;
    else out.selectedLabel = labels[0] as string;
  }
  if (text.length > 0) out.freeText = text;
  return out;
}

/** `session/todoListChanged` as the thread's tasks. A cancelled item is dropped. */
function tasksOf(items: unknown[]): AgentTask[] {
  const tasks: AgentTask[] = [];
  items.forEach((entry, index) => {
    const item = (entry ?? {}) as { text?: unknown; status?: unknown };
    const text = textOf(item.text).trim();
    if (text.length === 0 || item.status === 'cancelled') return;
    const status =
      item.status === 'completed' ? 'completed' : item.status === 'inProgress' ? 'in_progress' : 'pending';
    tasks.push({ id: String(index), text, status });
  });
  return tasks;
}

/** `TokenUsage`. Muse carries no price, so the cost stays null. */
function mapUsage(usage: MuseTokenUsage): Usage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? usage.cachedTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    costUsdEquivalent: null,
  };
}

function addUsage(left: Usage | null, right: Usage): Usage {
  if (left === null) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsdEquivalent: null,
  };
}

/**
 * What a session was started with and cannot be told to change: the folder,
 * the account and the host's sandbox flags. The model, the effort and the
 * approval mode are not in here, they are sent on the running host.
 */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    cwd: ctx.thread.cwd,
    flags: MODE_POSTURE[ctx.thread.permissionMode].flags,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}

// ---------------------------------------------------------------------------
// The probe: the models the host lists
// ---------------------------------------------------------------------------

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** `muse-spark-1.3` as `Muse Spark 1.3`, when the catalog repeats the id as its label. */
function modelName(id: string, label: string | undefined): string {
  const text = (label ?? '').trim();
  if (text.length > 0 && text !== id) return text;
  if (!/^muse(-[a-z0-9.]+)+$/.test(id)) return id;
  return id
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/**
 * The effort tiers per model, read from the catalog Muse caches under its home
 * (`model-catalog/*.json`, rows with `reasoning_effort_variants`), because
 * `model/list` does not carry them. A cache in another shape is skipped.
 */
export function readCatalogEfforts(museHome: string, profileId: string | null): Map<string, EffortLevel[]> {
  const efforts = new Map<string, EffortLevel[]>();
  const dir = join(museHome, 'model-catalog');
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return efforts;
  }
  for (const file of files) {
    let catalog: { profile_id?: unknown; rows?: unknown };
    try {
      catalog = JSON.parse(readFileSync(join(dir, file), 'utf8')) as typeof catalog;
    } catch {
      continue;
    }
    if ((catalog.profile_id ?? null) !== profileId || !Array.isArray(catalog.rows)) continue;
    for (const raw of catalog.rows) {
      const row = (raw ?? {}) as Record<string, unknown>;
      const variants = row['reasoning_effort_variants'];
      if (row['provider_id'] !== META_PROVIDER || row['visibility'] !== 'visible' || !Array.isArray(variants)) continue;
      const levels: EffortLevel[] = [];
      for (const variant of variants) {
        const tier = textOf((variant as Record<string, unknown>)?.['tier']);
        if (!(EFFORTS as readonly string[]).includes(tier) || levels.some((level) => level.id === tier)) continue;
        const description = textOf((variant as Record<string, unknown>)['description']);
        levels.push({ id: tier, label: EFFORT_LABELS[tier] ?? tier, ...(description.length > 0 ? { description } : {}) });
      }
      if (levels.length > 0 && typeof row['model_id'] === 'string') efforts.set(row['model_id'], levels);
    }
  }
  return efforts;
}

function effortBlock(levels: EffortLevel[]): ModelInfo['effort'] {
  const ids = levels.map((level) => level.id);
  const fallback = ids.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : ids.includes('medium') ? 'medium' : (ids[0] ?? '');
  return { levels, default: fallback };
}

/**
 * A `model/list` answer as a model list, the descriptor's `default` first so
 * the choice can always go back to Muse's own. A host that lists nothing, which
 * is what one that is not signed in does, leaves the descriptor's models
 * standing.
 */
export function modelsFrom(provider: ProviderDescriptor, list: MuseModelList, efforts: Map<string, EffortLevel[]>): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: false });
    seen.add(AGENT_OWN_MODEL);
  }
  const fallback = FALLBACK_EFFORTS.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
  for (const entry of list.models ?? []) {
    const id = entry.modelId;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    if (entry.providerId !== undefined && entry.providerId !== META_PROVIDER) continue;
    seen.add(id);
    models.push({
      id,
      name: modelName(id, entry.displayLabel),
      default: entry.isDefault === true,
      effort: effortBlock(efforts.get(id) ?? fallback),
    });
  }
  return models.length === (own === undefined ? 0 : 1) ? provider.models : models;
}

/**
 * One short-lived `muse serve` that can neither write nor run a shell and keeps
 * no session log: `initialize`, `initialized`, `model/list`. The child goes
 * through the registry that traced it on every path.
 */
async function readModels(ctx: ProbeContext): Promise<ModelInfo[]> {
  const executable = museExecutable(ctx.provider);
  let lastStderr = '';
  const child = ctx.spawnChild(executable, [...(profileFor(ctx.provider)?.launch?.args ?? []), ...PROBE_FLAGS], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.provider, ctx.accountEnv),
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (text.length > 0) lastStderr = text.slice(0, STDERR_MAX);
    }
  });

  const say = (head: string): string => (lastStderr.length === 0 ? head : `${head}: ${lastStderr}`);
  const detail = { providerId: ctx.provider.id, accountId: ctx.accountId };
  let timer: Timer | null = null;
  const rpc = new MuseRpc(child, {
    notification: () => undefined,
    log: (level, message) => {
      ctx.log(level, message);
    },
  });

  try {
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(unavailable(say(`the ${ctx.provider.id} host exited with code ${code ?? 'unknown'}`), detail));
      });
      child.once('error', (error) => {
        reject(unavailable(say(`the ${ctx.provider.id} host did not start: ${messageOf(error)}`), detail));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(unavailable(say(`the ${ctx.provider.id} host did not list its models in ${PROBE_TIMEOUT_MS / 1000} s`), detail));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });

    const read = (async (): Promise<ModelInfo[]> => {
      const init = await handshake(rpc);
      const list = await rpc.request<MuseModelList>('model/list', {});
      const efforts =
        typeof init.museHome === 'string' && list.source === 'providerCatalog'
          ? readCatalogEfforts(init.museHome, list.profileId ?? null)
          : new Map<string, EffortLevel[]>();
      return modelsFrom(ctx.provider, list, efforts);
    })();

    return await Promise.race([read, died, expired]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    rpc.fail('the muse probe is over');
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    ctx.killTree();
  }
}

interface ProbeEntry {
  providerId: ProviderId;
  accountId: AccountId;
  running: Promise<ProbeResult> | null;
  result: ProbeResult | null;
}

/** One `muse serve` host per thread, kept between turns like the Codex one. */
export function createMuseDriver(): Driver {
  const sessions = new Map<ThreadId, MuseSession>();
  const probes = new Map<string, ProbeEntry>();
  const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${providerId}::${accountId}`;

  return {
    protocol: 'muse',

    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const key = keyOf(ctx.provider.id, ctx.accountId);
      const entry: ProbeEntry = probes.get(key) ?? {
        providerId: ctx.provider.id,
        accountId: ctx.accountId,
        running: null,
        result: null,
      };
      probes.set(key, entry);
      if (entry.result !== null) return entry.result;
      if (entry.running !== null) return entry.running;

      const running = readModels(ctx).then((models) => ({ models, probedAt: Date.now() }));
      entry.running = running;
      try {
        const result = await running;
        if (probes.get(key) === entry) entry.result = result;
        return result;
      } catch (error) {
        if (probes.get(key) === entry) probes.delete(key);
        throw error;
      } finally {
        entry.running = null;
      }
    },

    probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
      return probes.get(keyOf(providerId, accountId))?.result?.models ?? null;
    },

    forgetProbes(filter: ProbeFilter = {}): void {
      for (const [key, entry] of [...probes]) {
        if (filter.providerId !== undefined && filter.providerId !== entry.providerId) continue;
        if (filter.accountId !== undefined && filter.accountId !== entry.accountId) continue;
        probes.delete(key);
      }
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new MuseTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(session.key === key ? null : 'the thread changed mode, account or folder', ctx);
        session = null;
      }
      if (session === null) {
        session = new MuseSession(key, warmMs, (ended) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
        });
        sessions.set(threadId, session);
      }
      const running = session;
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        stop: (): void => {
          running.stopTurn(turn);
        },
      };
    },

    releaseThread(threadId: ThreadId): void {
      const session = sessions.get(threadId);
      if (session === undefined || session.busy()) return;
      sessions.delete(threadId);
      session.close(null);
    },

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      probes.clear();
      for (const session of open) session.close(null);
    },
  };
}
