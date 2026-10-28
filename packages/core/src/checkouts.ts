import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ThreadSummary } from '@boite/contracts';
import { refused } from './errors.ts';

/**
 * A path as it compares: absolute, native separators, no trailing separator,
 * and without case on Windows, where `D:\Dev` and `d:/dev` are one folder.
 */
export function keyOf(path: string): string {
  const full = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The folder as the filesystem names it, links and junctions followed, in
 * any part of the path. A part that does not exist yet keeps its name under
 * the nearest parent that does. Null when not even a root resolves.
 */
function physicalKey(path: string): string | null {
  let at = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return keyOf(join(realpathSync.native(at), ...rest));
    } catch {
      // Missing or unreadable: its parent says where the rest would be.
    }
    const up = dirname(at);
    if (up === at) return null;
    rest.unshift(basename(at));
    at = up;
  }
}

/**
 * What a thread row alone says about its checkout: a live conversation, or an
 * archived one whose turn has not rested (`idle` or `error`), works there. The
 * removal's own check adds processes and terminals (`threads/occupancy.ts`).
 */
export function recordHoldsCheckout(thread: Pick<ThreadSummary, 'archived' | 'status'>): boolean {
  return !thread.archived || (thread.status !== 'idle' && thread.status !== 'error');
}

/**
 * The checkouts a `git worktree remove` is deleting. The removal takes one
 * right after its last check that no thread uses the folder, with no await in
 * between, and holds it until git ends. Every thread row is admitted against
 * it as the journal writes it (`Journal.admitThread`), whichever path the row
 * comes from, and a shell asks before it opens; both in the same step that
 * records them, so neither side can slip past the other.
 */
export class CheckoutReservations {
  private readonly held = new Map<number, { path: string; keys: string[] }>();
  private next = 0;

  /** Reserves `path` under each of its keys (as written, as resolved); the function it returns gives it back, once. */
  reserve(path: string, keys: readonly string[]): () => void {
    const id = this.next++;
    this.held.set(id, { path, keys: [...new Set([keyOf(path), ...keys])] });
    return () => { this.held.delete(id); };
  }

  /** The checkout being removed that `cwd` lies in, by its name or through a link, or null. */
  holder(cwd: string): string | null {
    if (this.held.size === 0) return null;
    const names = [keyOf(cwd), physicalKey(cwd)].filter((name): name is string => name !== null);
    for (const { path, keys } of this.held.values()) if (keys.some((key) => names.some((name) => inside(key, name)))) return path;
    return null;
  }

  /** Refuses `cwd` while it lies in a checkout being removed. `what` names who asked, for the message. */
  assertFree(cwd: string, what: string, data: Record<string, unknown> = {}): void {
    const path = this.holder(cwd);
    if (path === null) return;
    throw refused(`the worktree ${path} is being removed: ${what} cannot use ${cwd}`, {
      ...data, cwd, field: 'cwd', expected: 'a folder no worktree removal holds',
    });
  }

  /** Refuses a thread row that would work in a checkout being removed. A row at rest there passes. */
  admit(thread: Pick<ThreadSummary, 'id' | 'cwd' | 'archived' | 'status'>): void {
    if (this.held.size === 0 || !recordHoldsCheckout(thread)) return;
    this.assertFree(thread.cwd, `conversation ${thread.id}`, { threadId: thread.id });
  }
}
