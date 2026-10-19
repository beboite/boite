import type { ProcessRecord } from '@boite/contracts';
import type { ProcessIdentity } from './process-identity.ts';

interface Traced {
  record: ProcessRecord;
  identity: ProcessIdentity;
  /** The parent the registry held when this process started, kept after it exits. */
  parent?: Traced | null;
}

/**
 * What a thread left running with nobody above it, by pid: a process whose
 * parent exited, or whose parent pid now names a younger process, past the
 * grace, with everything under it. A parent missing from the registry is
 * looked up in the system (`runningSince`), and one found running there keeps
 * its child. Whatever the core spawned has the core as its parent and is never taken.
 *
 * An exited `sh`, `bash`, `dash` or `zsh` with the image of its own parent,
 * which exited with 0 within seconds of its child's start, is a fork, not a
 * shell: Git Bash (MSYS2) forks a copy of the shell to exec each command, and
 * that copy exits once the command runs. A process under such forks hangs from
 * the first ancestor past them, and stays while that one runs. A background
 * `sh wait.sh` keeps its live shell that way; what an interrupted command left
 * still goes, since its shell is a different image from the agent above it, or
 * was stopped. Any other exited parent of the same image (a Node worker under
 * Node, a nested bash that was killed) is a real parent and leaves an orphan.
 */
export function orphansOf<T extends Traced>(byPid: ReadonlyMap<number, T>, now: number, graceMs: number, runningSince: (pid: number) => number | null): Map<number, T> {
  const entries = [...byPid.values()];
  const stopping = new Map<number, T>();
  // Who each process hangs from: its parent pid, or the live process past its forks.
  const children = new Map<number, T[]>();
  for (const entry of entries) {
    const { record } = entry;
    const parentPid = record.parentPid;
    if (parentPid === null) continue;
    const forker = parentPid === process.pid ? undefined : forkerOf(entry, byPid);
    const above = forker?.record.pid ?? parentPid;
    const siblings = children.get(above);
    if (siblings === undefined) children.set(above, [entry]);
    else siblings.push(entry);
    if (parentPid === process.pid || forker !== undefined) continue;
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
  // walk down the index, so a deep tree costs its size.
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

/** The live entry a starting process names as its parent, unless that pid now names a younger process. */
export function parentAtStart<T extends Traced>(byPid: ReadonlyMap<number, T>, child: Traced): T | null {
  const parentPid = child.record.parentPid;
  if (parentPid === null) return null;
  const parent = byPid.get(parentPid);
  return parent !== undefined && !bornAfter(parent, child) ? parent : null;
}

/**
 * The live process above `entry` once its exited parent and the forks above
 * it are passed, or undefined when its parent still runs, was never seen, or
 * exited without being a fork of the one above it.
 */
function forkerOf<T extends Traced>(entry: T, byPid: ReadonlyMap<number, T>): T | undefined {
  let child: Traced = entry;
  let link = entry.parent ?? null;
  if (link === null || running(link, byPid)) return undefined;
  while (!running(link, byPid)) {
    const above: Traced | null = link.parent ?? null;
    if (above === null || !shellFork(link, above, child)) return undefined;
    child = link;
    link = above;
  }
  return byPid.get(link.record.pid);
}

function running(entry: Traced, byPid: ReadonlyMap<number, Traced>): boolean {
  return byPid.get(entry.record.pid) === entry;
}

/** `fork` exists only in an MSYS2 or Cygwin program, and these shells fork for every command. */
const FORKING_SHELL = /(?:^|[\\/])(?:ba|da|z)?sh\.exe$/i;
/**
 * How soon after its child starts a fork that exec'd it exits. In 74,975 such
 * forks of Boite's trace, all exited with 0, at a median of 19 ms and at most
 * 3.1 s under load; a shell that was stopped exits with another code or later.
 */
const FORK_EXIT_MS = 5000;

/** `fork` is a copy of `shell` that exec'd `child` and exited, not a shell that ran it and was stopped. */
function shellFork(fork: Traced, shell: Traced, child: Traced): boolean {
  const { exe, exitCode, exitedAt } = fork.record;
  return FORKING_SHELL.test(exe) && exe.toLowerCase() === shell.record.exe.toLowerCase()
    && exitCode === 0 && exitedAt !== null && exitedAt - nativeBirth(child) <= FORK_EXIT_MS;
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
