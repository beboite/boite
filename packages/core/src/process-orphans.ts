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
 * An exited `sh`, `bash`, `dash` or `zsh` that exited with 0, whose own parent
 * has its image and still runs, is a fork, not a shell: Git Bash (MSYS2) forks
 * a copy of the shell to exec each command, and that copy exits once the
 * command runs. Its child hangs from that live shell and stays while it runs,
 * so a background `sh wait.sh` keeps its shell. One exited fork is passed over,
 * never two: the `sleep` of a nested bash that exited or was stopped has the
 * fork and that bash dead above it, and goes. What an interrupted command left
 * goes too, since its shell is a different image from the agent above it, and
 * so does what an exited Node worker left under a live Node.
 */
export function orphansOf<T extends Traced>(byPid: ReadonlyMap<number, T>, now: number, graceMs: number, runningSince: (pid: number) => number | null): Map<number, T> {
  const entries = [...byPid.values()];
  const stopping = new Map<number, T>();
  // Who each process hangs from: its parent pid, or the shell that forked its exited parent.
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
 * The live shell whose fork was `entry`'s parent and exited, or undefined when
 * the parent still runs, was never seen, or is no such fork.
 */
function forkerOf<T extends Traced>(entry: T, byPid: ReadonlyMap<number, T>): T | undefined {
  const fork = entry.parent ?? null;
  if (fork === null || running(fork, byPid)) return undefined;
  const shell = fork.parent ?? null;
  return shell !== null && running(shell, byPid) && shellFork(fork, shell) ? byPid.get(shell.record.pid) : undefined;
}

function running(entry: Traced, byPid: ReadonlyMap<number, Traced>): boolean {
  return byPid.get(entry.record.pid) === entry;
}

/** `fork` exists only in an MSYS2 or Cygwin program, and these shells fork for every command. */
const FORKING_SHELL = /(?:^|[\\/])(?:ba|da|z)?sh\.exe$/i;

/**
 * `fork` is a copy of `shell` that exec'd a command and exited. In 74,975 such
 * forks of a real trace, all exited with 0; no timing is read, since exit
 * events can arrive late.
 */
function shellFork(fork: Traced, shell: Traced): boolean {
  const exe = fork.record.exe;
  return FORKING_SHELL.test(exe) && exe.toLowerCase() === shell.record.exe.toLowerCase() && fork.record.exitCode === 0;
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
