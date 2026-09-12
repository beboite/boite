import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Channel, Settings } from '@boite/contracts';
import { Core } from './core.ts';
import { newToken } from './ids.ts';
import { resolveDataDir } from './paths.ts';
import { startServer } from './server.ts';

const CHANNELS: readonly Channel[] = ['stable', 'dev'];

interface CoreFile {
  port: number;
  host: string;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}

export interface Flags {
  port: number;
  host: string;
  /** True once `--host` or `--lan` named an address, so the setting no longer decides. */
  hostExplicit: boolean;
  dataDir: string | undefined;
  /** Which install this core belongs to. The dev shell passes `--channel dev`. */
  channel: Channel;
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    port: 0,
    host: '127.0.0.1',
    hostExplicit: false,
    dataDir: undefined,
    channel: 'stable',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`--port expects an integer between 0 and 65535, got ${value ?? '(nothing)'}`);
        }
        flags.port = port;
        index += 1;
        break;
      }
      case '--host':
        flags.host = value ?? flags.host;
        flags.hostExplicit = true;
        index += 1;
        break;
      case '--lan':
        flags.host = '0.0.0.0';
        flags.hostExplicit = true;
        break;
      case '--data-dir':
        if (value === undefined || value.startsWith('--')) throw new Error('--data-dir expects a path');
        flags.dataDir = value;
        index += 1;
        break;
      case '--channel': {
        if (value === undefined || !CHANNELS.includes(value as Channel)) {
          throw new Error(
            `--channel expects ${CHANNELS.join(' or ')}, got ${value ?? '(nothing)'}`,
          );
        }
        flags.channel = value as Channel;
        index += 1;
        break;
      }
      default:
        break;
    }
  }
  return flags;
}

function readToken(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CoreFile>;
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

/** Is that process still there? `EPERM` means it is, under another account. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One core per data directory, taken before the journal is opened.
 *
 * Two cores on one directory is not a rare accident: `bun run dev:core` reads
 * the same default directory as the installed app, and every `Core` ends its
 * constructor with `recoverStuckTurns()`, which rewrites every turn still
 * running as a crash. The second core used to take the first one's live turn,
 * its threads and its `core.json` and the user watched his answer turn into an
 * error. A lock whose holder is gone is taken over, so a core killed hard does
 * not leave the directory unusable.
 */
export function lockDataDir(dataDir: string): () => void {
  const file = join(dataDir, 'core.lock');
  const release = (): void => {
    try {
      rmSync(file, { force: true });
    } catch {
      // The directory may be gone already; nothing left to release.
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(file, 'wx');
      writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2)}\n`, 'utf8');
      closeSync(handle);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: number | null = null;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<{ pid: number }>;
        holder = typeof parsed.pid === 'number' ? parsed.pid : null;
      } catch {
        holder = null;
      }
      if (holder !== null && holder !== process.pid && alive(holder)) {
        throw new Error(
          `another core is already running on ${dataDir} (pid ${holder}). Close it, or start this one with --data-dir on a directory of its own.`,
        );
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take the lock on ${dataDir}: ${file} keeps coming back`);
}

/**
 * Where the core binds. A `--host` or a `--lan` on the command line always wins,
 * because the person who typed it meant it; with neither, the stored
 * `listenOnLan` setting decides, which is what the switch in General settings
 * changes. The address is read once, at start: a running core never rebinds.
 */
export function resolveHost(flags: Flags, settings: Settings): string {
  if (flags.hostExplicit) return flags.host;
  return settings.listenOnLan ? '0.0.0.0' : '127.0.0.1';
}

export function main(argv: string[]): void {
  const flags = parseFlags(argv);
  const dataDir = resolveDataDir(flags.dataDir, flags.channel);
  mkdirSync(dataDir, { recursive: true });

  // Before the journal is opened, because opening it is already a write.
  const unlock = lockDataDir(dataDir);
  const coreFile = join(dataDir, 'core.json');
  const token = readToken(coreFile) ?? newToken();
  const core = new Core({ dataDir, token, channel: flags.channel });
  const settings = core.settings.get();
  const host = resolveHost(flags, settings);
  const server = startServer({ core, host, port: flags.port });
  if (!flags.hostExplicit) {
    core.log('info', `listening on ${host} because listenOnLan is ${settings.listenOnLan ? 'on' : 'off'}`);
  }

  const state: CoreFile = {
    port: server.port,
    host,
    token,
    pid: process.pid,
    startedAt: core.startedAt,
    version: core.version,
  };
  // The file carries the token that owns this core, so it is the owner's to
  // read and nobody else's. Windows ignores the mode, which is why the file
  // sits in the user's own application data directory to begin with.
  writeFileSync(coreFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(coreFile, 0o600);

  // No pairing grant here. Every start used to mint a live one and print it,
  // so any log, any terminal scrollback and any shell that reprinted the line
  // handed out a session token nobody had asked for. A phone pairs when the
  // owner asks for a link in settings, and that link is the only one.
  process.stdout.write(`boite-core ready ${core.baseUrl()}\n`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void server
      .stop()
      .then(() => core.close())
      .then(() => {
        unlock();
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) main(process.argv.slice(2));
