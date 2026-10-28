import { resolve, sep } from 'node:path';
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
 * The checkouts a `git worktree remove` is deleting. The removal takes one
 * right after its last check that no thread uses the folder, with no await in
 * between, and holds it until git ends. Whatever would put a thread or a shell
 * in a folder (a restore, a new or moved thread, a terminal) asks first, in the
 * same step that records it, so neither side can slip past the other.
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

  /** The checkout being removed that `cwd` lies in, or null. */
  holder(cwd: string): string | null {
    if (this.held.size === 0) return null;
    const at = keyOf(cwd);
    for (const { path, keys } of this.held.values()) if (keys.some((key) => inside(key, at))) return path;
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
}
