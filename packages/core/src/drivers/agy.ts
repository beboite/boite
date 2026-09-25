/**
 * The Antigravity CLI's own headless mode:
 * `agy --input-format stream-json --output-format stream-json -p=`, one JSON
 * prompt per line on stdin, one JSON event per line on stdout. There is no SDK
 * behind it and no protocol library, so the line reader below is the whole
 * transport. This is the user's installed `agy` on the user's own login, not
 * the managed ACP server the `antigravity` descriptor downloads.
 *
 * A prompt is `{"event":"user","message":{"role":"user","content":"..."}}`,
 * and one process takes as many as it is sent, each a turn of the same
 * conversation. What comes back:
 *
 * - `init`, once per process: the `conversation_id` and what the agent runs on.
 * - `step_update`, once per change of a step: `step_index`, `state` (`ACTIVE`,
 *   `DONE`, `ERROR`) and `step_type`. An `agent_response` step streams
 *   `text_delta` chunks and carries its `usage` when it is done; a `tool` step
 *   carries `tool_name` and `tool_info { name, parameters, error? }`, `ACTIVE`
 *   then `DONE` or `ERROR` on the same index. `tool_info.output` arrives whole
 *   with the last update of most tools and never streams.
 * - `result`, at the end of every turn: `status` `SUCCESS` or `ERROR`, the
 *   `response`, the `error`. Its `usage` counts the whole process, so a turn's
 *   usage is the sum of its own `agent_response` steps instead.
 *
 * `-p=` has to be spelled with its empty value: a bare `-p` takes the next
 * argument as the prompt. stderr carries the CLI's own chatter, logged and
 * otherwise ignored. Print mode has no approval gate: the permission mode is a
 * launch flag, and whatever it does not allow agy denies by itself.
 */
import type {
  AccountId,
  EffortLevel,
  MessageId,
  MessagePart,
  ModelInfo,
  PermissionMode,
  ProviderDescriptor,
  ProviderId,
  ThreadId,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild } from '../procs.ts';
import { agentEnv, launchPrefix, profileFor, resolveExecutable } from '../providers/loader.ts';
import { stderrLines } from './stderr-lines.ts';
import type {
  Driver,
  ProbeContext,
  ProbeFilter,
  ProbeResult,
  TurnContext,
  TurnHandle,
  TurnResult,
} from './types.ts';

const MINUTE_MS = 60_000;
const STDERR_MAX = 400;
/**
 * How long a process whose stdin was closed gets to leave on its own. agy
 * finishes writing the conversation and waits on the background work the turn
 * started before it exits; past this it is killed.
 */
const EXIT_GRACE_MS = 8_000;
/** How long a killed process gets before the next one of the thread starts anyway. */
const KILL_WAIT_MS = 2_000;
/** How long `agy models` gets to answer. */
const PROBE_TIMEOUT_MS = 20_000;
/** What a probe keeps of the listing, far above any real one. */
const PROBE_OUTPUT_MAX = 1024 * 1024;
/** What one tool part keeps of its output in the journal. */
const TOOL_OUTPUT_MAX = 64 * 1024;
/** The model id that means "agy keeps the one it is configured with". */
const AGENT_OWN_MODEL = 'default';
/**
 * The conversation mode, which the driver adds itself because the same binary
 * is also launched as `agy models` for the probe: a descriptor's `launch.args`
 * go first on both lines. `-p=` is print mode with the empty prompt spelled
 * out, so it swallows nothing, and it goes last.
 */
const STREAM_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
const PRINT_FLAG = '-p=';
/** What `agy models` prints when nobody is signed in, on either stream. */
const SIGNED_OUT = /please sign in/i;

type Timer = ReturnType<typeof setTimeout>;
type Row = Record<string, unknown>;

function rowOf(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** `result.error`, which is a sentence or an object carrying one. */
function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  const row = rowOf(value);
  const message = textOf(row['message']);
  if (message.length > 0) return message;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Splits a stream on `\n` only, a trailing `\r` stripped, empty lines dropped. */
class LineReader {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) break;
      let line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length > 0) this.onLine(line);
    }
  }
}

// ---------------------------------------------------------------------------
// The turn and what it draws
// ---------------------------------------------------------------------------

/** One `agent_response` step's `usage`. `input_tokens` leaves the cache reads out. */
interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
}

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One prompt line and what came back for it: one text part the deltas append
 * to, one part per tool step, the usage of its own `agent_response` steps.
 */
class AgyTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private readonly tools = new Map<number, ToolEntry>();
  private wroteText = false;
  private lastUsage: AgyUsage | null = null;

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private decide: () => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves the moment the outcome is known, before anything is journalled. */
  readonly finished: Promise<void>;
  /** Resolves on a stop, so a turn still waiting to launch its process stops waiting. */
  readonly stopRequested: Promise<void>;

  /** agy's `conversation_id`, which the next process resumes with `--conversation`. */
  sessionId: string | null;
  usage: Usage | null = null;
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
    this.stopRequested = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  noteSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  markStopped(): void {
    this.isStopped = true;
    this.wake();
  }

  writeText(text: string): void {
    if (text.length === 0) return;
    this.wroteText = true;
    if (this.textIndex === null) {
      this.textIndex = this.takeIndex();
      this.part(this.textIndex, { type: 'text', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.textIndex, text);
  }

  /** A tool step opens a part on its first update and redraws it on each later one. */
  upsertTool(stepIndex: number, view: { name: string; input: unknown; output: string | null; status: ToolStatus }): void {
    let entry = this.tools.get(stepIndex);
    if (entry === undefined) {
      entry = { index: this.takeIndex(), name: view.name, input: null, output: null, status: 'running' };
      // The text after a tool is a paragraph of its own, below the card.
      this.textIndex = null;
      this.tools.set(stepIndex, entry);
    }
    if (view.name.length > 0) entry.name = view.name;
    if (view.input !== null && view.input !== undefined) entry.input = view.input;
    if (view.output !== null) entry.output = view.output;
    entry.status = view.status;
    this.part(entry.index, {
      type: 'tool',
      toolId: `agy-${this.ctx.turn.id}-${stepIndex}`,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
    });
  }

  /**
   * One finished `agent_response`. Thinking is billed as output, so it counts
   * there; the cache reads are reported apart from the input, as agy does.
   */
  addUsage(usage: AgyUsage): void {
    const base = this.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null };
    this.usage = {
      inputTokens: base.inputTokens + countOf(usage.input_tokens),
      outputTokens: base.outputTokens + countOf(usage.output_tokens) + countOf(usage.thinking_tokens),
      cacheReadTokens: base.cacheReadTokens + countOf(usage.cache_read_tokens),
      cacheWriteTokens: 0,
      costUsdEquivalent: null,
    };
    this.lastUsage = usage;
  }

  /** `result`: the turn is over, with the answer as a fallback when nothing streamed. */
  finish(result: Row): void {
    if (this.decided) return;
    const status = textOf(result['status']);
    if (status === 'ERROR' || (status.length > 0 && status !== 'SUCCESS')) {
      const reason = errorText(result['error']);
      this.noteError(reason.length > 0 ? reason : `the Antigravity CLI ended the turn with ${status}`);
    } else if (!this.wroteText) {
      this.writeText(textOf(result['response']));
    }
    this.reportContext();
    this.settleRun();
  }

  /**
   * The context meter, from the last request of the turn: what it sent, fresh
   * and cached, plus what it answered, which the next request carries. agy
   * names no window, so there is none.
   */
  private reportContext(): void {
    const usage = this.lastUsage;
    if (usage === null) return;
    const input = countOf(usage.input_tokens);
    const cache = countOf(usage.cache_read_tokens);
    const output = countOf(usage.output_tokens);
    this.ctx.context({ tokens: input + cache + output, window: null, breakdown: { input, cache, output } });
  }

  noteError(reason: string): void {
    if (this.error !== null) return;
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
  }

  settleRun(): void {
    if (this.decided) return;
    if (this.error !== null) this.status = 'error';
    else if (this.isStopped) this.status = 'stopped';
    this.decided = true;
    this.decide();
  }

  /** The turn cannot go on: a dead child, a failed launch. */
  fail(reason: string): void {
    if (this.decided) return;
    this.noteError(reason);
    this.status = 'error';
    this.decided = true;
    this.decide();
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.decided = true;
    this.decide();
    if (this.messageId !== null) {
      this.ctx.emit.complete(this.messageId, this.status === 'error' ? 'error' : 'complete');
    }
    this.resolve({
      status: this.status,
      sessionId: this.sessionId,
      usage: this.usage,
      error: this.error ?? undefined,
    });
  }

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  private part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.message(), index, part);
  }

  private takeIndex(): number {
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }
}

/** One `step_update` drawn on the running turn. Steps of the user's input and the system are not drawn. */
function drawStep(turn: AgyTurn, step: Row): void {
  const type = textOf(step['step_type']);
  const state = textOf(step['state']);
  if (type === 'agent_response') {
    turn.writeText(textOf(step['text_delta']));
    if (state === 'DONE' && step['usage'] !== undefined) turn.addUsage(rowOf(step['usage']) as AgyUsage);
    return;
  }
  if (type !== 'tool') return;
  const stepIndex = step['step_index'];
  if (typeof stepIndex !== 'number') return;
  const info = rowOf(step['tool_info']);
  const failure = rowOf(info['error']);
  const status: ToolStatus = state === 'ERROR' ? 'error' : state === 'DONE' ? 'done' : 'running';
  // A finished step carries what the tool printed, whole: nothing streams before it.
  let output: string | null = toolOutput(info['output']);
  if (status === 'error') {
    const reason = textOf(failure['message']) || textOf(failure['type']);
    output = reason.length > 0 ? reason : (output ?? 'the tool failed');
  }
  turn.upsertTool(stepIndex, {
    name: textOf(info['name']) || textOf(step['tool_name']),
    input: info['parameters'] ?? null,
    output,
    status,
  });
}

/** `tool_info.output` is text on every tool seen so far; anything else is kept as JSON rather than dropped. */
function toolOutput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > TOOL_OUTPUT_MAX ? `${value.slice(0, TOOL_OUTPUT_MAX)}
[cut at ${TOOL_OUTPUT_MAX} characters]` : value;
  try {
    return toolOutput(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** Wherever the event carries it: `init`, a step or a `result`. */
function conversationOf(event: Row): string | null {
  for (const holder of [event, rowOf(event['init']), rowOf(event['step_update']), rowOf(event['result'])]) {
    const id = textOf(holder['conversation_id']);
    if (id.length > 0) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The session: one agy process per thread
// ---------------------------------------------------------------------------

/**
 * The permission mode as agy's launch flags. `default` sends nothing, so agy's
 * own `toolPermission` setting decides. `bypassPermissions` and `dontAsk` are
 * both `--dangerously-skip-permissions`, as they are "never ask" on Codex and
 * Grok.
 */
function modeArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'plan':
      return ['--mode', 'plan'];
    case 'bypassPermissions':
    case 'dontAsk':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

/**
 * What a process was launched with. The model, the effort and the permission
 * mode are all flags agy reads once at launch, with no call to change them on
 * a running process, so a turn that differs on any of them needs a new one.
 * The conversation carries over: the next process resumes it.
 */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    model: ctx.thread.model,
    effort: ctx.thread.effort,
    permissionMode: ctx.thread.permissionMode,
    cwd: ctx.thread.cwd,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}

/**
 * One `agy -p=` process for a thread. With `warmProcessMinutes` at zero it goes
 * with its turn; above zero it takes the next turns of the thread on the same
 * stdin until the idle window, a stop, an archive, core shutdown or a changed
 * setup ends it. Any new process resumes the thread's conversation with
 * `--conversation`.
 */
class AgySession {
  private child: SpawnedChild | null = null;
  private starting: Promise<void> | null = null;
  private lastStderr = '';
  private exitCode: number | null = null;
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  private current: AgyTurn | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    /** The conversation this process continues, then the one agy reports. */
    private sessionId: string | null,
    /** The thread's previous process, still leaving: two on one conversation would race. */
    private readonly previous: Promise<void> | null,
    private readonly launchModel: (ctx: TurnContext) => Promise<string | null>,
    private readonly onEnded: (session: AgySession, gone: Promise<void>) => void,
  ) {}

  usable(key: string, warmMs: number, sessionId: string | null): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0 && this.sessionId === sessionId;
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: AgyTurn, warmMs: number): void {
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
   * Print mode has no cancel: the process is the turn, so a stop kills its tree
   * through the registry and the next turn resumes the conversation.
   */
  stopTurn(turn: AgyTurn): void {
    if (turn.decided) return;
    turn.markStopped();
    if (this.current !== turn) return;
    this.kill(turn.ctx);
    turn.settleRun();
  }

  /** Archive, shutdown, a changed setup: the process goes, politely unless told otherwise. */
  close(reason: string | null, ctx?: TurnContext, immediate = false): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('info', `agy session: ${reason}`);
    this.drop(immediate);
  }

  private async runTurn(turn: AgyTurn): Promise<void> {
    if (turn.isStopped) {
      turn.settleRun();
      this.endTurn(turn, false);
      return;
    }
    let launched: boolean;
    try {
      // The launch can wait on the previous process's exit (up to
      // EXIT_GRACE_MS) and on the model listing (up to PROBE_TIMEOUT_MS). A
      // stop ends the turn now: the session is dropped, and `open` spawns
      // nothing once it has ended.
      launched = await Promise.race([this.start(turn.ctx).then(() => true), turn.stopRequested.then(() => false)]);
    } catch (error) {
      turn.fail(messageOf(error));
      this.endTurn(turn, true);
      return;
    }
    if (!launched) {
      turn.settleRun();
      this.endTurn(turn, true);
      return;
    }
    const child = this.child;
    if (child === null || this.ended) {
      turn.fail(this.exitCode === null ? 'the Antigravity CLI session went away before the turn' : this.exitSentence(this.exitCode));
      this.endTurn(turn, true);
      return;
    }
    if (this.sessionId !== null) turn.noteSession(this.sessionId);
    if (turn.isStopped) {
      turn.settleRun();
      this.endTurn(turn, true);
      return;
    }
    this.current = turn;
    try {
      child.stdin.write(`${JSON.stringify({ event: 'user', message: { role: 'user', content: turn.ctx.prompt } })}\n`);
    } catch (error) {
      turn.fail(`the prompt did not reach the Antigravity CLI: ${messageOf(error)}`);
      this.current = null;
      this.endTurn(turn, true);
      return;
    }
    await turn.finished;
    this.current = null;
    this.endTurn(turn, turn.isStopped);
  }

  private endTurn(turn: AgyTurn, drop: boolean): void {
    turn.settle();
    this.running = Math.max(0, this.running - 1);
    if (drop) {
      this.drop(turn.isStopped);
      return;
    }
    if (this.closing || this.ended || this.warmMs <= 0) {
      this.drop(false);
      return;
    }
    if (this.running === 0) this.armIdle();
  }

  private start(ctx: TurnContext): Promise<void> {
    if (this.starting === null) this.starting = this.open(ctx);
    return this.starting;
  }

  private async open(ctx: TurnContext): Promise<void> {
    const profile = profileFor(ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }
    if (this.previous !== null) await this.previous;
    // A stop while the previous process left: no model listing, no process.
    if (this.ended) return;
    const model = await this.launchModel(ctx);
    if (this.ended) return;
    const args = [
      ...launchPrefix(profile),
      ...(profile?.launch?.args ?? []),
      ...STREAM_ARGS,
      ...(this.sessionId === null ? [] : ['--conversation', this.sessionId]),
      ...(model === null ? [] : ['--model', model]),
      // Print mode's workspace is agy's own scratch directory unless one is
      // named: without this its shell and its file tools never see the project.
      '--add-dir', ctx.thread.cwd,
      ...modeArgs(ctx.thread.permissionMode),
      PRINT_FLAG,
    ];
    const child = ctx.spawnChild(executable, args, {
      cwd: ctx.thread.cwd,
      env: agentEnv(ctx.provider, ctx.accountEnv),
    });
    this.child = child;
    this.watch(child, ctx);
  }

  private watch(child: SpawnedChild, ctx: TurnContext): void {
    const stdout = new LineReader((line) => {
      let event: Row;
      try {
        event = rowOf(JSON.parse(line));
      } catch {
        ctx.log('warn', `agy: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
        return;
      }
      this.onEvent(event);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout.feed(chunk);
    });
    child.stdin.on('error', () => undefined);
    stderrLines(child.stderr, (text) => {
      this.lastStderr = text.slice(0, STDERR_MAX);
      ctx.log('info', `agy: ${this.lastStderr}`);
    });
    this.exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        this.exitCode = code;
        resolve(code);
      });
      // `close` and not `exit`: stderr is flushed by then, so a failed turn
      // carries the line agy printed on its way out.
      child.once('close', () => {
        this.onGone(this.exitSentence(this.exitCode));
      });
      child.once('error', (error) => {
        resolve(null);
        this.onGone(`the Antigravity CLI did not start: ${messageOf(error)}`);
      });
    });
  }

  private onGone(sentence: string): void {
    const turn = this.current;
    if (turn !== null) {
      if (turn.isStopped) turn.settleRun();
      else turn.fail(sentence);
    }
    if (!this.closing) this.drop(false);
  }

  private onEvent(event: Row): void {
    const conversation = conversationOf(event);
    if (conversation !== null) {
      this.sessionId = conversation;
      this.current?.noteSession(conversation);
    }
    const turn = this.current;
    if (turn === null || turn.decided) return;
    const kind = textOf(event['event']);
    if (kind === 'step_update') drawStep(turn, rowOf(event['step_update']));
    else if (kind === 'result') turn.finish(rowOf(event['result']));
  }

  private exitSentence(code: number | null): string {
    const head = `the Antigravity CLI exited with code ${code === null ? 'unknown' : code}`;
    return this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  /** The whole tree the thread launched, through the registry, and the child itself if the registry lost it. */
  private kill(ctx: TurnContext): void {
    ctx.killTree?.();
    try {
      this.child?.kill();
    } catch {
      // already exited
    }
  }

  /**
   * The one teardown. stdin closes first, which is agy's cue to finish and
   * exit; the child is killed only past the grace, or at once when `immediate`.
   * What it hands back resolves once the process is gone, which the thread's
   * next process waits for.
   */
  private drop(immediate: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
    const child = this.child;
    this.child = null;
    let gone: Promise<void> = Promise.resolve();
    if (child !== null) {
      const exited = this.exited ?? Promise.resolve(null);
      const killChild = (): void => {
        try {
          child.kill();
        } catch {
          // already exited
        }
      };
      try {
        child.stdin.end();
      } catch {
        // the pipe is already gone
      }
      if (immediate) killChild();
      gone = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killChild();
          resolve();
        }, immediate ? KILL_WAIT_MS : EXIT_GRACE_MS);
        timer.unref?.();
        void exited.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.onEnded(this, gone);
  }

  private armIdle(): void {
    this.idle = setTimeout(() => {
      this.idle = null;
      this.drop(false);
    }, this.warmMs);
    this.idle?.unref?.();
  }

  private clearIdle(): void {
    if (this.idle === null) return;
    clearTimeout(this.idle);
    this.idle = null;
  }
}

// ---------------------------------------------------------------------------
// The probe: what `agy models` lists
// ---------------------------------------------------------------------------

/** The reasoning variants agy spells as a suffix of the model id, in order. */
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const VARIANT = new RegExp(`^(.+)-(${LEVELS.join('|')})$`);
/** `Gemini 3.8 Flash (Low)`: the model's name, then the variant's. */
const LABELLED = /^(.*\S)\s*\(([^()]+)\)$/;

/** One line of `agy models`: the id `--model` takes, a tab, the label. */
export interface AgyListed {
  id: string;
  label: string;
}

/**
 * `agy models` has no machine output this driver relies on: a progress line,
 * then `id<TAB>label` per model. Anything without a tab, or whose id is not one
 * word, is not a model line.
 */
export function parseModelLines(text: string): AgyListed[] {
  const listed: AgyListed[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    if (!/^[A-Za-z0-9][\w.:/-]*$/.test(id)) continue;
    const label = line.slice(tab + 1).trim();
    listed.push({ id, label: label.length > 0 ? label : id });
  }
  return listed;
}

function capitalized(word: string): string {
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

/**
 * The listing as the picker's models. agy lists each reasoning variant as a
 * model of its own, `gemini-3.8-flash-low` beside `gemini-3.8-flash-high`; two
 * or more variants of one base become one model, `gemini-3.8-flash`, whose
 * effort scale is those variants, so the effort chip picks among them the way
 * it does for every other agent. The default level is `medium` when there is
 * one, else `high`, else the lowest. A variant alone, and every id without a
 * suffix such as `claude-opus-4-6-thinking`, stays as listed. The descriptor's
 * `default` stays first, meaning agy's own configured model; an empty listing
 * leaves the descriptor's models standing.
 */
export function modelsFromListing(provider: ProviderDescriptor, listed: AgyListed[]): ModelInfo[] {
  const groups = new Map<string, { name: string; levels: Map<string, string> }>();
  for (const entry of listed) {
    const match = VARIANT.exec(entry.id);
    if (match === null) continue;
    const base = match[1] ?? '';
    const level = match[2] ?? '';
    const label = LABELLED.exec(entry.label);
    const group = groups.get(base) ?? { name: label?.[1] ?? base, levels: new Map<string, string>() };
    if (!group.levels.has(level)) group.levels.set(level, label?.[2] ?? capitalized(level));
    groups.set(base, group);
  }

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: true });
    seen.add(AGENT_OWN_MODEL);
  }
  for (const entry of listed) {
    const match = VARIANT.exec(entry.id);
    const base = match?.[1] ?? '';
    const group = match === null ? undefined : groups.get(base);
    if (group !== undefined && group.levels.size >= 2) {
      if (seen.has(base)) continue;
      seen.add(base);
      const ids = LEVELS.filter((level) => group.levels.has(level));
      const levels: EffortLevel[] = ids.map((id) => ({ id, label: group.levels.get(id) ?? capitalized(id) }));
      const fallback = ids.includes('medium') ? 'medium' : ids.includes('high') ? 'high' : (ids[0] ?? '');
      models.push({ id: base, name: group.name, default: false, effort: { levels, default: fallback } });
      continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push({ id: entry.id, name: entry.label, default: false });
  }
  return models.length === (own === undefined ? 0 : 1) ? provider.models : models;
}

/**
 * One short-lived `agy models`, which prints its list and exits. It runs no
 * conversation and spends nothing. A signed-out agy says so instead of
 * listing, which is refused with the one thing to do about it.
 */
async function readModels(ctx: ProbeContext): Promise<ModelInfo[]> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  const detail = { providerId: ctx.provider.id, accountId: ctx.accountId };
  if (executable === null) throw unavailable(`no ${ctx.provider.id} executable on this machine`, detail);

  const child = ctx.spawnChild(executable, [...launchPrefix(profile), ...(profile?.launch?.args ?? []), 'models'], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.provider, ctx.accountEnv),
  });
  let stdout = '';
  let stderr = '';
  const keep = (sofar: string, chunk: string): string => (sofar.length >= PROBE_OUTPUT_MAX ? sofar : sofar + chunk);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout = keep(stdout, chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = keep(stderr, chunk);
  });
  child.stdin.on('error', () => undefined);
  try {
    child.stdin.end();
  } catch {
    // the pipe is already gone
  }

  let timer: Timer | null = null;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(unavailable(`agy models did not answer in ${PROBE_TIMEOUT_MS / 1000} s`, detail));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      child.once('close', (exit) => {
        resolve(exit);
      });
      child.once('error', (error) => {
        reject(unavailable(`the Antigravity CLI did not start: ${messageOf(error)}`, detail));
      });
    });
    if (SIGNED_OUT.test(stdout) || SIGNED_OUT.test(stderr)) {
      throw unavailable('the Antigravity CLI is not signed in: run agy in a terminal, sign in, then refresh', detail);
    }
    if (code !== 0) {
      const last = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
      const head = `agy models exited with code ${code ?? 'unknown'}`;
      throw unavailable(last.length === 0 ? head : `${head}: ${last.slice(0, STDERR_MAX)}`, detail);
    }
    return modelsFromListing(ctx.provider, parseModelLines(stdout));
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      child.kill();
    } catch {
      // already exited
    }
    ctx.killTree();
  }
}

interface ProbeEntry {
  providerId: ProviderId;
  accountId: AccountId;
  /** The one process in flight for this key, so two callers share it. */
  running: Promise<ProbeResult> | null;
  result: ProbeResult | null;
}

/** One agy process per thread, kept between turns when `warmProcessMinutes` says so. */
export function createAgyDriver(): Driver {
  const sessions = new Map<ThreadId, AgySession>();
  /** A thread's last process while it is still leaving, so the next one waits for it. */
  const leaving = new Map<ThreadId, Promise<void>>();
  const probes = new Map<string, ProbeEntry>();

  const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${providerId}::${accountId}`;

  async function probe(ctx: ProbeContext): Promise<ProbeResult> {
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
  }

  function probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
    return probes.get(keyOf(providerId, accountId))?.result?.models ?? null;
  }

  /**
   * The id `--model` takes. A grouped model goes out as `<base>-<level>`, the
   * thread's effort or else the model's default level. That default comes from
   * the probe; a core that restarted has none cached, so the turn lists the
   * models once itself, traced under the thread. A model without variants goes
   * out as it is, and `default` sends nothing at all.
   */
  async function launchModel(ctx: TurnContext): Promise<string | null> {
    const model = ctx.thread.model;
    if (model === null || model === AGENT_OWN_MODEL) return null;
    // The core only accepts an effort the model lists, and only grouped models list any.
    if (ctx.thread.effort !== null) return `${model}-${ctx.thread.effort}`;
    let listed = probedModels(ctx.provider.id, ctx.account.id);
    if (listed === null) {
      try {
        listed = (await probe({
          provider: ctx.provider,
          accountId: ctx.account.id,
          accountEnv: ctx.accountEnv,
          cwd: ctx.thread.cwd,
          spawnChild: ctx.spawnChild,
          // The turn's thread may already run agy's leftovers; the probe kills its own child only.
          killTree: () => undefined,
          log: ctx.log,
        })).models;
      } catch (error) {
        ctx.log('warn', `agy: the models could not be listed before the turn, ${model} goes out as it is: ${messageOf(error)}`);
      }
    }
    const level = listed?.find((entry) => entry.id === model)?.effort?.default;
    return level === undefined || level.length === 0 ? model : `${model}-${level}`;
  }

  return {
    protocol: 'agy',
    probe,
    probedModels,

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
      const turn = new AgyTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs, ctx.sessionId)) {
        sessions.delete(threadId);
        session.close(session.key === key ? null : 'the thread changed model, effort, permission mode, account or folder', ctx);
        session = null;
      }
      if (session === null) {
        session = new AgySession(key, warmMs, ctx.sessionId, leaving.get(threadId) ?? null, launchModel, (ended, gone) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
          leaving.set(threadId, gone);
          void gone.then(() => {
            if (leaving.get(threadId) === gone) leaving.delete(threadId);
          });
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
      for (const session of open) session.close(null, undefined, true);
    },
  };
}
