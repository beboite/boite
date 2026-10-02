import type { AgentResourceSnapshot, ResourceByteUsage, ThreadId, ThreadLoad, ThreadSummary } from '@boite/contracts';
import type { ProcessPlatform, ProcessSample } from './platform/types.ts';

export const RESOURCE_WATCH_MS = 6000;

/** Detailed OS counters are collected only while at least one visible client asks. */
export class ResourceWatches {
  private readonly leases = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  set(connectionId: string, watch: boolean | undefined): void {
    if (watch === true) this.leases.set(connectionId, this.now() + RESOURCE_WATCH_MS);
    else if (watch === false) this.leases.delete(connectionId);
  }

  remove(connectionId: string): void { this.leases.delete(connectionId); }

  active(): boolean {
    const now = this.now();
    for (const [id, until] of this.leases) if (until <= now) this.leases.delete(id);
    return this.leases.size > 0;
  }

  clear(): void { this.leases.clear(); }
}

export function unavailableResourceBytes(note = 'No supported per-agent counter'): ResourceByteUsage {
  return { readBytes: null, writeBytes: null, readBytesPerSecond: null, writeBytesPerSecond: null,
    sampledAt: null, since: null, coverage: 'unavailable', source: 'unavailable', note };
}

/** A safe projection of thread identity and current measurements for phones. */
export function resourceSnapshot(
  sampledAt: number,
  live: ThreadId[],
  threadOf: (threadId: ThreadId) => ThreadSummary | null,
  loadOf: (threadId: ThreadId) => ThreadLoad | null,
  details: ReadonlyMap<ThreadId, { disk: ResourceByteUsage; network: ResourceByteUsage }>,
  availability: ReadonlyMap<ThreadId, { cpu: boolean; memory: boolean }>,
): AgentResourceSnapshot {
  return { sampledAt, agents: live.flatMap(threadId => {
    const thread = threadOf(threadId);
    if (thread === null) return [];
    const load = loadOf(threadId) ?? { processes: 0, cpuPercent: 0, memoryBytes: 0 };
    const measured = details.get(threadId);
    return [{ threadId, title: thread.title, providerId: thread.providerId, model: thread.model,
      status: thread.status, projectId: thread.projectId, parentThreadId: thread.parentThreadId ?? null,
      load, loadAvailable: availability.get(threadId) ?? { cpu: false, memory: false },
      disk: measured?.disk ?? unavailableResourceBytes('No current per-agent storage sample'),
      network: measured?.network ?? unavailableResourceBytes('No current per-agent network sample') }];
  }) };
}

/** Connection demand and measured DTO state remain separate from process ownership. */
export class ResourceCollection {
  private readonly watches = new ResourceWatches();
  private readonly details = new Map<ThreadId, { disk: ResourceByteUsage; network: ResourceByteUsage }>();
  private readonly availability = new Map<ThreadId, { cpu: boolean; memory: boolean }>();
  active = false;
  sampledAt = Date.now();

  constructor(private readonly platform: ProcessPlatform) {}

  watch(connectionId: string, watch: boolean | undefined): void { this.watches.set(connectionId, watch); this.sync(); }
  unwatch(connectionId: string): void { this.watches.remove(connectionId); this.sync(); }

  sync(): void {
    const active = this.watches.active();
    if (active === this.active) return;
    this.active = active;
    this.details.clear();
    this.platform.watchResources?.(active);
  }

  sample(threadId: ThreadId, sample: ProcessSample | null): void {
    this.availability.set(threadId, {
      cpu: sample !== null && (sample.cpuMeasured ?? this.platform.capability().os !== 'macos'),
      memory: sample !== null && (sample.memoryMeasured ?? true),
    });
    if (this.active && sample?.resources) this.details.set(threadId, sample.resources);
    else this.details.delete(threadId);
  }

  snapshot(live: ThreadId[], threadOf: (threadId: ThreadId) => ThreadSummary | null, loadOf: (threadId: ThreadId) => ThreadLoad | null): AgentResourceSnapshot {
    return resourceSnapshot(this.sampledAt, live, threadOf, loadOf, this.details, this.availability);
  }

  forget(threadId: ThreadId): void { this.details.delete(threadId); this.availability.delete(threadId); }
  close(): void { this.watches.clear(); this.sync(); }
}

export interface ByteCounter { identity: string; readBytes: number; writeBytes: number }

/** Totals describe only observed deltas, never unobserved execution lifetime. */
export class ObservedBytes {
  private previous = new Map<string, ByteCounter>();
  private at: number | null = null;
  private since: number | null = null;
  private readBytes = 0;
  private writeBytes = 0;

  sample(counters: ByteCounter[], at: number, source: ResourceByteUsage['source'], note: string): ResourceByteUsage {
    const elapsed = this.at === null ? 0 : at - this.at;
    let read = 0;
    let write = 0;
    const next = new Map<string, ByteCounter>();
    for (const counter of counters) {
      // One socket or task appears once even when multiple descriptors reference it.
      if (next.has(counter.identity)) continue;
      next.set(counter.identity, counter);
      const before = this.previous.get(counter.identity);
      if (before === undefined || elapsed <= 0) continue;
      if (counter.readBytes >= before.readBytes) read += counter.readBytes - before.readBytes;
      if (counter.writeBytes >= before.writeBytes) write += counter.writeBytes - before.writeBytes;
    }
    this.previous = next;
    this.since ??= at;
    this.at = at;
    this.readBytes += read;
    this.writeBytes += write;
    return { readBytes: this.readBytes, writeBytes: this.writeBytes,
      readBytesPerSecond: elapsed > 0 ? read * 1000 / elapsed : null,
      writeBytesPerSecond: elapsed > 0 ? write * 1000 / elapsed : null,
      sampledAt: at, since: this.since, coverage: 'partial', source, note };
  }
}
