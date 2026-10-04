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
import { uptime } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Channel, Group, PairingGrant, PairingRole, Settings, TailscaleStatus } from '@boite/contracts';
import { connect } from './client.ts';
import type { Core } from './core.ts';
import { CORE_VERSION } from './version.ts';
import { messageOf } from './errors.ts';
import { newToken } from './ids.ts';
import { resolveDataDir } from './paths.ts';
import { processPlatform } from './platform/index.ts';

const CHANNELS: readonly Channel[] = ['stable', 'dev'];

/** How long a graceful shutdown may take before the process leaves anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * How much later than the lock's own time a holder may have started and still
 * be the core that wrote it. The core starts before it writes the lock, so this
 * only absorbs the clocks: procfs gives the boot time in whole seconds.
 */
const LOCK_CLOCK_MARGIN_MS = 2000;

interface CoreFile {
  port: number;
  host: string;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}

export interface Flags {
  publicUrl?: string;
  port: number;
  /** True once `--port` named one: then no other port is tried. */
  portExplicit: boolean;
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

/** Did the process wearing `pid` start after the lock that names it was written? */
function startedAfter(pid: number, lockedAt: number | null, startedAt: (pid: number) => number | null): boolean {
  if (lockedAt === null) return false;
  const started = startedAt(pid);
  return started !== null && started > lockedAt + LOCK_CLOCK_MARGIN_MS;
}

/**
 * The journal holds every conversation and the push private key. Under the
 * usual umask a Linux home directory would leave it readable by any local
 * account, so the directory is the owner's alone, an existing install included.
 */
export function prepareDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
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
 *
 * Gone includes a pid worn by someone else. A core that died without releasing
 * the lock, in a reboot say, leaves its pid to whatever asks next: a browser
 * tab held the pid of a dead core and kept every later core from starting. A
 * holder that started after the lock was written is not the core that wrote it.
 * Nor is any process when the lock predates the last boot: that is the only
 * test macOS can make, since `startedAt` cannot read a start time there.
 */
export function lockDataDir(
  dataDir: string,
  startedAt: (pid: number) => number | null = processPlatform.startedAt,
  bootedAt: () => number = () => Date.now() - uptime() * 1000,
): () => void {
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
      let lockedAt: number | null = null;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<{ pid: number; startedAt: number }>;
        holder = typeof parsed.pid === 'number' ? parsed.pid : null;
        lockedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : null;
      } catch {
        holder = null;
      }
      const beforeBoot = lockedAt !== null && lockedAt < bootedAt() - LOCK_CLOCK_MARGIN_MS;
      if (holder !== null && holder !== process.pid && !beforeBoot && alive(holder) && !startedAfter(holder, lockedAt, startedAt)) {
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
  const role: PairingRole = argv.includes('--owner') ? 'owner' : 'device';
  const client = await ownerClient(argv);
  try {
    return await client.call('pairing.grant', { role });
  } finally {
    client.close();
  }
}

/**
 * `boite-core tailscale [status|on|off] [--replace]`: the Tailscale HTTPS
 * switch of Settings, for a machine with no window. `on` refuses to take 443
 * from another target unless `--replace` says so.
 */
export async function tailscale(argv: string[]): Promise<TailscaleStatus> {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
  if (!['status', 'on', 'off'].includes(action)) throw new Error(`tailscale takes status, on or off, got ${action}`);
  const client = await ownerClient(argv);
  try {
    if (action === 'on') return await client.call('tailscale.enable', { replace: argv.includes('--replace') });
    if (action === 'off') return await client.call('tailscale.disable', {});
    return await client.call('tailscale.status', {});
  } finally {
    client.close();
  }
}

/** One line per state, for `boite-core tailscale`. */
export function describeTailscale(status: TailscaleStatus): string {
  const lines: Record<TailscaleStatus['state'], string> = {
    missing: 'Tailscale is not installed on this machine.',
    stopped: 'Tailscale is installed but not connected. Connect it, then try again.',
    'needs-login': 'Tailscale is signed out. Sign in, then try again.',
    'https-disabled': 'HTTPS certificates are off for this tailnet. Turn on MagicDNS and HTTPS in the admin console (DNS page).',
    off: `Ready: ${status.url} is not served. Run "boite-core tailscale on".`,
    on: `Serving ${status.url} -> ${status.target}.${status.publicUrlMatches ? ' Pairing links use it.' : ''}`,
    conflict: `${status.url} already serves ${status.servedTarget}. "boite-core tailscale on --replace" takes it over.`,
    error: 'The tailscale CLI did not answer as expected.',
  };
  const detail = status.detail ? ` (${status.detail})` : '';
  const action = status.actionUrl ? `\nOpen ${status.actionUrl}` : '';
  return `${lines[status.state]}${detail}${action}`;
}

const FLAGS_WITH_VALUE = new Set(['--public-url', '--port', '--host', '--data-dir', '--channel']);

/** What is left of a command line once the flags and their values are taken out. */
export function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (FLAGS_WITH_VALUE.has(arg)) index += 1;
    else if (!arg.startsWith('--')) out.push(arg);
  }
  return out;
}

function describeGroup(group: Group | null): string {
  if (group === null) return 'this machine belongs to no group\n';
  const lines = group.cores.map((core) => `  ${core.coreId === group.self ? '*' : ' '} ${core.name}  ${core.addresses.join(' ')}`);
  return `group ${group.name}, ${group.cores.length} machine${group.cores.length === 1 ? '' : 's'}, ${group.devices.length} device${group.devices.length === 1 ? '' : 's'}\n${lines.join('\n')}\n`;
}

/**
 * `boite-core group <status|create|invite|join|leave>`: the group card of a
 * machine with no window, on the core already running on this data directory.
 * What it prints on stdout is the answer alone (the invitation, the roster),
 * so a script can take it; an invitation is a credential and stays out of logs.
 */
export async function group(argv: string[]): Promise<string> {
  const [action = 'status', value] = positionals(argv);
  // Refused before anything else: an invitation given as an argument stays in the process list, in the
  // shell's history and in a traced command line, and lets whoever reads it join first.
  if (action === 'join' && value !== undefined) {
    throw new Error('group join takes no argument: give the invitation on its standard input, so it stays out of the process list');
  }
  const client = await ownerClient(argv);
  try {
    switch (action) {
      case 'status':
        return describeGroup(await client.call('group.get', {}));
      case 'create':
        if (!value) throw new Error('group create expects a name');
        return describeGroup(await client.call('group.create', { name: value }));
      case 'invite':
        return `${(await client.call('group.invite', {})).invite}\n`;
      case 'join': {
        const invite = (await Bun.stdin.text()).trim();
        if (!invite) throw new Error('group join reads the invitation "group invite" printed on a machine of the group from its standard input');
        return describeGroup(await client.call('group.join', { invite }));
      }
      case 'leave':
        await client.call('group.leave', {});
        return describeGroup(null);
      default:
        throw new Error(`group expects status, create, invite, join or leave, got ${action}`);
    }
  } finally {
    client.close();
  }
}

/** A connection to the core already running on this data directory, as its owner, with the token `core.json` holds. */
async function ownerClient(argv: string[]): Promise<Awaited<ReturnType<typeof connect>>> {
  const flags = parseFlags(argv);
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
  try {
    return await connect(url, state.token, { client: { name: 'cli', version: CORE_VERSION } });
  } catch (error) {
    throw new Error(`no core answers at ${url}, the address ${file} names: ${(error as Error).message}`);
  }
}

/**
 * Why the core will not start, on one line, then out. A throw left to Bun
 * printed lines of the minified bundle around it, and the shell shows the user
 * everything the core wrote before it died.
 */
function refuseToStart(error: unknown): never {
  process.stderr.write(`boite-core: ${messageOf(error)}\n`);
  process.exit(1);
}

/**
 * An app started from Finder, the Dock or a desktop launcher may get no locale
 * at all: launchd sets none. Agents, their tools and the terminal then run in
 * the C locale, which prints accented file names as `?` and breaks line
 * editing. A UTF-8 locale is filled in only when none of the three is set.
 */
export function withUtf8Locale(env: Record<string, string | undefined>, platform: NodeJS.Platform): void {
  if (platform === 'win32' || env['LANG'] || env['LC_ALL'] || env['LC_CTYPE']) return;
  env['LANG'] = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

export function main(argv: string[]): void {
  if (argv[0] === '--speech-worker') {
    void import('./speech-native-worker.ts').then(worker => worker.runSpeechWorker());
    return;
  }
  withUtf8Locale(process.env, process.platform);
  if (argv[0] === 'update-apply') {
    void (async () => {
      if (!processPlatform.serverUpdates || !argv[1]) throw new Error('update-apply expects a private server update plan on Linux');
      const { applyServerUpdate } = await import('./server-update/apply.ts');
      await applyServerUpdate(argv[1], processPlatform.serverUpdates);
    })().catch(error => { process.stderr.write(`boite-core update: ${messageOf(error)}\n`); process.exitCode = 1; });
    return;
  }
  // `boite-core cli ...` is the `boite` command an agent runs, behind its shim.
  if (argv[0] === 'cli') {
    // The exit code is set and the process left to end on its own: `process.exit`
    // would cut what a piped stdout has not flushed yet, and a long list is piped.
    void import('./cli.ts').then(({ runCli, processIo }) => runCli(argv.slice(1), processIo())).then(
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
        if (grant.code && grant.codeExpiresAt) {
          process.stderr.write(`or type the code ${grant.code} in the installed app, until ${new Date(grant.codeExpiresAt).toISOString()}\n`);
        }
        process.exit(0);
      },
      (error: unknown) => {
        process.stderr.write(`boite-core pair: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
    return;
  }
  if (argv[0] === 'group') {
    group(argv.slice(1)).then(
      (answer) => {
        process.stdout.write(answer);
        process.exit(0);
      },
      (error: unknown) => {
        process.stderr.write(`boite-core group: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
    return;
  }
  if (argv[0] === 'tailscale') {
    tailscale(argv.slice(1)).then(
      (status) => {
        process.stdout.write(`${describeTailscale(status)}\n`);
        process.exit(status.state === 'on' || status.state === 'off' ? 0 : 2);
      },
      (error: unknown) => {
        process.stderr.write(`boite-core tailscale: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
    return;
  }

  // Commands do not need the server graph. Finish imports before taking its data lock.
  void Promise.all([import('./core.ts'), import('./server.ts')]).then(([{ Core }, { startServerOnStickyPort }]) => {
    let flags: Flags;
    let dataDir: string;
    let unlock: () => void;
    try {
      flags = parseFlags(argv);
      dataDir = resolveDataDir(flags.dataDir, flags.channel);
      prepareDataDir(dataDir);
      // Before the journal is opened, because opening it is already a write.
      unlock = lockDataDir(dataDir);
    } catch (error) {
      refuseToStart(error);
    }
    const coreFile = join(dataDir, 'core.json');
    const previous = readPreviousRun(coreFile);
    const token = previous.token ?? newToken();
    let core: Core;
    try {
      // Windows ships a Bun runtime and a split bundle. Capture what this run
      // loaded now; reading it on /health after a reinstall would describe new code.
      const entry = process.argv[1];
      const bundleHash = entry?.endsWith('.js') && existsSync(entry)
        ? createHash('sha256').update(readFileSync(entry)).digest('hex') : undefined;
      core = new Core({ dataDir, token, channel: flags.channel, bundleHash, onShutdown: () => shutdown() });
    } catch (error) {
      // A journal from a newer release, among others: say why and leave the data as it is.
      unlock();
      refuseToStart(error);
    }
    const publicUrl = flags.publicUrl ?? process.env.BOITE_PUBLIC_URL;
    if (publicUrl !== undefined) core.settings.set({ publicUrl });
    const settings = core.settings.get();
    const host = resolveHost(flags, settings);
    let server: ReturnType<typeof startServerOnStickyPort>;
    try {
      // An address the operator named is the only one this core answers on.
      server = startServerOnStickyPort({ core, host, port: flags.port, explicitPort: flags.portExplicit, previousPort: previous.port, tailnet: !flags.hostExplicit });
    } catch (error) {
      const deadline = setTimeout(() => { unlock(); refuseToStart(error); }, SHUTDOWN_TIMEOUT_MS);
      deadline.unref();
      void core.close()
        .catch(closeError => core.log('error', `startup cleanup failed: ${messageOf(closeError)}`))
        .finally(() => {
          clearTimeout(deadline);
          unlock();
          refuseToStart(error);
        });
      return;
    }
    core.updates.start();
    core.serverUpdates.start();
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
          process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
        });
    };
    process.on('SIGINT', shutdown);
    // What a service manager sends for a restart, an update or a reboot. The
    // first one hands the running turns to the next core: each ends its tool
    // call, 30 seconds at most, and resumes after the restart. A second one
    // stops them now, and they still resume. A third exits.
    let terms = 0;
    process.on('SIGTERM', () => {
      terms += 1;
      if (stopping || terms > 2) shutdown();
      else if (terms === 1) core.requestHandoffShutdown();
      else core.requestShutdown();
    });
    // The last line of defence: Bun exits on either anyway. This leaves a log
    // line, stops the turns and releases the lock on the way out; the process
    // never carries on after an error nobody expected.
    const fatal = (kind: string) => (error: unknown): void => {
      core.log('error', `${kind}: ${messageOf(error)}`);
      process.stderr.write(`boite-core ${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
      shutdown();
    };
    process.on('uncaughtException', fatal('uncaught exception'));
    process.on('unhandledRejection', fatal('unhandled rejection'));

    // The terminal a core was started from closed. Off Windows each child leads a
    // session of its own and gets no hang-up of its own any more, so without this
    // the core died on the default action and left every group running. A hang-up
    // can arrive twice (from the kernel and from `bun run` passing it on) and is
    // never the operator asking to hurry, so a repeat does not cut the shutdown short.
    process.on('SIGHUP', () => {
      if (!stopping) shutdown();
    });
  }, refuseToStart);
}

if (import.meta.main) main(process.argv.slice(2));
