import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Channel, Group, PairingGrant, PairingRole, Settings, TailscaleStatus } from '@boite/contracts';
import { connect } from './client.ts';
import type { Core } from './core.ts';
import { CORE_VERSION } from './version.ts';
import { messageOf } from './errors.ts';
import { newToken } from './ids.ts';
import { resolveDataDir } from './paths.ts';
import { lockDataDir } from './data-lock.ts';
import { openDataDir } from './server-update/restore.ts';
import { processPlatform } from './platform/index.ts';

const CHANNELS: readonly Channel[] = ['stable', 'dev'];

/** How long a graceful shutdown may take before the process leaves anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

interface CoreFile {
  port: number;
  host: string;
  token: string;
  pid: number;
  startedAt: number;
  /** `ProcessPlatform.startKey` of this core, where the OS has one (Linux). */
  startKey?: string;
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

/**
 * The journal holds every conversation and the push private key. Under the
 * usual umask a Linux home directory would leave it readable by any local
 * account, so the directory is the owner's alone, an existing install included.
 */
export function prepareDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
}

export { lockDataDir };

/**
 * Where the core binds. A `--host` or a `--lan` on the command line always wins,
 * because the person who typed it meant it; with neither, the stored
 * `listenOnLan` setting decides, which is what the switch in General settings
 * changes. The address is read once, at start: a running core never rebinds.
 * An admin policy with `network.lan: false` keeps it on loopback whatever the
 * command line says.
 */
export function resolveHost(flags: Flags, settings: Settings, lanForbidden = false): string {
  if (lanForbidden) return flags.hostExplicit && isLoopbackHost(flags.host) ? flags.host : '127.0.0.1';
  if (flags.hostExplicit) return flags.host;
  return settings.listenOnLan ? '0.0.0.0' : '127.0.0.1';
}

/** The address the core listens on, with the admin policy's network.lan over the setting and the flags. */
export function listenHost(core: Core, flags: Flags): string {
  const lanForbidden = core.policy.networkOff('lan');
  const host = resolveHost(flags, core.settings.get(), lanForbidden);
  if (lanForbidden && flags.hostExplicit && host !== flags.host) {
    core.logs.warn(`listening on ${host}, not ${flags.host}: ${core.policy.refusal('network.lan').message}`, { source: 'startup', event: 'startup.policy-host' });
  }
  return host;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
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
export async function ownerClient(argv: string[]): Promise<Awaited<ReturnType<typeof connect>>> {
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
  // The update worker, and the recovery its unit runs however the worker ended.
  if (argv[0] === 'update-apply' || argv[0] === 'update-recover') {
    const command = argv[0];
    void (async () => {
      if (!processPlatform.serverUpdates || !argv[1]) throw new Error(`${command} expects a private server update plan on Linux`);
      const { applyServerUpdate, recoverServerUpdate } = await import('./server-update/apply.ts');
      await (command === 'update-apply' ? applyServerUpdate : recoverServerUpdate)(argv[1], processPlatform.serverUpdates);
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
        process.exit(0);
      },
      (error: unknown) => {
        process.stderr.write(`boite-core pair: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
    return;
  }
  if (argv[0] === 'accounts') {
    import('./accounts-command.ts').then(({ runAccounts }) => runAccounts(argv.slice(1), ownerClient))
      .catch(error => { process.stderr.write(`boite-core accounts: ${messageOf(error)}\n`); process.exit(1); });
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
  void Promise.all([import('./core.ts'), import('./server.ts'), import('./journal/vacuum.ts')]).then(([{ Core }, { PREFERRED_PORTS, startServerOnStickyPort }, { vacuumAtStart, VACUUM_WHEN }]) => {
    let flags: Flags;
    let dataDir: string;
    let unlock: () => void;
    try {
      flags = parseFlags(argv);
      dataDir = resolveDataDir(flags.dataDir, flags.channel);
      // Before the journal is opened, because opening it is already a write. Where server updates run, a
      // rollback a power cut interrupted finishes first.
      const updates = processPlatform.serverUpdates;
      if (updates) unlock = openDataDir(dataDir, prepareDataDir, updates.lock);
      else {
        prepareDataDir(dataDir);
        unlock = lockDataDir(dataDir);
      }
    } catch (error) {
      refuseToStart(error);
    }
    const coreFile = join(dataDir, 'core.json');
    const previous = readPreviousRun(coreFile);
    const token = previous.token ?? newToken();
    // Once, after the background passes freed a large part of the journal; the shell shows it (`core.starting.json`).
    const vacuumErrors: string[] = [];
    const vacuumed = vacuumAtStart(dataDir, message => vacuumErrors.push(message), VACUUM_WHEN, processPlatform.startKey?.(process.pid) ?? null);
    let core: Core;
    try {
      // Windows ships a Bun runtime and a split bundle. Capture what this run
      // loaded now; reading it on /health after a reinstall would describe new code.
      const entry = process.argv[1];
      const bundleHash = entry?.endsWith('.js') && existsSync(entry)
        ? createHash('sha256').update(readFileSync(entry)).digest('hex') : undefined;
      core = new Core({ dataDir, token, channel: flags.channel, bundleHash, onShutdown: () => shutdown(), dataDirKind: flags.dataDir || process.env.BOITE_DATA_DIR ? 'custom' : 'default' });
    } catch (error) {
      // A journal from a newer release, among others: say why and leave the data as it is.
      unlock();
      refuseToStart(error);
    }
    for (const message of vacuumErrors) core.log('error', message);
    if (vacuumed !== null) {
      const mib = (bytes: number) => Math.round(bytes / 1048576);
      core.logs.info(`Journal compacted from ${mib(vacuumed.fileBytes)} to ${mib(vacuumed.afterBytes)} MiB in ${Math.round(vacuumed.ms)} ms`,
        { source: 'startup', event: 'startup.journal-vacuumed', durationMs: vacuumed.ms, data: { fileBytes: vacuumed.fileBytes, afterBytes: vacuumed.afterBytes } });
    }
    const publicUrl = flags.publicUrl ?? process.env.BOITE_PUBLIC_URL;
    if (publicUrl !== undefined) core.settings.set({ publicUrl });
    const host = listenHost(core, flags);
    let server: ReturnType<typeof startServerOnStickyPort>;
    try {
      // An address the operator named is the only one this core answers on.
      server = startServerOnStickyPort({ core, host, port: flags.port, explicitPort: flags.portExplicit, previousPort: previous.port, preferredPorts: PREFERRED_PORTS[flags.channel], tailnet: !flags.hostExplicit });
    } catch (error) {
      try { core.logs.error(`The server could not listen on ${host}:${flags.port}: ${messageOf(error)}`, { source: 'startup', event: 'startup.listen-failed', data: { port: flags.port, explicitPort: flags.portExplicit } }); } catch { /* The refusal below still runs. */ }
      const deadline = setTimeout(() => { unlock(); refuseToStart(error); }, SHUTDOWN_TIMEOUT_MS);
      deadline.unref();
      void core.close()
        .catch(closeError => { try { core.log('error', `startup cleanup failed: ${messageOf(closeError)}`); } catch { /* the unlock below still runs */ } })
        .finally(() => {
          clearTimeout(deadline);
          unlock();
          refuseToStart(error);
        });
      return;
    }
    core.policy.start();
    core.updates.start();
    core.serverUpdates.start();
    if (core.cliDir === null) {
      console.warn('the boite CLI shim is not beside the core: agents started here cannot run `boite`. Copy `boite` next to the executable, or name its directory in BOITE_CLI_DIR');
    }
    if (!flags.hostExplicit) {
      core.log('info', `listening on ${host} because listenOnLan is ${core.settings.get().listenOnLan ? 'on' : 'off'}`);
    }

    // The shell tells this core from a later process that got its pid by this key.
    const startKey = processPlatform.startKey?.(process.pid) ?? null;
    const state: CoreFile = {
      port: server.port,
      host,
      token,
      pid: process.pid,
      startedAt: core.startedAt,
      ...(startKey === null ? {} : { startKey }),
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
        try { core.log('warn', 'second shutdown signal, exiting now', { source: 'core', event: 'core.shutdown.forced' }); } catch { /* Forced exit must not depend on logging. */ }
        process.exit(1);
      }
      stopping = true;
      const shutdownAt = performance.now();
      const step = (event: string, message: string, since: number): number => {
        const now = performance.now();
        try { core.logs.info(`${message} in ${Math.round(now - since)} ms`, { source: 'core', event, durationMs: now - since }); } catch { /* Shutdown goes on without its record. */ }
        return now;
      };
      const running = core.scheduler.state();
      // A log that throws must not keep the shutdown from arming its deadline.
      try {
        core.logs.info(`Shutdown started with ${running.running.length} running and ${running.queued.length} queued turns`, {
          source: 'core', event: 'core.shutdown.started', data: { running: running.running.length, queued: running.queued.length, exitCode: typeof process.exitCode === 'number' ? process.exitCode : null },
        });
      } catch { /* shutdown goes on */ }
      let stepAt = shutdownAt;
      // A driver that never answers its stop must not hold the process open, and
      // a rejection anywhere in the chain must not skip unlock() and the exit.
      const deadline = setTimeout(() => {
        try { core.log('error', `shutdown did not finish in ${SHUTDOWN_TIMEOUT_MS} ms, exiting`, { source: 'core', event: 'core.shutdown.timeout', durationMs: SHUTDOWN_TIMEOUT_MS }); } catch { /* The unlock and exit below still run. */ }
        unlock();
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      deadline.unref();
      void core
        .drain()
        .then(() => { stepAt = step('core.shutdown.drained', 'Running turns drained', stepAt); return server.stop(); })
        .then(() => { stepAt = step('core.shutdown.server-stopped', 'Server stopped', stepAt); return core.close(); })
        .catch((error: unknown) => {
          // A throw here would surface as an unhandled rejection after the exit is decided.
          try { core.log('error', `shutdown failed: ${messageOf(error)}`, { source: 'core', event: 'core.shutdown.failed', durationMs: performance.now() - shutdownAt }); } catch { /* the exit below still runs */ }
        })
        .finally(() => {
          clearTimeout(deadline);
          unlock();
          process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
        });
    };
    const signalled = (signal: string, next: string): void => {
      try { core.logs.info(`Received ${signal}: ${next}`, { source: 'core', event: 'core.signal', data: { signal } }); } catch { /* Logging must not block shutdown. */ }
    };
    process.on('SIGINT', () => { signalled('SIGINT', stopping ? 'exiting now' : 'shutting down'); shutdown(); });
    // What a service manager sends for a restart, an update or a reboot. The
    // first one hands the running turns to the next core: each ends its tool
    // call, 30 seconds at most, and resumes after the restart. A second one
    // stops them now, and they still resume. A third exits.
    let terms = 0;
    process.on('SIGTERM', () => {
      terms += 1;
      signalled('SIGTERM', stopping || terms > 2 ? 'shutting down now' : terms === 1 ? 'handing running turns to the next core' : 'stopping running turns');
      if (stopping || terms > 2) shutdown();
      else if (terms === 1) core.requestHandoffShutdown();
      else core.requestShutdown();
    });
    // The last line of defence: Bun exits on either anyway. This leaves a log
    // line, stops the turns and releases the lock on the way out; the process
    // never carries on after an error nobody expected.
    const fatal = (kind: string) => (error: unknown): void => {
      // A throw here would skip the shutdown and come back to this handler.
      try { core.log('error', `${kind}: ${messageOf(error)}`, { source: 'core', event: 'core.fatal', data: { kind, ...(error instanceof Error ? { name: error.name, stack: (error.stack ?? '').split('\n').slice(1, 4).map(line => line.trim()).join(' | ') } : {}) } }); } catch { /* Stderr and shutdown below still run. */ }
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
      if (!stopping) signalled('SIGHUP', 'the terminal closed, shutting down');
      if (!stopping) shutdown();
    });
  }, refuseToStart);
}

if (import.meta.main) main(process.argv.slice(2));
