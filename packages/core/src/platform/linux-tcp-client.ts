import type { ResourceByteUsage } from '@boite/contracts';
import { unavailableResourceBytes } from '../resource-usage.ts';
import { workerEntry } from '../worker-entry.ts';
import type { LinuxResourceProcess } from './linux-resources.ts';
import type { TcpWorkerCommand, TcpWorkerReply } from './linux-tcp-worker.ts';

export interface TcpWorkerHandle {
  onmessage: ((event: { data: TcpWorkerReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage(message: TcpWorkerCommand): void;
  terminate(): unknown;
}
const nativeWorker = (): TcpWorkerHandle =>
  new Worker(workerEntry(import.meta.url, 'linux-tcp-worker', './platform/linux-tcp-worker.js')) as unknown as TcpWorkerHandle;
type Pending = { id: number; startedAt: number; members: Map<string, LinuxResourceProcess[]>; epochs: Map<string, number> };

/** One demand-owned worker does procfs descriptor walks and native diagnostics off the core loop. */
export class LinuxTcpClient {
  private active = false;
  private worker: TcpWorkerHandle | null = null;
  private pending: Pending | null = null;
  private sequence = 0;
  private failures = 0;
  private retryAt = 0;
  private readonly epochs = new Map<string, number>();
  private readonly latest = new Map<string, { members: LinuxResourceProcess[]; usage: ResourceByteUsage }>();
  private readonly stopping = new Set<Promise<void>>();

  constructor(private readonly create: () => TcpWorkerHandle = nativeWorker, private readonly now: () => number = Date.now) {}

  watch(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.pending = null; this.latest.clear(); this.epochs.clear();
    this.failures = 0; this.retryAt = 0;
    if (!active) this.detach();
  }

  forget(threadId: string): void {
    this.epochs.set(threadId, (this.epochs.get(threadId) ?? 0) + 1);
    this.latest.delete(threadId);
    try { this.worker?.postMessage({ kind: 'forget', threadId }); } catch { this.fail(); }
  }

  sample(threadId: string, members: LinuxResourceProcess[]): ResourceByteUsage {
    const result = this.latest.get(threadId);
    // A result for a previous execution or changed topology cannot update this execution.
    if (result !== undefined && this.sameMembers(result.members, members)) return result.usage;
    return unavailableResourceBytes('No current observed TCP payload sample');
  }

  finish(members: Map<string, LinuxResourceProcess[]>): void {
    if (this.active && this.pending !== null && this.now() - this.pending.startedAt >= 2000) this.fail();
    if (!this.active || this.pending !== null || members.size === 0 || this.now() < this.retryAt || this.stopping.size > 0) return;
    const bounded = new Map<string, LinuxResourceProcess[]>();
    let count = 0;
    for (const [threadId, processes] of members) {
      count += processes.length;
      if (count > 1024 || bounded.size >= 1024) { this.latest.clear(); return; }
      bounded.set(threadId, processes.map(member => ({ ...member })));
    }
    if (this.worker === null) {
      try { this.worker = this.create(); } catch { this.fail(); return; }
      const running = this.worker;
      running.onmessage = event => { if (this.worker === running) this.receive(event.data); };
      running.onerror = () => { if (this.worker === running) this.fail(); };
    }
    const id = ++this.sequence;
    this.pending = { id, startedAt: this.now(), members: bounded, epochs: new Map(this.epochs) };
    try { this.worker.postMessage({ kind: 'sample', id, members: [...bounded] }); }
    catch { this.fail(); }
  }

  private receive(reply: TcpWorkerReply): void {
    const pending = this.pending;
    if (reply.kind !== 'sample' || pending === null || reply.id !== pending.id || !this.active) return;
    this.pending = null;
    this.failures = 0; this.retryAt = 0;
    for (const [threadId, usage] of reply.samples) {
      const members = pending.members.get(threadId);
      if (members === undefined || (pending.epochs.get(threadId) ?? 0) !== (this.epochs.get(threadId) ?? 0)) continue;
      this.latest.set(threadId, { members, usage });
    }
  }

  private sameMembers(left: LinuxResourceProcess[], right: LinuxResourceProcess[]): boolean {
    return left.length === right.length && left.every((member, index) =>
      member.pid === right[index]?.pid && member.birth === right[index]?.birth);
  }

  private fail(): void {
    this.pending = null; this.latest.clear();
    // Transport failure does not end the visible lease. Retry on the shared
    // detail tick with bounded backoff, never through a new recovery poller.
    this.retryAt = this.now() + Math.min(30_000, 1000 * 2 ** this.failures);
    this.failures = Math.min(5, this.failures + 1);
    this.detach();
  }

  private detach(): void {
    if (this.worker === null) return;
    const running = this.worker; this.worker = null;
    const done = this.stop(running);
    this.stopping.add(done); void done.finally(() => this.stopping.delete(done));
  }

  private stop(running: TcpWorkerHandle): Promise<void> {
    return new Promise(resolve => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true; clearTimeout(timeout); running.terminate(); resolve();
      };
      const timeout = setTimeout(finish, 150);
      running.onmessage = event => { if (event.data.kind === 'stopped') finish(); };
      running.onerror = finish;
      try { running.postMessage({ kind: 'stop' }); } catch { finish(); }
    });
  }

  async closed(): Promise<void> { this.watch(false); await Promise.all(this.stopping); }
}
