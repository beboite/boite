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
 * What `{browserNoop}` becomes in a descriptor: a launcher that takes a URL and
 * exits without opening anything. An agent that would otherwise pop the user's
 * browser mid-turn is pointed at it through `BROWSER`, and the link it printed
 * reaches the user through Boite instead. Written by `AccountStore` before the
 * first spawn, never by the loader.
 */
export function browserNoopPath(dataDir: string): string {
  return join(dataDir, currentOs() === 'windows' ? 'browser-noop.cmd' : 'browser-noop.sh');
}

/** What that launcher holds: a script that ignores its argument and succeeds. */
export function browserNoopScript(): string {
  return currentOs() === 'windows' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n';
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
