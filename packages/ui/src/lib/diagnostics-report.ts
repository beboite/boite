/**
 * A client's own problems, sent to the core it is connected to so they land
 * in that machine's diagnostics as `origin: "ui"` records: rendering errors,
 * promises nobody caught, calls that failed inside the core or never got an
 * answer, the socket going away and coming back, and a frozen interface.
 *
 * Records wait in a queue of at most 200 and leave in batches of 50 through
 * `diagnostics.report`, one batch every 5 s at most. Nothing about a call's
 * parameters is ever sent, only its method and error code. A failure of the
 * report itself is never reported, and a core that does not know the method
 * (an older one) or refuses it turns the reporter off for that client.
 */
import { RpcErrorCode, type CoreLogLevel, type DiagnosticReportRecord, type LogData, type RpcMethodName } from '@boite/contracts';
import { RpcFailure, wasDropped, wasUnanswered, type Client, type ClientState, type ObservableClient } from './client';

export const REPORT_BATCH = 50;
export const REPORT_QUEUE = 200;
export const REPORT_INTERVAL_MS = 5_000;
/** A gap this long between two ticks of a one-second timer, while the page is visible, is a frozen interface. */
export const FREEZE_MS = 2_000;
const FREEZE_TICK_MS = 1_000;
/** Longer than this, the machine most likely slept: not the app's fault. */
const SLEEP_MS = 60_000;
const STACK_CHARS = 300;

type Timers = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const browserTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A stack without the page's address, which names the machine the UI was served from, cut to 300 characters. */
export function cleanStack(stack: string | undefined, origin: string = typeof location === 'undefined' ? '' : location.origin): string | undefined {
  if (!stack) return undefined;
  let text = stack;
  if (origin && origin !== 'null') text = text.split(origin).join('');
  text = text.replace(/\?[^\s:)]*/g, '').replace(/[ \t]+/g, ' ').trim();
  return text.length === 0 ? undefined : text.slice(0, STACK_CHARS);
}

function describe(reason: unknown): { message: string; stack: string | undefined } {
  if (reason instanceof Error) return { message: `${reason.name === 'Error' ? '' : `${reason.name}: `}${reason.message}`, stack: cleanStack(reason.stack) };
  if (typeof reason === 'string') return { message: reason, stack: undefined };
  try { return { message: JSON.stringify(reason)?.slice(0, 300) ?? String(reason), stack: undefined }; } catch { return { message: String(reason), stack: undefined }; }
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Whether a failed call says something about the core rather than about the network or the caller. */
function worthReporting(error: unknown): boolean {
  if (!(error instanceof RpcFailure)) return false;
  if (wasUnanswered(error) && !wasDropped(error)) return true;
  if (error.code !== RpcErrorCode.Internal) return false;
  // The socket's own failures: the reconnect record tells that story once.
  if (wasDropped(error) || /^(not connected|connection closed|client closed|connection changed)/.test(error.message)) return false;
  return true;
}

export class DiagnosticsReporter {
  readonly #client: Client;
  readonly #timers: Timers;
  #queue: DiagnosticReportRecord[] = [];
  #timer: unknown = null;
  #sending = false;
  #off = false;
  #offlineSince: number | null = null;
  #stops: (() => void)[] = [];

  constructor(client: Client, timers: Timers = browserTimers) {
    this.#client = client;
    this.#timers = timers;
  }

  /** What is waiting to leave, oldest first. */
  get queued(): readonly DiagnosticReportRecord[] { return this.#queue; }
  /** True once the core said it does not take reports from this client. */
  get disabled(): boolean { return this.#off; }

  /** Starts the socket watch and the call watch on this client. Returns the stop. */
  start(): () => void {
    this.#watchCalls();
    if ('onState' in this.#client) this.#stops.push((this.#client as ObservableClient).onState(state => this.#onState(state)));
    return () => this.stop();
  }

  stop(): void {
    for (const stop of this.#stops.splice(0)) stop();
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
  }

  /**
   * Queues one record. The same event with the same message already waiting
   * counts a repeat instead of taking a second place: a render loop is one line.
   */
  push(level: CoreLogLevel, source: string, event: string, message: string, extra: { durationMs?: number; data?: LogData; threadId?: string } = {}): void {
    if (this.#off) return;
    const text = message.replace(/[\r\n]+/g, ' ').trim().slice(0, 4096) || event;
    const same = this.#queue.find(record => record.event === event && record.message === text);
    if (same) {
      same.data = { ...(same.data ?? {}), repeats: Number(same.data?.repeats ?? 1) + 1 };
      return;
    }
    const record: DiagnosticReportRecord = { level, at: this.#timers.now(), source, event, message: text };
    if (extra.threadId) record.threadId = extra.threadId;
    if (extra.durationMs !== undefined && Number.isFinite(extra.durationMs) && extra.durationMs >= 0) record.durationMs = Math.round(extra.durationMs);
    if (extra.data && Object.keys(extra.data).length > 0) record.data = extra.data;
    this.#queue.push(record);
    if (this.#queue.length > REPORT_QUEUE) this.#queue.splice(0, this.#queue.length - REPORT_QUEUE);
    this.#schedule();
  }

  error(source: string, event: string, reason: unknown, prefix: string): void {
    const { message, stack } = describe(reason);
    this.push('error', source, event, `${prefix}: ${message}`, stack ? { data: { stack } } : {});
  }

  #schedule(): void {
    if (this.#timer !== null || this.#off || this.#queue.length === 0) return;
    this.#timer = this.#timers.setTimeout(() => { this.#timer = null; void this.flush(); }, REPORT_INTERVAL_MS);
  }

  /** Sends one batch now. A lost socket keeps it for the next try; anything else drops it. */
  async flush(): Promise<void> {
    if (this.#sending || this.#off || this.#queue.length === 0) return;
    if (this.#client.state !== 'ready') { this.#schedule(); return; }
    const batch = this.#queue.splice(0, REPORT_BATCH);
    this.#sending = true;
    try {
      await this.#client.call('diagnostics.report', { records: batch });
    } catch (error) {
      if (error instanceof RpcFailure && (error.code === RpcErrorCode.MethodNotFound || error.code === RpcErrorCode.Refused || error.code === RpcErrorCode.Unauthorized)) {
        this.#off = true;
        this.#queue = [];
      } else if (wasDropped(error) || this.#client.state !== 'ready') {
        // Lost with the socket: the batch goes again once it is back. Any other failure drops it, so a broken report cannot loop.
        this.#queue.unshift(...batch);
        if (this.#queue.length > REPORT_QUEUE) this.#queue.splice(0, this.#queue.length - REPORT_QUEUE);
      }
    } finally {
      this.#sending = false;
      this.#schedule();
    }
  }

  #onState(state: ClientState): void {
    const now = this.#timers.now();
    if (state === 'connecting' && this.#offlineSince === null) {
      this.#offlineSince = now;
      this.push('warn', 'connection', 'ui.disconnected', 'The connection to the core dropped; reconnecting');
    } else if (state === 'ready' && this.#offlineSince !== null) {
      const offline = now - this.#offlineSince;
      this.#offlineSince = null;
      this.push('warn', 'connection', 'ui.reconnected', `The connection to the core came back after ${seconds(offline)} offline`, { durationMs: offline });
    } else if (state === 'closed') {
      this.#offlineSince = null;
    }
  }

  /**
   * Every call this client makes passes here first, so a failure the core
   * answered with an internal error, or a call that never got an answer, is
   * recorded with its method and code. The client object stays the same one:
   * the code that compares clients by identity is not affected.
   */
  #watchCalls(): void {
    const client = this.#client as Client & { call: Client['call'] };
    // A method the class provides is looked up at each call, not kept: code that
    // replaces the class's method later (a test fixture, a hot reload) still runs.
    const own = Object.prototype.hasOwnProperty.call(client, 'call') ? client.call : null;
    const original = client.call;
    const reporter = this;
    const watched: Client['call'] = function (this: unknown, method, params, options) {
      const began = reporter.#timers.now();
      const target = own ?? (Object.getPrototypeOf(client) as { call: Client['call'] }).call;
      const result = target.call(client, method, params, options);
      if (method === 'diagnostics.report') return result;
      result.catch((error: unknown) => {
        if (!worthReporting(error)) return;
        const failure = error as RpcFailure;
        const timedOut = wasUnanswered(failure);
        reporter.push('error', 'rpc', timedOut ? 'ui.rpc.timeout' : 'ui.rpc.failed',
          timedOut ? `${method} got no answer from the core after ${seconds(reporter.#timers.now() - began)}` : `${method} failed inside the core (code ${failure.code}): ${failure.message.slice(0, 300)}`,
          { durationMs: reporter.#timers.now() - began, data: { method: method as RpcMethodName, code: failure.code } });
      });
      return result;
    };
    client.call = watched;
    this.#stops.push(() => {
      if (client.call !== watched) return;
      // An own property hides the class's method; removing it shows the method again.
      if (Object.prototype.hasOwnProperty.call(client, 'call') && original === Object.getPrototypeOf(client)?.call) delete (client as { call?: unknown }).call;
      else client.call = original;
    });
  }
}

/** The page-wide signals go to one reporter: the first machine this window connected to. */
const reporters = new Set<DiagnosticsReporter>();
let stopGlobal: (() => void) | null = null;

function firstReporter(): DiagnosticsReporter | undefined {
  for (const reporter of reporters) if (!reporter.disabled) return reporter;
  return undefined;
}

function watchPage(timers: Timers): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onError = (event: ErrorEvent) => {
    // A resource that failed to load has no message and is not a script error.
    if (!event.message && !event.error) return;
    const where = event.filename ? `${cleanStack(event.filename) ?? ''}:${event.lineno}:${event.colno}` : undefined;
    const reporter = firstReporter();
    if (!reporter) return;
    const { message, stack } = describe(event.error ?? event.message);
    reporter.push('error', 'window', 'ui.error', `The interface hit an error: ${message}`, { data: { ...(stack ? { stack } : {}), ...(where ? { at: where.slice(0, 300) } : {}) } });
  };
  const onRejection = (event: PromiseRejectionEvent) => firstReporter()?.error('window', 'ui.unhandled-rejection', event.reason, 'A background task failed and nothing handled it');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  // A one-second tick that arrives late means the main thread was busy for the difference.
  let last = timers.now();
  let visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  const onVisibility = () => { visible = document.visibilityState === 'visible'; last = timers.now(); };
  document.addEventListener('visibilitychange', onVisibility);
  const tick = timers.setInterval(() => {
    const now = timers.now();
    const gap = now - last - FREEZE_TICK_MS;
    last = now;
    if (!visible || gap < FREEZE_MS || gap > SLEEP_MS) return;
    firstReporter()?.push('warn', 'window', 'ui.frozen', `The interface stopped responding for ${seconds(gap)}`, { durationMs: gap });
  }, FREEZE_TICK_MS);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('visibilitychange', onVisibility);
    timers.clearInterval(tick);
  };
}

/**
 * Starts reporting for one machine's client. The page-wide watch starts with
 * the first reporter and stops with the last. Returns the stop.
 */
export function startDiagnosticsReport(client: Client, timers: Timers = browserTimers): () => void {
  const reporter = new DiagnosticsReporter(client, timers);
  const stop = reporter.start();
  reporters.add(reporter);
  if (stopGlobal === null) stopGlobal = watchPage(timers);
  return () => {
    stop();
    reporters.delete(reporter);
    if (reporters.size === 0 && stopGlobal !== null) { stopGlobal(); stopGlobal = null; }
  };
}
