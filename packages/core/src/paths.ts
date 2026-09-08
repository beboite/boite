import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Os } from '@boite/contracts';

export function currentOs(): Os {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

export function defaultDataDir(): string {
  switch (currentOs()) {
    case 'windows': {
      const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
      return join(local, 'boite2');
    }
    case 'macos':
      return join(homedir(), 'Library', 'Application Support', 'boite2');
    default:
      return join(homedir(), '.local', 'share', 'boite2');
  }
}

export function resolveDataDir(override?: string | undefined): string {
  const fromEnv = process.env.BOITE_DATA_DIR;
  if (override && override.length > 0) return override;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return defaultDataDir();
}

export function homePath(): string {
  return homedir();
}

/** Everything a managed install of this provider owns: downloads, releases, the current link. */
export function providerAgentDir(dataDir: string, providerId: string): string {
  return join(dataDir, 'agents', providerId);
}

/**
 * What `{agentsDir}` becomes in a descriptor: the release a managed install
 * points at right now. A profile with an `install` block names its executable
 * under this, so the candidate resolves the moment the files land and resolves
 * to nothing before that.
 */
export function agentsDirPath(dataDir: string, providerId: string): string {
  return join(providerAgentDir(dataDir, providerId), 'current');
}

/**
 * What `{appdata}` becomes in a descriptor: Windows' roaming per-user directory,
 * where npm puts its global installs. Only a windows profile ever names the
 * token, so off Windows it expands to a path nothing exists at and a `file`
 * candidate using it simply loses to the next candidate.
 */
export function appDataPath(): string {
  if (currentOs() === 'windows') {
    const roaming = process.env.APPDATA;
    if (roaming !== undefined && roaming.length > 0) return roaming;
  }
  return join(homedir(), 'AppData', 'Roaming');
}
