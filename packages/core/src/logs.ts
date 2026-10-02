import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeCoreLogOutput, normalizeCoreLogText as redactLogText, validateCoreLogsQuery, type CoreLogLevel, type CoreLogRecord, type CoreLogsQuery, type RpcEventName, type RpcEvents } from '@boite/contracts';
import type { Bus, EventPayload } from './bus.ts';
import { invalidParams } from './errors.ts';

export const LOG_FILE_BYTES = 1024 * 1024;
export const LOG_FILE_COUNT = 4;
export const LOG_MESSAGE_CHARS = 4096;
const CONTEXT_CHARS = 200;
const PENDING_RECORDS = 256;
const RECENT_RECORDS = 4096;
const FLUSH_MS = 250;

/** Only explicit diagnostic metadata can cross this boundary. Never pass a payload. */
export type LogContext = Pick<CoreLogRecord, 'source' | 'event' | 'threadId' | 'turnId' | 'requestId'>;

export { normalizeCoreLogText as redactLogText } from '@boite/contracts';

/** Persistent diagnostics are separate from the transactional operational journal. */
export class DiagnosticLogs {
  readonly runId = crypto.randomUUID();
  readonly directory: string;
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
  private readonly activeTurns = new Map<string, string>();
  private readonly processTurns = new Map<string, string>();

  constructor(dataDir: string, private readonly secrets: readonly string[] = [], private readonly report: (message: string) => void = message => console.error(message), private readonly fileBytes = LOG_FILE_BYTES) {
    this.directory = join(dataDir, 'logs');
    // Startup performs only bounded metadata operations. History is read on demand.
    this.ready = this.initialize().catch(error => { this.failed = true; this.failure(error); });
  }

  private path(index: number): string { return join(this.directory, `core.${index}.ndjson`); }

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
    return { level: payload.level, at: payload.at, message: payload.kind === 'provider-output' ? normalizeCoreLogOutput(payload.message, this.secrets) : redactLogText(payload.message, this.secrets), ...context,
      ...(payload.kind === 'provider-output' ? { kind: payload.kind } : {}) };
  }

  private context(raw: Partial<LogContext>): LogContext {
    const bounded = (value: string): string => redactLogText(value, this.secrets).replace(/[\r\n\t]/g, ' ').slice(0, CONTEXT_CHARS);
    return {
      source: bounded(raw.source ?? 'core'), event: bounded(raw.event ?? 'core.log'),
      ...(typeof raw.threadId === 'string' ? { threadId: bounded(raw.threadId) } : {}),
      ...(typeof raw.turnId === 'string' ? { turnId: bounded(raw.turnId) } : {}),
      ...(typeof raw.requestId === 'string' ? { requestId: bounded(raw.requestId) } : {}),
    };
  }

  record(level: CoreLogLevel, message: string, context: Partial<LogContext> = {}, at = Date.now()): void {
    if (this.closed) return;
    const record: CoreLogRecord = {
      id: `${this.runId}:${++this.sequence}`, runId: this.runId, at, level,
      ...this.context(context), message: redactLogText(message, this.secrets),
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
      const turn = payload as RpcEvents['turn.started'];
      if (name === 'turn.started') this.activeTurns.set(turn.threadId, turn.id);
      else if (this.activeTurns.get(turn.threadId) === turn.id) this.activeTurns.delete(turn.threadId);
      this.record(turn.status === 'error' ? 'error' : 'info', name === 'turn.started' ? 'Turn started' : `Turn finished: ${turn.status}`, { source: 'turns', event: name, threadId: turn.threadId, turnId: turn.id }, (name === 'turn.started' ? turn.startedAt : turn.finishedAt) ?? Date.now());
    } else if (name === 'process.started' || name === 'process.exited') {
      const proc = payload as RpcEvents['process.started'];
      const key = `${proc.threadId}:${proc.pid}`;
      const turnId = this.processTurns.get(key) ?? this.activeTurns.get(proc.threadId);
      if (name === 'process.started' && turnId !== undefined) this.processTurns.set(key, turnId);
      if (name === 'process.exited') this.processTurns.delete(key);
      this.record(name === 'process.exited' && proc.exitCode !== null && proc.exitCode !== 0 ? 'warn' : 'info', name === 'process.started' ? `Process started: pid ${proc.pid}` : `Process exited: pid ${proc.pid}, code ${proc.exitCode ?? 'unknown'}`, { source: 'processes', event: name, threadId: proc.threadId, turnId }, (name === 'process.started' ? proc.startedAt : proc.exitedAt) ?? Date.now());
    }
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
          this.record('warn', `${count} diagnostics were not persisted because the pending buffer was full`, { source: 'logs', event: 'logs.dropped' });
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
    await this.ready;
    await this.flush();
    // Serialize the bounded history read with rotation, so a query cannot miss a renamed file.
    let result: CoreLogRecord[] = [];
    this.writing = this.writing.then(async () => {
      const records = new Map<string, CoreLogRecord>();
      for (let index = LOG_FILE_COUNT - 1; index >= 0; index -= 1) {
        for (const record of await this.read(index)) records.set(record.id, record);
      }
      for (const record of this.recent.values()) { records.delete(record.id); records.set(record.id, record); }
      result = [...records.values()].reverse().filter(record => (query.threadId === undefined || record.threadId === query.threadId) && (query.level === undefined || record.level === query.level)).slice(0, query.limit);
    }).catch(error => { this.failure(error); result = [...this.recent.values()].reverse().filter(record => (query.threadId === undefined || record.threadId === query.threadId) && (query.level === undefined || record.level === query.level)).slice(0, query.limit); });
    await this.writing;
    return result;
  }

  private async read(index: number): Promise<CoreLogRecord[]> {
    let handle;
    try { handle = await open(this.path(index), 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      const buffer = Buffer.alloc(Math.min((await handle.stat()).size, this.fileBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const records: CoreLogRecord[] = [];
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        try {
          const raw = JSON.parse(line) as CoreLogRecord;
          if (!raw || typeof raw.id !== 'string' || typeof raw.runId !== 'string' || typeof raw.at !== 'number' || !Number.isFinite(raw.at) || !['info', 'warn', 'error'].includes(raw.level) || typeof raw.message !== 'string' || typeof raw.source !== 'string' || typeof raw.event !== 'string') continue;
          records.push({ id: raw.id.slice(0, CONTEXT_CHARS), runId: raw.runId.slice(0, CONTEXT_CHARS), at: raw.at, level: raw.level, message: redactLogText(raw.message, this.secrets), ...this.context(raw) });
        } catch { /* A crash can leave an incomplete final line; other records still answer. */ }
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
