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
import type { Channel, PairingGrant, PairingRole, Settings } from '@boite/contracts';
import { processIo, runCli } from './cli.ts';
import { connect } from './client.ts';
import { CORE_VERSION, Core } from './core.ts';
import { messageOf } from './errors.ts';
import { newToken } from './ids.ts';
import { resolveDataDir } from './paths.ts';
import { startServerOnStickyPort } from './server.ts';

const CHANNELS: readonly Channel[] = ['stable', 'dev'];

/** How long a graceful shutdown may take before the process leaves anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

interface CoreFile {
  port: number;
  /** True once `--port` named one: then no other port is tried. */
  portExplicit: boolean;
  host: string;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}

export interface Flags {
  publicUrl?: string;
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
    portExplicit: false,
    host: '127.0.0.1',
    hostExplicit: false,
    dataDir: undefined,
    channel: 'stable',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--public-url':
        if (!value || value.startsWith('--')) throw new Error('--public-url expects an HTTPS origin');
        flags.publicUrl = value;
        index += 1;
        break;
      case '--port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`--port expects an integer between 0 and 65535, got ${value ?? '(nothing)'}`);
        }
        flags.port = port;
        flags.portExplicit = true;
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

/**
 * What the previous run of this data directory left in `core.json`: the owner
 * token, kept so `boite-core pair` and the CLI survive a restart, and the port,
 * kept so a paired phone does.
 */
export function readPreviousRun(file: string): { token: string | null; port: number | null } {
  if (!existsSync(file)) return { token: null, port: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CoreFile>;
    const token = typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
    const port = Number.isInteger(parsed.port) && parsed.port! > 0 && parsed.port! <= 65535 ? parsed.port! : null;
    return { token, port };
  } catch {
    return { token: null, port: null };
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

/**
 * `boite-core pair [--owner]`: a one-time pairing link from the core already
 * running on this data directory. It is the Settings page of a machine with no
 * window, a server say: the command reads the core token out of `core.json`,
 * which only the account running the core can, asks that core for a grant over
 * its own socket, and hands the link back. `--owner` makes it a link for a
 * computer of the user's own, which then drives this core as its owner.
 */
export async function pair(argv: string[]): Promise<PairingGrant> {
  const flags = parseFlags(argv);
  const role: PairingRole = argv.includes('--owner') ? 'owner' : 'device';
  const dataDir = resolveDataDir(flags.dataDir, flags.channel);
  const file = join(dataDir, 'core.json');
  if (!existsSync(file)) {
    throw new Error(`no core has run on ${dataDir}: ${file} does not exist. Start the core first.`);
  }
  let state: Partial<CoreFile>;
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as Partial<CoreFile>;
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  if (typeof state.port !== 'number' || typeof state.token !== 'string' || state.token.length === 0) {
    throw new Error(`${file} has no port or no token`);
  }
  const bound = state.host ?? '127.0.0.1';
  const host = bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${state.port}`;
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect(url, state.token, { client: { name: 'cli', version: CORE_VERSION } });
  } catch (error) {
    throw new Error(`no core answers at ${url}, the address ${file} names: ${(error as Error).message}`);
  }
  try {
    return await client.call('pairing.grant', { role });
  } finally {
    client.close();
  }
}

export function main(argv: string[]): void {
  // `boite-core cli ...` is the `boite` command an agent runs, behind its shim.
  if (argv[0] === 'cli') {
    // The exit code is set and the process left to end on its own: `process.exit`
    // would cut what a piped stdout has not flushed yet, and a long list is piped.
    runCli(argv.slice(1), processIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        process.stderr.write(`boite: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
    return;
  }
  if (argv[0] === 'pair') {
    pair(argv.slice(1)).then(
      (grant) => {
        process.stdout.write(`${grant.url}\n`);
        process.stderr.write(
          `pairing link for the ${grant.role} role, good for one use until ${new Date(grant.expiresAt).toISOString()}\n`,
        );
        process.exit(0);
      },
      (error: unknown) => {
        process.stderr.write(`boite-core pair: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
    return;
  }

  const flags = parseFlags(argv);
  const dataDir = resolveDataDir(flags.dataDir, flags.channel);
  mkdirSync(dataDir, { recursive: true });

  // Before the journal is opened, because opening it is already a write.
  const unlock = lockDataDir(dataDir);
  const coreFile = join(dataDir, 'core.json');
  const previous = readPreviousRun(coreFile);
  const token = previous.token ?? newToken();
  const core = new Core({ dataDir, token, channel: flags.channel, onShutdown: () => shutdown() });
  const publicUrl = flags.publicUrl ?? process.env.BOITE_PUBLIC_URL;
  if (publicUrl !== undefined) core.settings.set({ publicUrl });
  const settings = core.settings.get();
  const host = resolveHost(flags, settings);
  const server = startServerOnStickyPort({ core, host, port: flags.port, explicitPort: flags.portExplicit, previousPort: previous.port });
  core.updates.start();
  if (core.cliDir === null) {
    console.warn('the boite CLI shim is not beside the core: agents started here cannot run `boite`. Copy `boite` next to the executable, or name its directory in BOITE_CLI_DIR');
  }
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
  // owner asks for a link in settings or with `boite-core pair`, and that link
  // is the only one.
  process.stdout.write(`boite-core ready ${core.baseUrl()}\n`);

  let stopping = false;
  const shutdown = (): void => {
    // A second signal is the operator saying the graceful path is taking too
    // long. Honour it rather than ignoring it, which used to leave no way out
    // short of killing the process.
    if (stopping) {
      core.log('warn', 'second shutdown signal, exiting now');
      process.exit(1);
    }
    stopping = true;
    // A driver that never answers its stop must not hold the process open, and
    // a rejection anywhere in the chain must not skip unlock() and the exit.
    const deadline = setTimeout(() => {
      core.log('error', `shutdown did not finish in ${SHUTDOWN_TIMEOUT_MS} ms, exiting`);
      unlock();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    void core
      .drain()
      .then(() => server.stop())
      .then(() => core.close())
      .catch((error: unknown) => {
        core.log('error', `shutdown failed: ${messageOf(error)}`);
      })
      .finally(() => {
        clearTimeout(deadline);
        unlock();
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) main(process.argv.slice(2));
