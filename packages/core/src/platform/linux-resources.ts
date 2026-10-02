import type { ResourceByteUsage } from '@boite/contracts';
import { ObservedBytes, unavailableResourceBytes, type ByteCounter } from '../resource-usage.ts';
import type { ProcRead } from './linux-load.ts';
import { LinuxTcpClient } from './linux-tcp-client.ts';

export interface LinuxResourceProcess { pid: number; birth: number }

export function storageBytes(text: string | null): { readBytes: number; writeBytes: number } | null {
  const read = /^read_bytes:\s+(\d+)$/m.exec(text ?? '');
  const write = /^write_bytes:\s+(\d+)$/m.exec(text ?? '');
  if (read === null || write === null) return null;
  const readBytes = Number(read[1]);
  const writeBytes = Number(write[1]);
  return Number.isSafeInteger(readBytes) && Number.isSafeInteger(writeBytes) ? { readBytes, writeBytes } : null;
}

function birthOf(stat: string | null): number | null {
  if (stat === null || stat.lastIndexOf(')') < 0) return null;
  const birth = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  return Number.isSafeInteger(birth) && birth >= 0 ? birth : null;
}

/** Task-specific IO avoids counting a child's counters again when its parent waits. */
export class LinuxResources {
  private readonly disk = new Map<string, ObservedBytes>();
  private enabled = false;
  private readonly members = new Map<string, LinuxResourceProcess[]>();
  private readonly network: LinuxTcpClient;

  constructor(private readonly read: ProcRead, private readonly now: () => number = Date.now) { this.network = new LinuxTcpClient(); }

  watch(active: boolean): void {
    if (this.enabled === active) return;
    this.enabled = active;
    this.disk.clear();
    this.members.clear();
    this.network.watch(active);
  }

  forget(threadId: string): void { this.disk.delete(threadId); this.members.delete(threadId); this.network.forget(threadId); }

  finish(): void { if (this.enabled) this.network.finish(new Map(this.members)); }

  async close(): Promise<void> { this.watch(false); await this.network.closed(); }

  sample(threadId: string, members: LinuxResourceProcess[]): { disk: ResourceByteUsage; network: ResourceByteUsage } | undefined {
    if (!this.enabled) return undefined;
    this.members.set(threadId, members.slice(0, 512));
    const counters: ByteCounter[] = [];
    let seen = 0;
    // Bound extra work independently of the memory protection scan.
    for (const member of members.slice(0, 512)) {
      if (birthOf(this.read(`/proc/${member.pid}/stat`)) !== member.birth) continue;
      const tasks = (this.read(`/proc/${member.pid}/task`) ?? '').split(/\s+/).filter(tid => /^\d+$/.test(tid));
      for (const tid of tasks) {
        if (++seen > 2048) break;
        const base = `/proc/${member.pid}/task/${tid}`;
        const birth = birthOf(this.read(`${base}/stat`));
        if (birth === null) continue;
        const bytes = storageBytes(this.read(`${base}/io`));
        if (bytes === null || birthOf(this.read(`${base}/stat`)) !== birth) continue;
        counters.push({ identity: `${member.pid}:${member.birth}:${tid}:${birth}`, ...bytes });
      }
      if (seen > 2048) break;
    }
    if (counters.length === 0) {
      this.disk.delete(threadId);
      return { disk: unavailableResourceBytes('Process storage counters unavailable'), network: this.network.sample(threadId, members) };
    }
    let disk = this.disk.get(threadId);
    if (disk === undefined) { disk = new ObservedBytes(); this.disk.set(threadId, disk); }
    return {
      disk: disk.sample(counters, this.now(), 'linux-proc-io', 'Observed task storage reads and page-dirtying writes; short-lived tasks and final exits may be missed'),
      network: this.network.sample(threadId, members),
    };
  }
}
