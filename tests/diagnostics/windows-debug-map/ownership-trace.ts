import {appendFileSync, mkdirSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {threadId} from 'node:worker_threads';
import {dlopen, FFIType, ptr} from 'bun:ffi';
import type {Pointer} from 'bun:ffi';
import {OwnershipLedger, type HandleIdentity, type TraceEvent, type Transfer, type OwnedHandle} from './ownership-ledger.ts';

/** Pass each compiler's trace selection directly; worker environment inheritance is not evidence. */
export function ownershipWorkerOptions(): {argv: string[]} {
  const directory = process.env.BOITE_DEBUG_MAP_TRACE, role = process.env.BOITE_DEBUG_MAP_OWNER;
  if (!directory || !isAbsolute(directory) || !['launcher', 'harness'].includes(role ?? ''))
    throw new Error('ownership worker requires an absolute trace directory and launcher/harness owner');
  return {argv: ['--boite-debug-map-trace', directory, '--boite-debug-map-owner', role!]};
}
function workerConfiguration(): {directory: string; role: string} | undefined {
  if (threadId === 0) return;
  const read = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    if (index < 0) return;
    if (process.argv.lastIndexOf(flag) !== index || !process.argv[index + 1]) throw new Error(`invalid ownership worker argument: ${flag}`);
    return process.argv[index + 1];
  };
  const directory = read('--boite-debug-map-trace'), role = read('--boite-debug-map-owner');
  if (directory === undefined && role === undefined) return;
  if (!directory || !isAbsolute(directory) || !['launcher', 'harness'].includes(role ?? ''))
    throw new Error('invalid ownership worker trace directory or owner');
  return {directory, role: role!};
}

export interface OwnershipReads {
  save(): number;
  restore(error: number): void;
  read(handle: number): HandleIdentity;
  thread?(): number;
}
function nativeReads(): OwnershipReads | null {
  if (process.platform !== 'win32') return null;
  const {symbols} = dlopen('kernel32.dll', {
    GetLastError: {args: [], returns: FFIType.u32},
    GetCurrentThreadId: {args: [], returns: FFIType.u32},
    SetLastError: {args: [FFIType.u32], returns: FFIType.void},
    GetProcessId: {args: [FFIType.ptr], returns: FFIType.u32},
    GetProcessTimes: {args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
    GetExitCodeProcess: {args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
  });
  return {
    save: () => symbols.GetLastError(), restore: (error: number) => symbols.SetLastError(error),
    thread: () => symbols.GetCurrentThreadId(),
    read(handle: number): HandleIdentity {
      const held = handle as unknown as Pointer, times = new Uint8Array(32), exit = new Uint32Array(1);
      const pid = symbols.GetProcessId(held) || null;
      const timed = symbols.GetProcessTimes(held, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24)) !== 0;
      const exited = symbols.GetExitCodeProcess(held, ptr(exit)) !== 0;
      const created = timed ? new DataView(times.buffer).getBigUint64(0, true) : 0n;
      return {pid, incarnation: created ? created.toString() : null, exitCode: exited ? exit[0]! : null};
    },
  };
}

/** File writes and native observations preserve the original thread's last error. */
export class OwnershipTrace {
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline = 0;
  private file: string | undefined;
  private sequence = 0;
  private ledger: OwnershipLedger;
  private closeResults = new Map<string, {id: string; success: boolean; error: number; wallMs: number}>();
  readonly owner = `${process.pid}/${threadId}/${crypto.randomUUID()}`;
  constructor(readonly role: string, private native: OwnershipReads | null = nativeReads(), directory = process.env.BOITE_DEBUG_MAP_TRACE) {
    this.ledger = new OwnershipLedger(this.owner, event => this.write(event));
    if (directory) this.start(directory);
  }
  private guarded<T>(action: () => T): T | undefined {
    const error = this.native?.save();
    try {return action();}
    catch (cause) {
      this.ledger.complete = false;
      try {process.stderr.write(`ownership-trace incomplete owner=${this.owner} error=${String(cause)}\n`);} catch {}
    } finally {if (error !== undefined) this.native?.restore(error);}
  }
  private write(event: TraceEvent): void {
    if (!this.file) return;
    appendFileSync(this.file, JSON.stringify({owner: this.owner, ownerPid: process.pid, ownerThread: threadId,
      ownerNativeThread: this.native?.thread?.() ?? null,
      role: this.role, seq: ++this.sequence, monoNs: process.hrtime.bigint().toString(), wallMs: Date.now(), ...event}) + '\n');
  }
  start(directory: string): void {
    this.guarded(() => {
      this.stop(); mkdirSync(directory, {recursive: true});
      this.file = join(directory, `${this.role}-${process.pid}-${threadId}-${crypto.randomUUID()}.jsonl`);
      this.ledger = new OwnershipLedger(this.owner, event => this.write(event));
      this.write({event: 'owner-start'}); this.deadline = Date.now() + 180000;
      this.timer = setInterval(() => this.guarded(() => {
        if (Date.now() > this.deadline) {
          clearInterval(this.timer); this.timer = undefined;
          this.ledger.incomplete('bounded snapshot deadline reached'); return;
        }
        this.ledger.snapshot(handle => this.read(handle));
      }), 250);
      this.timer.unref();
    });
  }
  private read(handle: number): HandleIdentity {
    return this.native?.read(handle) ?? {pid: null, incarnation: null, exitCode: null};
  }
  event(event: TraceEvent): void {this.guarded(() => this.write(event));}
  acquired(handle: number, pid: number): void {
    this.guarded(() => {
      const valid = Number.isSafeInteger(handle) && handle > 0;
      if (handle !== 0 && !valid) this.ledger.incomplete('undecodable acquired handle', {handle, pid});
      this.ledger.acquire(handle, pid, valid ? this.read(handle) : {pid: null, incarnation: null, exitCode: null});
    });
  }
  sent(message: {kind: string; handle?: number}): Transfer | undefined {
    return this.guarded(() => message.kind === 'packet' && message.handle
      ? this.ledger.transfer(message.handle) : undefined);
  }
  received(message: {kind: string; handle?: number; pid?: number; ownershipTrace?: Transfer}): void {
    this.guarded(() => {
      this.write({event: 'packet-receive', message});
      if (message.kind !== 'packet' || !message.handle) return;
      if (!Number.isSafeInteger(message.handle) || message.handle <= 0) {
        this.ledger.incomplete('undecodable transferred handle', {message}); return;
      }
      if (!message.ownershipTrace) this.ledger.incomplete('worker transfer provenance missing', {message});
      this.ledger.acquire(message.handle, message.pid ?? 0, this.read(message.handle), message.ownershipTrace);
    });
  }
  stage(handle: number, stage: string, fields: Record<string, unknown> = {}): void {
    this.guarded(() => this.ledger.stage(handle, stage, fields));
  }
  closed(handle: number, success: boolean, error: number): void {
    this.guarded(() => {
      const entry = this.ledger.owned.get(handle);
      this.ledger.close(handle, success, error);
      if (entry) this.closeResults.set(entry.id, {id: entry.id, success, error, wallMs: Date.now()});
    });
  }
  preserve<T>(action: () => T): T {
    const saved = this.native?.save();
    try {return action();} finally {if (saved !== undefined) this.native?.restore(saved);}
  }
  reference(handle: number): {entry: OwnedHandle; identity: HandleIdentity; complete: boolean} | undefined {
    return this.guarded(() => {
      const entry = this.ledger.owned.get(handle);
      if (!entry || entry.closeFailed) return;
      return {entry: {...entry}, identity: this.read(handle), complete: this.ledger.complete};
    });
  }
  closeResult(id: string) {return this.closeResults.get(id);}
  stop(): void {
    this.guarded(() => {
      if (this.timer) clearInterval(this.timer); this.timer = undefined;
      if (this.file) {
        this.ledger.snapshot(handle => this.read(handle));
        this.write({event: 'owner-stop', complete: this.ledger.complete, retained: [...this.ledger.owned.values()]});
      }
      this.file = undefined;
    });
  }
}

// Imported only by opt-in generated modules, before their first original call.
const workerConfig = workerConfiguration();
export const ownershipTrace = new OwnershipTrace(`${workerConfig?.role ?? process.env.BOITE_DEBUG_MAP_OWNER ?? 'unknown'}-${threadId === 0 ? 'main' : 'worker'}`,
  undefined, workerConfig?.directory ?? process.env.BOITE_DEBUG_MAP_TRACE);
if (workerConfig) ownershipTrace.event({event: 'worker-configuration', transport: 'argv', directory: workerConfig.directory});
process.once('exit', () => ownershipTrace.stop());
