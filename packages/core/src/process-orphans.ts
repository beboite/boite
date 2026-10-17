import type { ProcessRecord } from '@boite/contracts';
import type { ProcessIdentity } from './process-identity.ts';

interface Traced {
  record: ProcessRecord;
  identity: ProcessIdentity;
}

/**
 * What a thread left running with nobody above it, by pid: a process whose
 * parent exited, or whose parent pid now names a younger process, past the
 * grace, with everything under it. A parent missing from the registry is
 * looked up in the system (`runningSince`), and one found running there keeps
 * its child. Whatever the core spawned has the core as its parent and is never taken.
 */
export function orphansOf<T extends Traced>(byPid: ReadonlyMap<number, T>, now: number, graceMs: number, runningSince: (pid: number) => number | null): Map<number, T> {
  const entries = [...byPid.values()];
  const stopping = new Map<number, T>();
  for (const entry of entries) {
    const { record } = entry;
    const parentPid = record.parentPid;
    if (parentPid === null || parentPid === process.pid) continue;
    if (now - nativeBirth(entry) < graceMs) continue;
    const parent = byPid.get(parentPid);
    if (parent !== undefined && !bornAfter(parent, entry)) continue;
    // The registry is a copy, and a missed event leaves it short of a parent.
    // A millisecond lookup must not override a captured newer incarnation.
    if (parent === undefined || parent.identity.startedAt === null || entry.identity.startedAt === null) {
      const running = runningSince(parentPid);
      if (running !== null && running <= nativeBirth(entry)) continue;
    }
    stopping.set(record.pid, entry);
  }
  if (stopping.size === 0) return stopping;
  // An orphan's own children still have a live parent: they go with it. One
  // index by parent, then one walk down, so a deep tree costs its size.
  const children = new Map<number, T[]>();
  for (const entry of entries) {
    const { record } = entry;
    if (record.parentPid === null) continue;
    const siblings = children.get(record.parentPid);
    if (siblings === undefined) children.set(record.parentPid, [entry]);
    else siblings.push(entry);
  }
  const pending = [...stopping.values()];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent.record.pid) ?? []) {
      if (stopping.has(child.record.pid) || bornAfter(parent, child)) continue;
      stopping.set(child.record.pid, child);
      pending.push(child);
    }
  }
  return stopping;
}

function nativeBirth(entry: Traced): number {
  return entry.identity.startedAt ?? entry.record.startedAt;
}

function bornAfter(parent: Traced, child: Traced): boolean {
  if (parent.identity.incarnation !== null && child.identity.incarnation !== null) {
    try { return BigInt(parent.identity.incarnation) > BigInt(child.identity.incarnation); }
    catch { /* A platform without numeric native identities uses its birth clock. */ }
  }
  return nativeBirth(parent) > nativeBirth(child);
}
