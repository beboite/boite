import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LOG_CONTEXT_CHARS, logMatches, normalizeCoreLogOutput, normalizeCoreLogText as redactLogText, normalizeLogData, parseLogRecord, validateCoreLogsQuery, validateDiagnosticReport,
  type CoreLogLevel, type CoreLogRecord, type CoreLogsQuery, type DiagnosticReportRecord, type LogData, type LogOrigin, type RpcEventName, type RpcEvents,
} from '@boite/contracts';
import type { Bus, EventPayload } from './bus.ts';
import { invalidParams } from './errors.ts';

export const LOG_FILE_BYTES = 2 * 1024 * 1024;
export const LOG_FILE_COUNT = 8;
/** The shell writes `shell.0..3.ndjson` beside the core's files, in the same format. */
export const SHELL_LOG_FILE_COUNT = 4;
export { LOG_MESSAGE_CHARS } from '@boite/contracts';
const PENDING_RECORDS = 1024;
/** Records kept in memory only: written while persistence fails, or dropped from a full pending buffer. */
const UNPERSISTED_RECORDS = 4096;
const FLUSH_MS = 250;
/** The wait before the first retry of a write that failed, doubled on each failure up to `RETRY_MAX_MS`. */
const RETRY_MS = 1000;
const RETRY_MAX_MS = 60_000;
/** How far ahead of the core a record's time may be: clients' times are kept within 10 minutes. */
const CLOCK_SKEW_MS = 10 * 60_000;
/** A process that exits cleanly this soon after its start is counted in a batch, not written on its own. */
export const SHORT_PROCESS_MS = 2000;
/** How long a turn's batch of short processes gathers before it is written. */
export const PROCESS_BATCH_MS = 10_000;
const SWEEP_MS = 1000;

/** The short processes of one turn, written as one `process.batch` record. */
interface ProcessBatch { threadId: string; turnId: string | undefined; openedAt: number; firstAt: number; lastAt: number; count: number; cpuMs: number; exes: Map<string, number> }

/** Only explicit diagnostic metadata can cross this boundary. Never pass a payload. */
export type LogContext = Pick<CoreLogRecord, 'source' | 'event' | 'threadId' | 'turnId' | 'requestId'> & {
  durationMs?: number;
  data?: LogData;
  origin?: LogOrigin;
  /** Set by a caller that knows better than the thread lookup, such as a turn that switched model. */
  providerId?: string;
  model?: string;
};

/** Who a thread is, so every record about it names its agent. */
export type ThreadIdentity = { providerId: string; model: string | null; parentThreadId: string | null };

export { normalizeCoreLogText as redactLogText } from '@boite/contracts';

/** Persistent diagnostics are separate from the transactional operational journal. */
export class DiagnosticLogs {
  readonly runId = crypto.randomUUID();
  readonly directory: string;
  /** Resolves a thread id to its agent; set by the core once the journal is open. */
  describeThread: (threadId: string) => ThreadIdentity | null = () => null;
  /**
   * Records the files do not hold yet, oldest first: pending ones and the batch being
   * appended, which a query running meanwhile still sees, plus those that will never be
   * written (the pending buffer was full, a record too large for a file). An append
   * removes what it wrote: the files answer for it from then on.
   */
  readonly #unpersisted = new Map<string, CoreLogRecord>();
  #pending: CoreLogRecord[] = [];
  #writing: Promise<void> = Promise.resolve();
  readonly #ready: Promise<void>;
  /** Whether the folder exists and `bytes` matches the newest file; a failed write sets it back, so the next one checks again. */
  #prepared = false;
  /** Writes that failed in a row; 0 while the files keep up. */
  #failures = 0;
  #bytes = 0;
  #sequence = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #flushing = false;
  #failureReported = false;
  #overflowReported = false;
  #dropped = 0;
  #unsubscribe: (() => void) | undefined;
  #queued = new Set<string>();
  readonly #activeTurns = new Map<string, { turnId: string; startedAt: number }>();
  readonly #processTurns = new Map<string, string>();
  readonly #heldStarts = new Map<string, { proc: RpcEvents['process.started']; turnId: string | undefined; heldAt: number }>();
  readonly #batches = new Map<string, ProcessBatch>();
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, private readonly secrets: readonly string[] = [], private readonly report: (message: string) => void = message => console.error(message), private readonly fileBytes = LOG_FILE_BYTES) {
    this.directory = join(dataDir, 'logs');
    // Startup performs only bounded metadata operations. History is read on demand.
    this.#ready = this.#initialize().then(() => { this.#prepared = true; }, error => this.#setback([], error));
  }

  #path(index: number): string { return join(this.directory, `core.${index}.ndjson`); }
  #shellPath(index: number): string { return join(this.directory, `shell.${index}.ndjson`); }

  /** Every file a query or an export reads, with its size: what Settings lists. */
  async files(): Promise<{ name: string; bytes: number }[]> {
    const names = [...Array.from({ length: LOG_FILE_COUNT }, (_, index) => `core.${index}.ndjson`), ...Array.from({ length: SHELL_LOG_FILE_COUNT }, (_, index) => `shell.${index}.ndjson`)];
    const files: { name: string; bytes: number }[] = [];
    for (const name of names) {
      try { files.push({ name, bytes: (await stat(join(this.directory, name))).size }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return files;
  }

  async #initialize(): Promise<void> {
    this.#bytes = 0;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (let index = 0; index < LOG_FILE_COUNT; index += 1) {
      try {
        await chmod(this.#path(index), 0o600);
        if (index === 0) this.#bytes = (await stat(this.#path(index))).size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (this.#bytes > 0) {
      const handle = await open(this.#path(0), 'r+');
      let rotate = false;
      try {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, this.#bytes - 1);
        // Isolate a crash's partial record, so the next append remains readable.
        if (tail[0] !== 10 && this.#bytes < this.fileBytes) { await handle.write('\n', this.#bytes); this.#bytes += 1; }
        else if (tail[0] !== 10) rotate = true;
      } finally { await handle.close(); }
      if (rotate) await this.#rotate();
    }
  }

  normalize(payload: RpcEvents['core.log']): RpcEvents['core.log'] {
    const context = this.#context(payload);
    const data = normalizeLogData(this.#maskData(payload.data), this.secrets);
    const message = this.mask(payload.message);
    return { level: payload.level, at: payload.at, message: payload.kind === 'provider-output' ? normalizeCoreLogOutput(message, this.secrets) : redactLogText(message, this.secrets),
      source: context.source, event: context.event,
      ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
      ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(validDuration(payload.durationMs) ? { durationMs: Math.round(payload.durationMs!) } : {}),
      ...(data ? { data } : {}),
      ...(payload.kind === 'provider-output' ? { kind: payload.kind } : {}) };
  }

  /** Credentials and sensitive fields removed, as every stored record is. */
  redact(text: string): string { return redactLogText(this.mask(text), this.secrets); }
  /** Replaces the value of every secret in use by `•••• (<NAME>)`, before any cut; set by the core once its secret store exists. */
  mask: (text: string) => string = text => text;
  #maskData(raw: unknown): unknown {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? this.mask(value) : value]));
  }
  /** A client's report, redacted with the secrets this store knows; they never leave it. */
  validateReport(raw: unknown): DiagnosticReportRecord[] { return validateDiagnosticReport(raw, this.secrets); }

  #bounded(value: string): string { return redactLogText(value, this.secrets).replace(/[\r\n\t]/g, ' ').slice(0, LOG_CONTEXT_CHARS); }

  #context(raw: Partial<LogContext>): Required<Pick<CoreLogRecord, 'source' | 'event'>> & Pick<CoreLogRecord, 'threadId' | 'turnId' | 'requestId'> {
    return {
      source: this.#bounded(raw.source ?? 'core'), event: this.#bounded(raw.event ?? 'core.log'),
      ...(typeof raw.threadId === 'string' ? { threadId: this.#bounded(raw.threadId) } : {}),
      ...(typeof raw.turnId === 'string' ? { turnId: this.#bounded(raw.turnId) } : {}),
      ...(typeof raw.requestId === 'string' ? { requestId: this.#bounded(raw.requestId) } : {}),
    };
  }

  /** The agent a thread runs, looked up once per record. A lookup that throws names nobody. */
  #identity(threadId: string | undefined, context: Partial<LogContext>): Pick<CoreLogRecord, 'providerId' | 'model' | 'parentThreadId'> {
    let known: ThreadIdentity | null = null;
    if (threadId !== undefined) { try { known = this.describeThread(threadId); } catch { known = null; } }
    const providerId = context.providerId ?? known?.providerId;
    const model = context.model ?? known?.model ?? undefined;
    const parent = known?.parentThreadId ?? undefined;
    return {
      ...(providerId ? { providerId: this.#bounded(providerId) } : {}),
      ...(model ? { model: this.#bounded(model) } : {}),
      ...(parent ? { parentThreadId: this.#bounded(parent) } : {}),
    };
  }

  record(level: CoreLogLevel, message: string, context: Partial<LogContext> = {}, at = Date.now()): void {
    if (this.#closed) return;
    const base = this.#context(context);
    const data = normalizeLogData(this.#maskData(context.data), this.secrets);
    const record: CoreLogRecord = {
      id: `${this.runId}:${++this.#sequence}`, runId: this.runId, at, level,
      ...(context.origin && context.origin !== 'core' ? { origin: context.origin } : {}),
      ...base, ...this.#identity(base.threadId, context),
      ...(validDuration(context.durationMs) ? { durationMs: Math.round(context.durationMs!) } : {}),
      ...(data ? { data } : {}),
      message: redactLogText(this.mask(message), this.secrets),
    };
    this.#unpersisted.set(record.id, record);
    if (this.#unpersisted.size > UNPERSISTED_RECORDS) this.#unpersisted.delete(this.#unpersisted.keys().next().value!);
    if (this.#pending.length >= PENDING_RECORDS) {
      this.#dropped += 1;
      if (!this.#overflowReported) { this.#overflowReported = true; this.#safeReport('diagnostic logs: pending buffer is full; new records remain only in memory and will not be persisted'); }
      return;
    }
    this.#pending.push(record);
    // After a failed write, a retry waits on its timer: a new record does not bring it forward,
    // but re-arms one when the last retry found nothing to write.
    if (this.#failures > 0) {
      if (this.#timer === null && !this.#flushing) this.#schedule(this.#retryDelay());
      return;
    }
    if (this.#pending.length >= 64 && this.#timer !== null) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#timer === null && !this.#flushing) this.#schedule(this.#pending.length >= 64 ? 0 : FLUSH_MS);
  }

  #schedule(delay: number): void {
    this.#timer = setTimeout(() => { this.#timer = null; if (!this.#closed) void this.flush(); }, delay);
    this.#timer.unref();
  }

  debug(message: string, context: Partial<LogContext> = {}): void { this.record('debug', message, context); }
  info(message: string, context: Partial<LogContext> = {}): void { this.record('info', message, context); }
  warn(message: string, context: Partial<LogContext> = {}): void { this.record('warn', message, context); }
  error(message: string, context: Partial<LogContext> = {}): void { this.record('error', message, context); }

  attach(bus: Bus): void {
    bus.normalizeLog = payload => this.normalize(payload);
    this.#unsubscribe = bus.onCommitted((name, payload) => this.#observe(name, payload));
  }

  #observe(name: RpcEventName, payload: EventPayload): void {
    if (name === 'core.log') {
      const log = payload as RpcEvents['core.log'];
      this.record(log.level, log.kind === 'provider-output' ? '[provider output omitted]' : log.message, log, log.at);
    } else if (name === 'scheduler.updated') {
      const state = payload as RpcEvents['scheduler.updated'];
      const queued = new Set(state.queued.map(entry => entry.turnId));
      for (const entry of state.queued) if (!this.#queued.has(entry.turnId)) this.record('info', 'Turn queued', { source: 'scheduler', event: 'turn.queued', threadId: entry.threadId, turnId: entry.turnId }, entry.queuedAt);
      this.#queued = queued;
    } else if (name === 'turn.started' || name === 'turn.finished') {
      this.#observeTurn(name, payload as RpcEvents['turn.started']);
    } else if (name === 'process.started' || name === 'process.exited') {
      this.#observeProcess(name, payload as RpcEvents['process.started']);
    }
  }

  /**
   * A start waits up to `SHORT_PROCESS_MS` for its exit. A clean exit within
   * that time joins its turn's batch instead of two records: on 2026-10-17,
   * about 20 agents wrote 89 process records a second (shell helpers, `sed`,
   * `git`), and the eight files held six minutes (docs/trace.md).
   */
  #observeProcess(name: 'process.started' | 'process.exited', proc: RpcEvents['process.started']): void {
    const key = `${proc.threadId}:${proc.pid}`;
    const turnId = this.#processTurns.get(key) ?? this.#activeTurns.get(proc.threadId)?.turnId;
    if (name === 'process.started') {
      if (turnId !== undefined) this.#processTurns.set(key, turnId);
      this.#heldStarts.set(key, { proc, turnId, heldAt: Date.now() });
      this.#sweepLater();
      return;
    }
    this.#processTurns.delete(key);
    const held = this.#heldStarts.get(key);
    this.#heldStarts.delete(key);
    const lifetime = proc.exitedAt !== null && proc.exitedAt !== undefined ? proc.exitedAt - proc.startedAt : undefined;
    // A batch says nothing of how each process ended: an exit with no status the OS gave keeps its records.
    if (held && proc.exitCode !== null && !crashed(proc.exitCode) && lifetime !== undefined && lifetime < SHORT_PROCESS_MS) { this.#count(proc, turnId); return; }
    if (held) this.#writeProcess('process.started', held.proc, held.turnId);
    this.#writeProcess('process.exited', proc, turnId);
  }

  #writeProcess(name: 'process.started' | 'process.exited', proc: RpcEvents['process.started'], turnId: string | undefined): void {
    const exe = executableName(proc.exe);
    const lifetime = proc.exitedAt !== null && proc.exitedAt !== undefined ? proc.exitedAt - proc.startedAt : undefined;
    const data: LogData = { pid: proc.pid, ...(proc.parentPid === null ? {} : { parentPid: proc.parentPid }), ...(exe ? { exe } : {}) };
    if (name === 'process.exited') {
      if (proc.cpuMs !== null && proc.cpuMs !== undefined) data.cpuMs = proc.cpuMs;
      if (proc.peakMemoryBytes !== null && proc.peakMemoryBytes !== undefined) data.peakMemoryMb = Math.round(proc.peakMemoryBytes / 1048576);
      data.exitCode = proc.exitCode;
    }
    const failed = name === 'process.exited' && crashed(proc.exitCode);
    this.record(failed ? 'warn' : 'debug', name === 'process.started' ? `Process ${exe ?? 'unknown'} started, pid ${proc.pid}` : `Process ${exe ?? 'unknown'} exited, pid ${proc.pid}, code ${proc.exitCode ?? 'unknown'}`,
      { source: 'processes', event: name, threadId: proc.threadId, turnId, data, ...(name === 'process.exited' && lifetime !== undefined ? { durationMs: lifetime } : {}) },
      (name === 'process.started' ? proc.startedAt : proc.exitedAt) ?? Date.now());
  }

  #count(proc: RpcEvents['process.started'], turnId: string | undefined): void {
    const key = `${proc.threadId}:${turnId ?? ''}`;
    let batch = this.#batches.get(key);
    if (!batch) {
      batch = { threadId: proc.threadId, turnId, openedAt: Date.now(), firstAt: proc.startedAt, lastAt: proc.startedAt, count: 0, cpuMs: 0, exes: new Map() };
      this.#batches.set(key, batch);
    }
    const exe = executableName(proc.exe) ?? 'unknown';
    batch.count += 1;
    batch.firstAt = Math.min(batch.firstAt, proc.startedAt);
    batch.lastAt = Math.max(batch.lastAt, proc.exitedAt ?? proc.startedAt);
    batch.cpuMs += proc.cpuMs ?? 0;
    batch.exes.set(exe, (batch.exes.get(exe) ?? 0) + 1);
  }

  /** Writes the starts that waited `SHORT_PROCESS_MS` and the batches that gathered `PROCESS_BATCH_MS`, or all of them. */
  #sweep(all = false): void {
    const now = Date.now();
    for (const [key, held] of this.#heldStarts) {
      if (!all && now - held.heldAt < SHORT_PROCESS_MS) continue;
      this.#heldStarts.delete(key);
      this.#writeProcess('process.started', held.proc, held.turnId);
    }
    for (const [key, batch] of this.#batches) {
      if (!all && now - batch.openedAt < PROCESS_BATCH_MS) continue;
      this.#batches.delete(key);
      const exes = [...batch.exes].sort((a, b) => b[1] - a[1]).map(([exe, count]) => `${exe} ${count}`).join(', ');
      this.record('debug', `${batch.count} short ${batch.count === 1 ? 'process' : 'processes'} ran: ${exes}`,
        { source: 'processes', event: 'process.batch', threadId: batch.threadId, turnId: batch.turnId, durationMs: batch.lastAt - batch.firstAt, data: { count: batch.count, cpuMs: batch.cpuMs, exes } },
        batch.firstAt);
    }
    if (this.#heldStarts.size === 0 && this.#batches.size === 0 && this.#sweeper !== null) { clearInterval(this.#sweeper); this.#sweeper = null; }
  }

  #sweepLater(): void {
    if (this.#sweeper !== null) return;
    this.#sweeper = setInterval(() => this.#sweep(), SWEEP_MS);
    this.#sweeper.unref();
  }

  #observeTurn(name: 'turn.started' | 'turn.finished', turn: RpcEvents['turn.started']): void {
    if (name === 'turn.started') {
      this.#activeTurns.set(turn.threadId, { turnId: turn.id, startedAt: turn.startedAt ?? Date.now() });
      const waited = typeof turn.startedAt === 'number' && typeof turn.queuedAt === 'number' ? turn.startedAt - turn.queuedAt : null;
      this.record('info', waited !== null && waited >= 1000 ? `Turn started after ${Math.round(waited / 100) / 10} s in the queue` : 'Turn started',
        { source: 'turns', event: name, threadId: turn.threadId, turnId: turn.id, ...turnAgent(turn), data: { ...(waited !== null ? { queuedMs: waited } : {}), ...(turn.execution?.effort ? { effort: turn.execution.effort } : {}), ...(turn.execution?.accountId ? { accountId: turn.execution.accountId } : {}) } }, turn.startedAt ?? Date.now());
      return;
    }
    const active = this.#activeTurns.get(turn.threadId);
    if (active?.turnId === turn.id) this.#activeTurns.delete(turn.threadId);
    // Only this turn's own start: the thread may be running another turn while this one ends.
    const started = turn.startedAt ?? (active?.turnId === turn.id ? active.startedAt : undefined);
    const finished = turn.finishedAt ?? Date.now();
    const data: LogData = { status: turn.status };
    if (turn.usage) {
      data.inputTokens = turn.usage.inputTokens; data.outputTokens = turn.usage.outputTokens;
      data.cacheReadTokens = turn.usage.cacheReadTokens; data.cacheWriteTokens = turn.usage.cacheWriteTokens;
      if (turn.usage.costUsdEquivalent !== null) data.costUsdEquivalent = turn.usage.costUsdEquivalent;
    }
    if (turn.execution?.effort) data.effort = turn.execution.effort;
    if (turn.execution?.permissionMode) data.permissionMode = turn.execution.permissionMode;
    const level: CoreLogLevel = turn.status === 'error' ? 'error' : turn.status === 'stopped' ? 'warn' : 'info';
    // turn.error can carry the provider's own output; the cause goes in turn.failed from its diagnostic text.
    this.record(level, `Turn finished: ${turn.status}`,
      { source: 'turns', event: name, threadId: turn.threadId, turnId: turn.id, data, ...turnAgent(turn), ...(started !== undefined && started !== null ? { durationMs: finished - started } : {}) }, finished);
  }

  flush(): Promise<void> {
    if (this.#timer !== null) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#flushing || this.#pending.length === 0) return this.#writing;
    this.#flushing = true;
    // One writer drains a bounded pending buffer, without a per-batch promise chain.
    this.#writing = this.#writing.then(async () => {
      await this.#ready;
      while (this.#pending.length > 0) {
        const batch = this.#pending;
        this.#pending = [];
        const progress = { written: 0 };
        try {
          if (!this.#prepared) { await this.#initialize(); this.#prepared = true; }
          await this.#append(batch, progress);
        } catch (error) {
          this.#setback(batch.slice(progress.written), error);
          return;
        }
        this.#recovered();
        this.#overflowReported = false;
        if (this.#dropped > 0) {
          const count = this.#dropped;
          this.#dropped = 0;
          this.record('warn', `${count} diagnostics were not persisted because the pending buffer was full`, { source: 'logs', event: 'logs.dropped', data: { count } });
        }
      }
    }).finally(() => { this.#flushing = false; });
    return this.#writing;
  }

  /**
   * A write that failed: what it did not write goes back to the head of the
   * queue, the next attempt checks the folder and the newest file again, and it
   * waits longer after each failure in a row. The records stay queryable from
   * memory meanwhile. A full disk or a folder briefly in the way no longer ends
   * persistence for the rest of the run. Reported once per outage.
   */
  #setback(unwritten: CoreLogRecord[], error: unknown): void {
    const queue = [...unwritten, ...this.#pending];
    this.#dropped += Math.max(0, queue.length - PENDING_RECORDS);
    this.#pending = queue.slice(0, PENDING_RECORDS);
    this.#prepared = false;
    this.#failures += 1;
    this.#failure(error);
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#schedule(this.#retryDelay());
  }

  #retryDelay(): number { return Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (this.#failures - 1)); }

  /** The first write after an outage: the next failure is reported again, and the log says how long it lasted. */
  #recovered(): void {
    if (this.#failures === 0) return;
    const failures = this.#failures;
    this.#failures = 0;
    this.#failureReported = false;
    this.record('warn', `diagnostic logs are written again after ${failures} failed ${failures === 1 ? 'attempt' : 'attempts'}`, { source: 'logs', event: 'logs.recovered', data: { failures } });
  }

  /** `progress.written` counts the records of `batch` the files hold, so a failure part way re-queues only the rest. */
  async #append(batch: CoreLogRecord[], progress: { written: number }): Promise<void> {
    let chunk = '';
    let chunkBytes = 0;
    let written: string[] = [];
    // The records of `batch` up to the chunk's last one, skipped ones included.
    let covered = progress.written;
    const write = async (): Promise<void> => {
      if (chunk) {
        const handle = await open(this.#path(0), 'a', 0o600);
        try { await handle.writeFile(chunk); } finally { await handle.close(); }
        this.#bytes += chunkBytes; chunk = ''; chunkBytes = 0;
        for (const id of written) this.#unpersisted.delete(id);
        written = [];
      }
      progress.written = covered;
    };
    for (const record of batch) {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      // Too large for any file: it stays in memory only, and no retry tries it again.
      if (bytes > this.fileBytes) { covered += 1; continue; }
      if (this.#bytes + chunkBytes + bytes > this.fileBytes) { await write(); await this.#rotate(); }
      chunk += line; chunkBytes += bytes; written.push(record.id); covered += 1;
    }
    await write();
  }

  async #rotate(): Promise<void> {
    await unlink(this.#path(LOG_FILE_COUNT - 1)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    for (let index = LOG_FILE_COUNT - 2; index >= 0; index -= 1) {
      await rename(this.#path(index), this.#path(index + 1)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    this.#bytes = 0;
  }

  async query(raw: CoreLogsQuery): Promise<CoreLogRecord[]> {
    let query: ReturnType<typeof validateCoreLogsQuery>;
    try { query = validateCoreLogsQuery(raw); } catch (error) { throw invalidParams((error as Error).message); }
    return this.select(record => logMatches(record, query), query.limit, query.since);
  }

  /**
   * The newest `limit` records a predicate keeps, from every core and shell
   * file and the records not written yet, newest first. Core files are read
   * newest first and the read stops once an older file cannot change the answer.
   * `since`, when the predicate keeps nothing older, skips every file last
   * written before it.
   */
  async select(keep: (record: CoreLogRecord) => boolean, limit: number, since?: number): Promise<CoreLogRecord[]> {
    await this.#ready;
    await this.flush();
    let result: CoreLogRecord[] = [];
    const fromMemory = (): CoreLogRecord[] => [...this.#unpersisted.values()].filter(keep);
    // Serialize the bounded history read with rotation, so a query cannot miss a renamed file.
    this.#writing = this.#writing.then(async () => {
      const records = new Map<string, CoreLogRecord>();
      // Larger is newer everywhere, for records of the same millisecond: a later line of a file,
      // a newer file, memory last. Insertion order alone is newest file first, oldest line first.
      const rank = new Map<string, number>();
      const place = (record: CoreLogRecord, value: number): void => { records.set(record.id, record); rank.set(record.id, value); };
      fromMemory().forEach((record, line) => place(record, (LOG_FILE_COUNT + 1) * LINES_PER_FILE + line));
      // A record's time can be earlier than its write (a turn logs when it was queued), so file
      // order says nothing about `at`. A file's modification time does bound what it holds:
      // nothing in it is newer than its last write, give or take a client's allowed clock skew.
      const tooOld = (modified: number): boolean => since !== undefined && modified + CLOCK_SKEW_MS < since;
      for (let index = 0; index < LOG_FILE_COUNT; index += 1) {
        // Once `limit` kept records are all newer than that bound, or `since` is, this file and
        // older rotations cannot enter. The newest file is read whatever its time unless `since` excludes it.
        if (since !== undefined || (index > 0 && records.size >= limit)) {
          const modified = await this.#modified(this.#path(index));
          // A missing file (deleted, or a crash mid-rotation) holds nothing; older ones still can.
          if (modified === null) continue;
          if (tooOld(modified)) break;
          if (index > 0 && records.size >= limit) {
            const limitTh = [...records.values()].map(record => record.at).sort((a, b) => b - a)[limit - 1]!;
            if (limitTh > modified + CLOCK_SKEW_MS) break;
          }
        }
        (await this.#read(this.#path(index), 'core', keep)).forEach((record, line) => { if (!records.has(record.id)) place(record, (LOG_FILE_COUNT - index) * LINES_PER_FILE + line); });
      }
      // Bands below the core's, so a shell and a core record of the same millisecond always sort the same way.
      // The shell rotates its own files: each one is checked on its own.
      for (let index = 0; index < SHELL_LOG_FILE_COUNT; index += 1) {
        if (since !== undefined) {
          const modified = await this.#modified(this.#shellPath(index));
          if (modified === null || tooOld(modified)) continue;
        }
        (await this.#read(this.#shellPath(index), 'shell', keep)).forEach((record, line) => place(record, -(index + 1) * LINES_PER_FILE + line));
      }
      // What was recorded while the files were read is in memory only, and newest of all.
      fromMemory().forEach((record, line) => { if (!records.has(record.id)) place(record, (LOG_FILE_COUNT + 2) * LINES_PER_FILE + line); });
      result = sortNewest([...records.values()], record => rank.get(record.id) ?? 0).slice(0, limit);
    }).catch(error => { this.#failure(error); result = sortNewest(fromMemory()).slice(0, limit); });
    await this.#writing;
    return result;
  }

  async #modified(path: string): Promise<number | null> {
    try { return (await stat(path)).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  async #read(path: string, origin: LogOrigin, keep: (record: CoreLogRecord) => boolean): Promise<CoreLogRecord[]> {
    let handle;
    try { handle = await open(path, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      // Past the cap, the tail: a file is appended to, so its newest records are last.
      // A line cut at the start of the window fails to parse and is skipped.
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, Math.max(this.fileBytes, LOG_FILE_BYTES)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
      const records: CoreLogRecord[] = [];
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        // A crash can leave an incomplete final line; other records still answer.
        // Re-redacted with today's secrets: a credential configured after the write is still removed.
        const record = parseLogRecord(line, origin, this.secrets);
        if (record !== null && keep(record)) records.push(record);
      }
      return records;
    } finally { await handle.close(); }
  }

  #safeReport(message: string): void { try { this.report(message); } catch { /* Reporting must never interrupt core work. */ } }
  #failure(error: unknown): void { if (this.#failureReported) return; this.#failureReported = true; this.#safeReport(`diagnostic logs unavailable: ${redactLogText(error instanceof Error ? error.message : String(error), this.secrets)}`); }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#sweep(true);
    await this.flush();
    await this.#ready;
    this.#closed = true;
    if (this.#timer !== null) { clearTimeout(this.#timer); this.#timer = null; }
  }
}

/**
 * An agent's own commands exit 1 all the time (grep with no match, a failing test): that is work,
 * not a fault. A signal or a Windows status code (above 255, such as 0xC0000005) is a crash.
 */
function crashed(exitCode: number | null): boolean {
  return exitCode !== null && (exitCode < 0 || exitCode > 255);
}

/** The agent frozen for this turn, which a later model switch does not rewrite. */
function turnAgent(turn: RpcEvents['turn.started']): Pick<LogContext, 'providerId' | 'model'> {
  return { ...(turn.execution?.providerId ? { providerId: turn.execution.providerId } : {}), ...(turn.execution?.model ? { model: turn.execution.model } : {}) };
}

function validDuration(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

/** Above the lines any file can hold, so a file's rank never reaches the next one's. */
const LINES_PER_FILE = 10_000_000;

/** Newest first; `order` breaks a tie of the same millisecond, larger being newer (by default, the later in the list). */
function sortNewest(records: CoreLogRecord[], order: (record: CoreLogRecord, index: number) => number = (_record, index) => index): CoreLogRecord[] {
  return records.map((record, index) => ({ record, rank: order(record, index) })).sort((a, b) => b.record.at - a.record.at || b.rank - a.rank).map(entry => entry.record);
}

/** The program's file name, without its folder: which tool ran, never where the user keeps it. */
export function executableName(exe: string | null | undefined): string | null {
  if (!exe) return null;
  const name = exe.split(/[\\/]/).pop() ?? '';
  return name.length > 0 ? name.slice(0, 80) : null;
}
