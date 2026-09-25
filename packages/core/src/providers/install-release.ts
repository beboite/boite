import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderId, ProviderInstall } from '@boite/contracts';
import { currentOs } from '../paths.ts';
import { messageOf, refused } from '../errors.ts';
import { safeEntryPath } from './install-unpack.ts';

/** Written beside the files a release unpacked to, and the only proof an install finished. */
export const RELEASE_RECORD = '.install-complete.json';

export interface ReleaseRecord {
  version: string;
  files: string[];
  installedAt: number;
}

/** The record `current` holds, null when there is none; a record that does not parse is refused. */
export function readReleaseRecord(currentDir: string): ReleaseRecord | null {
  const file = join(currentDir, RELEASE_RECORD);
  if (!existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) throw new Error('expected an object');
    const record = raw as Partial<ReleaseRecord>;
    if (typeof record.version !== 'string' || record.version.length === 0) throw new Error('version must be a nonempty string');
    if (!Array.isArray(record.files) || !record.files.every((entry) => typeof entry === 'string' && safeEntryPath(entry) !== null)) {
      throw new Error('files must be an array of relative file paths');
    }
    if (typeof record.installedAt !== 'number' || !Number.isFinite(record.installedAt)) throw new Error('installedAt must be a finite timestamp');
    return {
      version: record.version,
      files: record.files,
      installedAt: record.installedAt,
    };
  } catch (error) {
    throw refused(`${file}: invalid completion record: ${messageOf(error)}. Uninstall this release before installing again.`);
  }
}

/** The record that marks an unpacked and checked release as complete. */
export function writeReleaseRecord(releaseDir: string, install: ProviderInstall): void {
  writeFileSync(
    join(releaseDir, RELEASE_RECORD),
    `${JSON.stringify(
      { version: install.version, files: install.files.map((file) => file.path), installedAt: Date.now() },
      null,
      2,
    )}\n`,
  );
}

/**
 * `current` points at the release that just landed: a junction on Windows, a
 * symlink elsewhere, and a plain rename of the directory where neither can be
 * made (an unprivileged account with no developer mode is the case). On that
 * last path an update has nothing to keep: the old release was moved into
 * `current` rather than linked, so repointing takes it.
 */
export function pointCurrent(
  providerId: ProviderId,
  link: string,
  releaseDir: string,
  log: (level: 'warn', message: string) => void,
): void {
  mkdirSync(dirname(link), { recursive: true });
  removeCurrent(link);
  try {
    symlinkSync(releaseDir, link, currentOs() === 'windows' ? 'junction' : 'dir');
  } catch (error) {
    log(
      'warn',
      `${providerId}: no link could be made (${error instanceof Error ? error.message : String(error)}), the release directory was moved into place instead`,
    );
    renameSync(releaseDir, link);
  }
}

/**
 * `existsSync` follows the link, so a broken one would read as absent and be
 * left behind. The link itself is what is looked at, and a Windows junction
 * refuses `unlink` while answering `rmdir`.
 */
export function removeCurrent(link: string): void {
  let stats;
  try {
    stats = lstatSync(link);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    try {
      unlinkSync(link);
      return;
    } catch {
      /* a junction: rmdir takes it */
    }
    try {
      rmdirSync(link);
      return;
    } catch {
      /* neither: fall through to the recursive remove */
    }
  }
  rmSync(link, { recursive: true, force: true });
}
