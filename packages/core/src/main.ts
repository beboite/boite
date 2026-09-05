import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Core } from './core.ts';
import { newToken } from './ids.ts';
import { resolveDataDir } from './paths.ts';
import { startServer } from './server.ts';

interface CoreFile {
  port: number;
  host: string;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}

interface Flags {
  port: number;
  host: string;
  dataDir: string | undefined;
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { port: 0, host: '127.0.0.1', dataDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--port':
        flags.port = Number(value ?? '0');
        index += 1;
        break;
      case '--host':
        flags.host = value ?? flags.host;
        index += 1;
        break;
      case '--lan':
        flags.host = '0.0.0.0';
        break;
      case '--data-dir':
        flags.dataDir = value;
        index += 1;
        break;
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

export function main(argv: string[]): void {
  const flags = parseFlags(argv);
  const dataDir = resolveDataDir(flags.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const coreFile = join(dataDir, 'core.json');
  const token = readToken(coreFile) ?? newToken();
  const core = new Core({ dataDir, token });
  const server = startServer({ core, host: flags.host, port: flags.port });

  const state: CoreFile = {
    port: server.port,
    host: flags.host,
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
