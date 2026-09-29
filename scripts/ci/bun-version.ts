/**
 * A compiled or staged core carries the Bun that built it: `bun build
 * --compile` embeds the running runtime, and on Windows the sidecar is that
 * runtime copied under another name. CI installs the version `packageManager`
 * pins; a local build ran whatever Bun was on the machine and shipped it
 * silently. This refuses that, naming both versions.
 *
 * `BOITE_ALLOW_BUN_MISMATCH=1` lets a local experiment through on purpose.
 * Run directly, it checks the Bun running it: `bun scripts/ci/bun-version.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

/** The Bun version `packageManager` pins, or an error naming what it holds. */
export function pinnedBun(packageJson: string): string {
  const manager = (JSON.parse(packageJson) as { packageManager?: unknown }).packageManager;
  const match = typeof manager === 'string' ? /^bun@(\d+\.\d+\.\d+)$/.exec(manager) : null;
  if (!match) throw new Error(`package.json packageManager must be bun@<x.y.z>, and it is ${JSON.stringify(manager)}`);
  return match[1]!;
}

/** Why `running` may not build what ships, or null when it may. */
export function bunMismatch(what: string, running: string, pinned: string, allowed: boolean): string | null {
  if (running === pinned || allowed) return null;
  return `${what} would carry Bun ${running}, and package.json pins bun@${pinned}. Install Bun ${pinned}, or set BOITE_ALLOW_BUN_MISMATCH=1 for a build that is not shipped.`;
}

/** Exits with the reason when the running Bun is not the pinned one. */
export function requirePinnedBun(what: string): void {
  const reason = bunMismatch(what, Bun.version, pinnedBun(readFileSync(join(ROOT, 'package.json'), 'utf8')),
    process.env.BOITE_ALLOW_BUN_MISMATCH === '1');
  if (reason === null) return;
  console.error(reason);
  process.exit(1);
}

if (import.meta.main) requirePinnedBun(process.argv[2] ?? 'this build');
