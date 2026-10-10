import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LOG_CONTEXT_CHARS, logMatches, normalizeCoreLogOutput, normalizeCoreLogText as redactLogText, normalizeLogData, parseLogRecord, validateCoreLogsQuery,
  type CoreLogLevel, type CoreLogRecord, type CoreLogsQuery, type LogData, type LogOrigin, type RpcEventName, type RpcEvents,
} from '@boite/contracts';
import type { Bus, EventPayload } from './bus.ts';
import { invalidParams } from './errors.ts';

export const LOG_FILE_BYTES = 2 * 1024 * 1024;
export const LOG_FILE_COUNT = 8;
/** The shell writes `shell.0..3.ndjson` beside the core's files, in the same format. */
export const SHELL_LOG_FILE_COUNT = 4;
export { LOG_MESSAGE_CHARS } from '@boite/contracts';
const PENDING_RECORDS = 1024;
const RECENT_RECORDS = 4096;
const FLUSH_MS = 250;
/** How far ahead of the core a record's time may be: clients' times are kept within 10 minutes. */
const CLOCK_SKEW_MS = 10 * 60_000;

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
  private readonly recent = new Map<string, CoreLogRecord>();
  private pending: CoreLogRecord[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private bytes = 0;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private flushing = false;
  private failureReported = false;
  private failed = false;
  private overflowReported = false;
  private dropped = 0;
  private unsubscribe: (() => void) | undefined;
  private queued = new Set<string>();
  private readonly activeTurns = new Map<string, { turnId: string; startedAt: number }>();
  private readonly processTurns = new Map<string, string>();

  constructor(dataDir: string, private readonly secrets: readonly string[] = [], private readonly report: (message: string) => void = message => console.error(message), private readonly fileBytes = LOG_FILE_BYTES) {
    this.directory = join(dataDir, 'logs');
    // Startup performs only bounded metadata operations. History is read on demand.
    this.ready = this.initialize().catch(error => { this.failed = true; this.failure(error); });
  }

  private path(index: number): string { return join(this.directory, `core.${index}.ndjson`); }
  private shellPath(index: number): string { return join(this.directory, `shell.${index}.ndjson`); }

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

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (let index = 0; index < LOG_FILE_COUNT; index += 1) {
      try {
        await chmod(this.path(index), 0o600);
        if (index === 0) this.bytes = (await stat(this.path(index))).size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (this.bytes > 0) {
      const handle = await open(this.path(0), 'r+');
      let rotate = false;
      try {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, this.bytes - 1);
        // Isolate a crash's partial record, so the next append remains readable.
        if (tail[0] !== 10 && this.bytes < this.fileBytes) { await handle.write('\n', this.bytes); this.bytes += 1; }
        else if (tail[0] !== 10) rotate = true;
      } finally { await handle.close(); }
      if (rotate) await this.rotate();
    }
  }

  normalize(payload: RpcEvents['core.log']): RpcEvents['core.log'] {
    const context = this.context(payload);
    const data = normalizeLogData(payload.data, this.secrets);
    return { level: payload.level, at: payload.at, message: payload.kind === 'provider-output' ? normalizeCoreLogOutput(payload.message, this.secrets) : redactLogText(payload.message, this.secrets),
      source: context.source, event: context.event,
      ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
      ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(validDuration(payload.durationMs) ? { durationMs: Math.round(payload.durationMs!) } : {}),
      ...(data ? { data } : {}),
      ...(payload.kind === 'provider-output' ? { kind: payload.kind } : {}) };
  }

  /** Credentials and sensitive fields removed, as every stored record is. */
  redact(text: string): string { return redactLogText(text, this.secrets); }

  private bounded(value: string): string { return redactLogText(value, this.secrets).replace(/[\r\n\t]/g, ' ').slice(0, LOG_CONTEXT_CHARS); }

  private context(raw: Partial<LogContext>): Required<Pick<CoreLogRecord, 'source' | 'event'>> & Pick<CoreLogRecord, 'threadId' | 'turnId' | 'requestId'> {
    return {
      source: this.bounded(raw.source ?? 'core'), event: this.bounded(raw.event ?? 'core.log'),
      ...(typeof raw.threadId === 'string' ? { threadId: this.bounded(raw.threadId) } : {}),
      ...(typeof raw.turnId === 'string' ? { turnId: this.bounded(raw.turnId) } : {}),
      ...(typeof raw.requestId === 'string' ? { requestId: this.bounded(raw.requestId) } : {}),
    };
  }

  /** The agent a thread runs, looked up once per record. A lookup that throws names nobody. */
  private identity(threadId: string | undefined, context: Partial<LogContext>): Pick<CoreLogRecord, 'providerId' | 'model' | 'parentThreadId'> {
    let known: ThreadIdentity | null = null;
    if (threadId !== undefined) { try { known = this.describeThread(threadId); } catch { known = null; } }
    const providerId = context.providerId ?? known?.providerId;
    const model = context.model ?? known?.model ?? undefined;
    const parent = known?.parentThreadId ?? undefined;
    return {
      ...(providerId ? { providerId: this.bounded(providerId) } : {}),
      ...(model ? { model: this.bounded(model) } : {}),
      ...(parent ? { parentThreadId: this.bounded(parent) } : {}),
    };
  }

  record(level: CoreLogLevel, message: string, context: Partial<LogContext> = {}, at = Date.now()): void {
    if (this.closed) return;
    const base = this.context(context);
    const data = normalizeLogData(context.data, this.secrets);
    const record: CoreLogRecord = {
      id: `${this.runId}:${++this.sequence}`, runId: this.runId, at, level,
      ...(context.origin && context.origin !== 'core' ? { origin: context.origin } : {}),
      ...base, ...this.identity(base.threadId, context),
      ...(validDuration(context.durationMs) ? { durationMs: Math.round(context.durationMs!) } : {}),
      ...(data ? { data } : {}),
      message: redactLogText(message, this.secrets),
    };
    this.recent.set(record.id, record);
    if (this.recent.size > RECENT_RECORDS) this.recent.delete(this.recent.keys().next().value!);
    if (this.failed) return;
    if (this.pending.length >= PENDING_RECORDS) {
      this.dropped += 1;
      if (!this.overflowReported) { this.overflowReported = true; this.safeReport('diagnostic logs: pending buffer is full; new records remain only in recent memory and will not be persisted'); }
      return;
    }
    this.pending.push(record);
    if (this.pending.length >= 64 && this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.timer === null && !this.flushing) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.pending.length >= 64 ? 0 : FLUSH_MS);
      this.timer.unref();
    }
  }

  debug(message: string, context: Partial<LogContext> = {}): void { this.record('debug', message, context); }
  info(message: string, context: Partial<LogContext> = {}): void { this.record('info', message, context); }
  warn(message: string, context: Partial<LogContext> = {}): void { this.record('warn', message, context); }
  error(message: string, context: Partial<LogContext> = {}): void { this.record('error', message, context); }

  attach(bus: Bus): void {
    bus.normalizeLog = payload => this.normalize(payload);
    this.unsubscribe = bus.onCommitted((name, payload) => this.observe(name, payload));
  }

  private observe(name: RpcEventName, payload: EventPayload): void {
    if (name === 'core.log') {
      const log = payload as RpcEvents['core.log'];
      this.record(log.level, log.kind === 'provider-output' ? '[provider output omitted]' : log.message, log, log.at);
    } else if (name === 'scheduler.updated') {
      const state = payload as RpcEvents['scheduler.updated'];
      const queued = new Set(state.queued.map(entry => entry.turnId));
      for (const entry of state.queued) if (!this.queued.has(entry.turnId)) this.record('info', 'Turn queued', { source: 'scheduler', event: 'turn.queued', threadId: entry.threadId, turnId: entry.turnId }, entry.queuedAt);
      this.queued = queued;
    } else if (name === 'turn.started' || name === 'turn.finished') {
      this.observeTurn(name, payload as RpcEvents['turn.started']);
    } else if (name === 'process.started' || name === 'process.exited') {
      const proc = payload as RpcEvents['process.started'];
      const key = `${proc.threadId}:${proc.pid}`;
      const turnId = this.processTurns.get(key) ?? this.activeTurns.get(proc.threadId)?.turnId;
      if (name === 'process.started' && turnId !== undefined) this.processTurns.set(key, turnId);
      if (name === 'process.exited') this.processTurns.delete(key);
      const exe = executableName(proc.exe);
      const lifetime = proc.exitedAt !== null && proc.exitedAt !== undefined ? proc.exitedAt - proc.startedAt : undefined;
      const data: LogData = { pid: proc.pid, ...(proc.parentPid === null ? {} : { parentPid: proc.parentPid }), ...(exe ? { exe } : {}) };
      if (name === 'process.exited') {
        if (proc.cpuMs !== null && proc.cpuMs !== undefined) data.cpuMs = proc.cpuMs;
        if (proc.peakMemoryBytes !== null && proc.peakMemoryBytes !== undefined) data.peakMemoryMb = Math.round(proc.peakMemoryBytes / 1048576);
        data.exitCode = proc.exitCode;
      }
      // An agent's own commands exit 1 all the time (grep with no match, a failing test): that is work,
      // not a fault. A signal or a Windows status code (above 255, such as 0xC0000005) is a crash.
      const failed = name === 'process.exited' && proc.exitCode !== null && (proc.exitCode < 0 || proc.exitCode > 255);
      this.record(failed ? 'warn' : 'debug', name === 'process.started' ? `Process ${exe ?? 'unknown'} started, pid ${proc.pid}` : `Process ${exe ?? 'unknown'} exited, pid ${proc.pid}, code ${proc.exitCode ?? 'unknown'}`,
        { source: 'processes', event: name, threadId: proc.threadId, turnId, data, ...(name === 'process.exited' && lifetime !== undefined ? { durationMs: lifetime } : {}) },
        (name === 'process.started' ? proc.startedAt : proc.exitedAt) ?? Date.now());
    }
  }

  private observeTurn(name: 'turn.started' | 'turn.finished', turn: RpcEvents['turn.started']): void {
    if (name === 'turn.started') {
      this.activeTurns.set(turn.threadId, { turnId: turn.id, startedAt: turn.startedAt ?? Date.now() });
      const waited = typeof turn.startedAt === 'number' && typeof turn.queuedAt === 'number' ? turn.startedAt - turn.queuedAt : null;
      this.record('info', waited !== null && waited >= 1000 ? `Turn started after ${Math.round(waited / 100) / 10} s in the queue` : 'Turn started',
        { source: 'turns', event: name, threadId: turn.threadId, turnId: turn.id, ...turnAgent(turn), data: { ...(waited !== null ? { queuedMs: waited } : {}), ...(turn.execution?.effort ? { effort: turn.execution.effort } : {}), ...(turn.execution?.accountId ? { accountId: turn.execution.accountId } : {}) } }, turn.startedAt ?? Date.now());
      return;
    }
    const active = this.activeTurns.get(turn.threadId);
    if (active?.turnId === turn.id) this.activeTurns.delete(turn.threadId);
    const started = turn.startedAt ?? active?.startedAt;
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
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.flushing || this.pending.length === 0) return this.writing;
    this.flushing = true;
    // One writer drains a bounded pending buffer, without a per-batch promise chain.
    this.writing = this.writing.then(async () => {
      await this.ready;
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        if (this.failed) break;
        await this.append(batch);
        this.overflowReported = false;
        if (this.dropped > 0) {
          const count = this.dropped;
          this.dropped = 0;
          this.record('warn', `${count} diagnostics were not persisted because the pending buffer was full`, { source: 'logs', event: 'logs.dropped', data: { count } });
        }
      }
    }).catch(error => { this.failed = true; this.pending = []; this.failure(error); }).finally(() => { this.flushing = false; });
    return this.writing;
  }

  private async append(batch: CoreLogRecord[]): Promise<void> {
    let chunk = '';
    let chunkBytes = 0;
    const write = async (): Promise<void> => {
      if (!chunk) return;
      const handle = await open(this.path(0), 'a', 0o600);
      try { await handle.writeFile(chunk); } finally { await handle.close(); }
      this.bytes += chunkBytes; chunk = ''; chunkBytes = 0;
    };
    for (const record of batch) {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > this.fileBytes) continue;
      if (this.bytes + chunkBytes + bytes > this.fileBytes) { await write(); await this.rotate(); }
      chunk += line; chunkBytes += bytes;
    }
    await write();
  }

  private async rotate(): Promise<void> {
    await unlink(this.path(LOG_FILE_COUNT - 1)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    for (let index = LOG_FILE_COUNT - 2; index >= 0; index -= 1) {
      await rename(this.path(index), this.path(index + 1)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    this.bytes = 0;
  }

  async query(raw: CoreLogsQuery): Promise<CoreLogRecord[]> {
    let query: ReturnType<typeof validateCoreLogsQuery>;
    try { query = validateCoreLogsQuery(raw); } catch (error) { throw invalidParams((error as Error).message); }
    return this.select(record => logMatches(record, query), query.limit);
  }

  /**
   * The newest `limit` records a predicate keeps, from every core and shell
   * file and recent memory, newest first. Core files are read newest first and
   * the read stops once an older file cannot change the answer.
   */
  async select(keep: (record: CoreLogRecord) => boolean, limit: number): Promise<CoreLogRecord[]> {
    await this.ready;
    await this.flush();
    let result: CoreLogRecord[] = [];
    const fromMemory = (): CoreLogRecord[] => [...this.recent.values()].filter(keep);
    // Serialize the bounded history read with rotation, so a query cannot miss a renamed file.
    this.writing = this.writing.then(async () => {
      const records = new Map<string, CoreLogRecord>();
      for (const record of fromMemory()) records.set(record.id, record);
      for (let index = 0; index < LOG_FILE_COUNT; index += 1) {
        // A record's time can be earlier than its write (a turn logs when it was queued), so file
        // order says nothing about `at`. A file's modification time does bound what it holds:
        // nothing in it is newer than its last write, give or take a client's allowed clock skew.
        // Once `limit` kept records are all newer than that, this file and older ones cannot enter.
        if (index > 0 && records.size >= limit) {
          const modified = await this.modified(this.path(index));
          if (modified === null) break;
          const limitTh = [...records.values()].map(record => record.at).sort((a, b) => b - a)[limit - 1]!;
          if (limitTh > modified + CLOCK_SKEW_MS) break;
        }
        for (const record of await this.read(this.path(index), 'core', keep)) if (!records.has(record.id)) records.set(record.id, record);
      }
      for (let index = 0; index < SHELL_LOG_FILE_COUNT; index += 1) for (const record of await this.read(this.shellPath(index), 'shell', keep)) records.set(record.id, record);
      result = sortNewest([...records.values()]).slice(0, limit);
    }).catch(error => { this.failure(error); result = sortNewest(fromMemory()).slice(0, limit); });
    await this.writing;
    return result;
  }

  private async modified(path: string): Promise<number | null> {
    try { return (await stat(path)).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  private async read(path: string, origin: LogOrigin, keep: (record: CoreLogRecord) => boolean): Promise<CoreLogRecord[]> {
    let handle;
    try { handle = await open(path, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      const buffer = Buffer.alloc(Math.min((await handle.stat()).size, Math.max(this.fileBytes, LOG_FILE_BYTES)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const records: CoreLogRecord[] = [];
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        // A crash can leave an incomplete final line; other records still answer.
        const parsed = parseLogRecord(line, origin);
        if (parsed === null) continue;
        // Re-redacted with today's secrets: a credential configured after the write is still removed.
        const record: CoreLogRecord = { ...parsed, message: redactLogText(parsed.message, this.secrets) };
        if (parsed.data) { const data = normalizeLogData(parsed.data, this.secrets); if (data) record.data = data; else delete record.data; }
        if (keep(record)) records.push(record);
      }
      return records;
    } finally { await handle.close(); }
  }

  private safeReport(message: string): void { try { this.report(message); } catch { /* Reporting must never interrupt core work. */ } }
  private failure(error: unknown): void { if (this.failureReported) return; this.failureReported = true; this.safeReport(`diagnostic logs unavailable: ${redactLogText(error instanceof Error ? error.message : String(error), this.secrets)}`); }

  async close(): Promise<void> {
    this.unsubscribe?.();
    await this.flush();
    await this.ready;
    this.closed = true;
  }
}

/** The agent frozen for this turn, which a later model switch does not rewrite. */
function turnAgent(turn: RpcEvents['turn.started']): Pick<LogContext, 'providerId' | 'model'> {
  return { ...(turn.execution?.providerId ? { providerId: turn.execution.providerId } : {}), ...(turn.execution?.model ? { model: turn.execution.model } : {}) };
}

function validDuration(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

/** Newest first; records of one instant keep their write order. */
function sortNewest(records: CoreLogRecord[]): CoreLogRecord[] {
  return records.map((record, index) => ({ record, index })).sort((a, b) => b.record.at - a.record.at || b.index - a.index).map(entry => entry.record);
}

/** The program's file name, without its folder: which tool ran, never where the user keeps it. */
export function executableName(exe: string | null | undefined): string | null {
  if (!exe) return null;
  const name = exe.split(/[\\/]/).pop() ?? '';
  return name.length > 0 ? name.slice(0, 80) : null;
}
