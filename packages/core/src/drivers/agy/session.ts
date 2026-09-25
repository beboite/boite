/** One `agy -p=` process for a thread, its launch line and its teardown. */
import type { PermissionMode } from '@boite/contracts';
import { messageOf, unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { agentEnv, launchPrefix, profileFor, resolveExecutable } from '../../providers/loader.ts';
import { LineSplitter, STDOUT_LINE_MAX, stderrLines } from '../lines.ts';
import type { TurnContext } from '../types.ts';
import { conversationOf, rowOf, STDERR_MAX, textOf, type Row } from './events.ts';
import { drawStep, type AgyTurn } from './turn.ts';

/**
 * How long a process whose stdin was closed gets to leave on its own. agy
 * finishes writing the conversation and waits on the background work the turn
 * started before it exits; past this it is killed.
 */
const EXIT_GRACE_MS = 8_000;
/** How long a killed process gets before the next one of the thread starts anyway. */
const KILL_WAIT_MS = 2_000;
/**
 * The conversation mode, which the driver adds itself because the same binary
 * is also launched as `agy models` for the probe: a descriptor's `launch.args`
 * go first on both lines. `-p=` is print mode with the empty prompt spelled
 * out, so it swallows nothing, and it goes last.
 */
const STREAM_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
const PRINT_FLAG = '-p=';

type Timer = ReturnType<typeof setTimeout>;

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
export function sessionKey(ctx: TurnContext): string {
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
export class AgySession {
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
    const stdout = new LineSplitter((line) => {
      let event: Row;
      try {
        event = rowOf(JSON.parse(line));
      } catch {
        ctx.log('warn', `agy: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
        return;
      }
      this.onEvent(event);
    }, {
      maxLine: STDOUT_LINE_MAX,
      onOverflow: () => {
        ctx.log('warn', `agy: dropped a stdout line longer than ${STDOUT_LINE_MAX / (1024 * 1024)} MiB`);
      },
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
