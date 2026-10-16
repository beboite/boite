/**
 * A temporary directory of its own for each launch of an agent that unpacks
 * itself when it starts. Antigravity's server is a PyInstaller one-file
 * program: every launch writes about 1.2 GB under the temp directory before the
 * server answers, and only its own clean exit removes it. A probe, a sign-in
 * and a closed session all end with a forced stop of the process tree, so that
 * copy would stay in the user's temp directory each time.
 *
 * The directory sits under the account's isolation directory and goes once
 * the process that used it has exited. Its path stays short: the deepest of
 * the 8261 members agy_acp_server 1.1.1 unpacks is 120 characters, and under
 * the default data directory a member ends near 210 plus the length of the
 * Windows user name, inside the 260-character limit. What a stopped core left
 * behind is swept the first time the account launches again.
 */
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderDescriptor } from '@boite/contracts';
import { removeDir } from '../fs-retry.ts';

export interface LaunchTemp {
  /** The directory the agent unpacks into. */
  dir: string;
  /** What the launch adds to its environment: every name a temp directory is read from. */
  env: Record<string, string>;
  /** Removes the directory. Call it once the process tree has exited; it never throws. */
  dispose(log?: (message: string) => void): Promise<void>;
}

/** The directory under an account that holds one directory per launch. */
export const LAUNCH_TEMP_DIR = 'tmp';

/** Roots already swept by this core, so a launch never removes a sibling's directory. */
const swept = new Set<string>();

export function unpacksAtLaunch(provider: ProviderDescriptor): boolean {
  return provider.quirks?.includes('antigravity') === true;
}

/**
 * A fresh directory for one launch of this agent, or null for an agent that
 * does not unpack itself or an account with no directory of its own.
 */
export function launchTemp(provider: ProviderDescriptor, isolationDir: string | null): LaunchTemp | null {
  if (!unpacksAtLaunch(provider) || isolationDir === null) return null;
  const root = join(isolationDir, LAUNCH_TEMP_DIR);
  mkdirSync(root, { recursive: true });
  if (!swept.has(root)) {
    swept.add(root);
    // Listed before this launch creates its own, so only a previous core's
    // directories are in the list. One core owns a data directory at a time.
    for (const entry of readdirSync(root)) void removeDir(join(root, entry));
  }
  const dir = mkdtempSync(join(root, 'run-'));
  let disposed: Promise<void> | null = null;
  return {
    dir,
    env: { TEMP: dir, TMP: dir, TMPDIR: dir },
    dispose(log) {
      disposed ??= removeDir(dir, log).then(() => undefined);
      return disposed;
    },
  };
}
