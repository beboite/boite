import { readlinkSync } from 'node:fs';
import type { ResourceByteUsage } from '@boite/contracts';
import { ObservedBytes, unavailableResourceBytes, type ByteCounter } from '../resource-usage.ts';
import type { ProcRead } from './linux-load.ts';
import type { LinuxResourceProcess } from './linux-resources.ts';
import type { TcpDiagnostics } from './linux-netlink.ts';

type ProcLink = (path: string) => string | null;
type LoadDiagnostics = () => Promise<TcpDiagnostics>;
interface SocketBinding { pid: number; birth: number; fd: string }
interface Ownership { owners: Set<string>; bindings: SocketBinding[] }
interface OwnedSockets { sockets: Map<number, Ownership>; readable: Set<string>; namespace: string }
const MAX_PROCESSES = 1024;
const MAX_FDS = 8192;
const MAX_WALK_MS = 20;

function link(path: string): string | null {
  try { return readlinkSync(path); } catch { return null; }
}

function birthOf(stat: string | null): number | null {
  if (stat === null || stat.lastIndexOf(')') < 0) return null;
  const birth = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  return Number.isSafeInteger(birth) && birth >= 0 ? birth : null;
}

/** Joins kernel socket counters only to exact, currently held agent descriptors. */
export class LinuxTcp {
  private enabled = false;
  private generation = 0;
  private pending: number | null = null;
  private reader: TcpDiagnostics | null = null;
  private readonly bytes = new Map<string, ObservedBytes>();
  private readonly latest = new Map<string, ResourceByteUsage>();
  private readonly epochs = new Map<string, number>();

  constructor(
    private readonly read: ProcRead,
    private readonly readLink: ProcLink = link,
    private readonly now: () => number = Date.now,
    private readonly load: LoadDiagnostics = async () => (await import('./linux-netlink.ts')).createTcpDiagnostics(),
  ) {}

  watch(active: boolean): void {
    if (active === this.enabled) return;
    this.enabled = active;
    this.generation += 1;
    this.pending = null;
    this.bytes.clear(); this.latest.clear(); this.epochs.clear();
    this.reader?.close(); this.reader = null;
  }

  forget(threadId: string): void {
    this.epochs.set(threadId, (this.epochs.get(threadId) ?? 0) + 1);
    this.bytes.delete(threadId); this.latest.delete(threadId);
  }

  sample(threadId: string): ResourceByteUsage {
    return this.latest.get(threadId) ?? unavailableResourceBytes('No current observed TCP payload sample');
  }

  private ownership(members: Map<string, LinuxResourceProcess[]>): OwnedSockets | null {
    const namespace = this.readLink('/proc/self/ns/net');
    if (namespace === null) return null;
    const sockets = new Map<number, Ownership>();
    const readable = new Set<string>();
    const deadline = performance.now() + MAX_WALK_MS;
    let processes = 0;
    let descriptors = 0;
    for (const [threadId, processesOfThread] of members) for (const member of processesOfThread) {
      if (++processes > MAX_PROCESSES || performance.now() >= deadline) return null;
      if (this.readLink(`/proc/${member.pid}/ns/net`) !== namespace || birthOf(this.read(`/proc/${member.pid}/stat`)) !== member.birth) continue;
      const directory = this.read(`/proc/${member.pid}/fd`);
      if (directory === null) continue;
      const bindings: [number, SocketBinding][] = [];
      for (const fd of directory.split(/\s+/).filter(value => /^\d+$/.test(value))) {
        if (++descriptors > MAX_FDS || performance.now() >= deadline) return null;
        const match = /^socket:\[(\d+)\]$/.exec(this.readLink(`/proc/${member.pid}/fd/${fd}`) ?? '');
        if (match === null) continue;
        const inode = Number(match[1]);
        if (Number.isSafeInteger(inode)) bindings.push([inode, { ...member, fd }]);
      }
      if (birthOf(this.read(`/proc/${member.pid}/stat`)) !== member.birth) continue;
      readable.add(threadId);
      for (const [inode, binding] of bindings) {
        let owned = sockets.get(inode);
        if (owned === undefined) { owned = { owners: new Set(), bindings: [] }; sockets.set(inode, owned); }
        owned.owners.add(threadId); owned.bindings.push(binding);
      }
    }
    return { sockets, readable, namespace };
  }

  private stillHeld(inode: number, owned: Ownership, namespace: string): boolean {
    return owned.bindings.some(binding => birthOf(this.read(`/proc/${binding.pid}/stat`)) === binding.birth
      && this.readLink(`/proc/${binding.pid}/ns/net`) === namespace
      && this.readLink(`/proc/${binding.pid}/fd/${binding.fd}`) === `socket:[${inode}]`);
  }

  /** One bounded namespace snapshot follows the shared protection sample, never each RPC. */
  finish(members: Map<string, LinuxResourceProcess[]>): Promise<void> {
    if (!this.enabled || this.pending !== null || members.size === 0) return Promise.resolve();
    const generation = this.generation;
    this.pending = generation;
    return this.collect(members, generation, new Map(this.epochs)).catch(() => {
      if (this.enabled && this.generation === generation) this.unavailable(members);
    }).finally(() => { if (this.pending === generation) this.pending = null; });
  }

  private unavailable(members: Map<string, LinuxResourceProcess[]>): void {
    // A failed snapshot hides readings; the next stable socket counter spans the gap.
    for (const threadId of members.keys()) {
      this.latest.set(threadId, unavailableResourceBytes('Per-agent TCP diagnostics unavailable or bounded work exceeded'));
    }
  }

  private async collect(members: Map<string, LinuxResourceProcess[]>, generation: number, epochs: Map<string, number>): Promise<void> {
    if (this.reader === null) {
      const reader = await this.load();
      if (!this.enabled || this.generation !== generation) { reader.close(); return; }
      this.reader = reader;
    }
    const owned = this.ownership(members);
    if (owned === null) { this.unavailable(members); return; }
    const counters = await this.reader.dump();
    if (!this.enabled || this.generation !== generation) return;
    if (counters === null) { this.unavailable(members); return; }
    const byThread = new Map<string, ByteCounter[]>();
    const deadline = performance.now() + MAX_WALK_MS;
    for (const counter of counters) {
      if (performance.now() >= deadline) { this.unavailable(members); return; }
      const socket = owned.sockets.get(counter.inode);
      if (socket === undefined || socket.owners.size !== 1 || !this.stillHeld(counter.inode, socket, owned.namespace)) continue;
      const threadId = [...socket.owners][0]!;
      const list = byThread.get(threadId) ?? [];
      list.push({ identity: `${owned.namespace}:${counter.cookie}`, readBytes: counter.readBytes, writeBytes: counter.writeBytes });
      byThread.set(threadId, list);
    }
    const at = this.now();
    for (const threadId of members.keys()) {
      if ((epochs.get(threadId) ?? 0) !== (this.epochs.get(threadId) ?? 0)) continue;
      if (!owned.readable.has(threadId)) { this.forget(threadId); continue; }
      let bytes = this.bytes.get(threadId);
      if (bytes === undefined) { bytes = new ObservedBytes(); this.bytes.set(threadId, bytes); }
      this.latest.set(threadId, bytes.sample(byThread.get(threadId) ?? [], at, 'linux-tcp-info',
        'Observed TCP payload, including loopback, on uniquely owned sockets; UDP, short connections and protocol overhead are excluded'));
    }
  }
}
