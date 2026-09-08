import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  writeFileSync(coreFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  process.stdout.write(`boite-core ready ${core.baseUrl()} pairing ${core.pairingUrl()}\n`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void server.stop();
    void core.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) main(process.argv.slice(2));
