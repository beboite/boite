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
