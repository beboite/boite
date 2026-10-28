/*
 * Gateway plugins: a subscription gateway speaking Douane's runtime contract,
 * run by the core in the background. The core writes its configuration, picks
 * a loopback port, starts it with `--config <file>`, waits for `/health`, and
 * starts it again after a crash with the desktop apps' backoff. Its data lives
 * outside the plugin directory, so an uninstall keeps its sign-ins.
 * docs/plugins.md, Gateways, describes the contract.
 *
 * Whether the owner wants it running is `enabled`, and whether it starts with
 * the core is `autostart`, both kept in `gateway.json` beside `installed.json`,
 * as `app.json` is for a desktop app.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { freePort } from '../loopback-port.ts';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import type { PluginGatewayState } from '@boite/contracts';
import { stripAnsi } from '../ansi.ts';
import { messageOf } from '../errors.ts';
import { currentOs } from '../paths.ts';
import type { SpawnedProcess } from '../procs.ts';
import { CRASH_WINDOW_MS, RELAUNCH_DELAYS_MS, readRunChoice, writeRunChoice, type AppClock } from './apps.ts';

const GATEWAY_FILE = 'gateway.json';
/** Douane's own default port, taken when it is free. */
export const GATEWAY_PREFERRED_PORT = 8787;
/** The recommended gateway the subscription proxy's local mode points at. */
export const DOUANE_PLUGIN = 'douane';
/** A development or test executable run instead of the installed one. */
export const DOUANE_BINARY_ENV = 'BOITE_DOUANE_BINARY';
/** How long a start may take to answer `/health`. */
const READY_MS = 30_000;
/** How long an update waits for the requests in flight to end before it swaps anyway. */
const IDLE_WAIT_MS = 5 * 60_000;
const LOG_LINE_MAX = 500;

/** What the store hands the gateways: the core's parts they use and the installed plugin they run. */
export interface GatewayHost {
  procs: { spawn(threadId: string, cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; agentRoot: boolean }): SpawnedProcess; killTree(threadId: string): number };
  dataDir: string;
  log(level: 'info' | 'warn' | 'error', message: string, event: string): void;
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  /** The binary of an installed plugin providing a gateway, and its executable name, or null. */
  installed(id: string): { binary: string; executable: string } | null;
  /** Announces the plugin's state after a change. */
  changed(id: string): void;
  /** The gateway moved to another port: the proxy settings follow it. */
  moved(id: string, port: number): void;
}

const realClock: AppClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Where a gateway keeps its configuration, sign-ins and database: outside
 * `plugins/<id>/`, which an uninstall deletes. Douane keeps the folder it had
 * before it was a plugin; any other gateway gets one under `gateways/`.
 */
export function gatewayDataDir(dataDir: string, id: string): string {
  return id === DOUANE_PLUGIN ? join(dataDir, 'douane') : join(dataDir, 'gateways', id);
}

/** The core's environment minus every agent variable and the owner token: a gateway never talks to the core. */
export function gatewayEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const agent = new Set<string>(Object.values(AGENT_ENV));
  for (const name of Object.keys(base)) {
    const upper = name.toUpperCase();
    if (agent.has(upper) || upper.startsWith('BOITE_AGENT_') || upper === 'BOITE_TOKEN' || upper === 'BOITE_CORE_URL') env[name] = undefined;
  }
  return { ...env, NO_COLOR: '1', RUST_LOG_STYLE: 'never' };
}

/** A script runs with the Bun running the core: the tests' fake Douane, a checkout's development build. */
function launchOf(executable: string): [string, string[]] {
  return /\.(?:[cm]?[jt]s)$/i.test(executable) ? [process.execPath, [executable]] : [executable, []];
}

function configText(port: number): string {
  return [
    '# Written by Boite for the gateway it runs on this machine. Boite only rewrites `listen`.',
    '[server]',
    `listen = "127.0.0.1:${port}"`,
    'auth_dir = "auth"',
    'database = "douane.sqlite"',
    '',
  ].join('\n');
}

function portFree(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    probe.stop(true);
    return true;
  } catch { return false; }
}


interface Running {
  threadId: string;
  pid: number;
  exited: Promise<number>;
  /** Whether an exit schedules a relaunch; not while an update starts it, its caller puts the previous release back. */
  relaunch: boolean;
}

interface Entry {
  status: PluginGatewayState['status'];
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  startedAt: number | null;
  version: string | null;
  running: Running | null;
  crashes: number[];
  relaunch: unknown;
}

export class PluginGateways {
  clock: AppClock = realClock;
  /** Test seams. */
  readyMs = READY_MS;
  idleWaitMs = IDLE_WAIT_MS;
  idlePollMs = 1_000;
  relaunchDelaysMs: readonly number[] = RELAUNCH_DELAYS_MS;
  private entries = new Map<string, Entry>();
  private queues = new Map<string, Promise<void>>();
  private closing = false;

  constructor(private host: GatewayHost) {}

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = { status: 'stopped', pid: null, exitCode: null, error: null, startedAt: null, version: null, running: null, crashes: [], relaunch: null };
      this.entries.set(id, entry);
    }
    return entry;
  }

  dataDir(id: string): string {
    return gatewayDataDir(this.host.dataDir, id);
  }

  private portKey(id: string): string {
    return `gateway-port:${id}`;
  }

  /** The port it listens on, or will: the one remembered, Douane's default before any. */
  port(id: string): number {
    const stored = this.host.getSetting(this.portKey(id));
    return typeof stored === 'number' && Number.isSafeInteger(stored) && stored > 0 && stored < 65536 ? stored : GATEWAY_PREFERRED_PORT;
  }

  /** Whether the owner wants it running. A plugin directory with no `gateway.json` is a first install: yes. */
  enabled(pluginDir: string): boolean {
    return readRunChoice(join(pluginDir, GATEWAY_FILE)).enabled;
  }

  private async setEnabled(pluginDir: string, enabled: boolean): Promise<void> {
    await writeRunChoice(join(pluginDir, GATEWAY_FILE), { enabled });
  }

  /** `plugins.autostart`: whether the core starts the gateway when it starts. Running or not, it stays as it is. */
  setAutostart(id: string, pluginDir: string, autostart: boolean): Promise<void> {
    return this.serial(id, async () => {
      await writeRunChoice(join(pluginDir, GATEWAY_FILE), { autostart });
      this.host.changed(id);
    });
  }

  state(id: string, pluginDir: string): PluginGatewayState {
    const entry = this.entries.get(id);
    const { enabled, autostart } = readRunChoice(join(pluginDir, GATEWAY_FILE));
    return {
      enabled,
      autostart,
      status: entry?.status ?? 'stopped',
      port: this.port(id),
      version: entry?.running ? entry.version : null,
      pid: entry?.pid ?? null,
      exitCode: entry?.exitCode ?? null,
      error: entry?.error ?? null,
      startedAt: entry?.startedAt ?? null,
      dataDir: this.dataDir(id),
    };
  }

  /** Whether it answers right now. */
  running(id: string): boolean {
    return this.entries.get(id)?.status === 'running';
  }

  /** The program run: the development one for Douane when set, else `candidate` or the installed binary. */
  private executable(id: string, candidate?: { binary: string; executable: string }): { binary: string; executable: string } | null {
    const installed = candidate ?? this.host.installed(id);
    const development = id === DOUANE_PLUGIN ? process.env[DOUANE_BINARY_ENV] : undefined;
    if (installed !== null && development) return { binary: development, executable: installed.executable };
    return installed;
  }

  /** The remembered port when it is free, Douane's default next, any free one last; remembered, and the proxy told. */
  private choosePort(id: string): number {
    const remembered = this.port(id);
    let port = remembered;
    if (!portFree(port)) port = port !== GATEWAY_PREFERRED_PORT && portFree(GATEWAY_PREFERRED_PORT) ? GATEWAY_PREFERRED_PORT : freePort();
    if (this.host.getSetting(this.portKey(id)) !== port) this.host.setSetting(this.portKey(id), port);
    if (port !== remembered) this.host.log('info', `${id}: port ${remembered} is taken; it listens on ${port}`, 'gateway.port');
    this.host.moved(id, port);
    return port;
  }

  /**
   * Writes the configuration once, then only moves its `listen` line: Douane
   * saves its own settings into the same file. A release that renames the
   * executable starts from the file of the one it `replaces`, which stays for
   * a rollback to that release.
   */
  private writeConfig(id: string, executable: string, port: number, replaces: string | null): string {
    const dir = this.dataDir(id);
    mkdirSync(join(dir, 'auth'), { recursive: true });
    const file = join(dir, `${executable}.toml`);
    const previous = replaces === null || replaces === executable ? null : join(dir, `${replaces}.toml`);
    const source = existsSync(file) ? file : previous !== null && existsSync(previous) ? previous : null;
    if (source === null) writeFileSync(file, configText(port));
    else {
      const text = readFileSync(source, 'utf8');
      const listen = `listen = "127.0.0.1:${port}"`;
      const next = /^listen\s*=.*$/m.test(text) ? text.replace(/^listen\s*=.*$/m, listen) : text.replace(/^\[server\]\s*$/m, `[server]\n${listen}`);
      if (next !== text || source !== file) writeFileSync(file, next);
    }
    return file;
  }

  /**
   * A core that died without closing can leave its gateway running off
   * Windows, where no job takes it down. It holds the port and the database
   * the next one would open, so it is stopped first: only the process recorded
   * here, and only while its command line still names this configuration.
   */
  private async stopOrphan(id: string, config: string): Promise<void> {
    const file = join(this.dataDir(id), 'gateway.pid');
    let pid: unknown;
    try { pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid; }
    catch { return; }
    rmSync(file, { force: true });
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || currentOs() !== 'linux') return;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(config)) return;
      process.kill(pid, 'SIGTERM');
      for (let waited = 0; waited < 5_000 && existsSync(`/proc/${pid}`); waited += 50) await Bun.sleep(50);
      this.host.log('warn', `${id}: stopped pid ${pid}, left running by a previous core`, 'gateway.orphan-stopped');
    } catch { /* gone already */ }
  }

  /** Reads the stream line by line into the core log; Boite never sends a gateway's output to a client. */
  private async drain(id: string, stream: ReadableStream<Uint8Array>, last: { line: string }): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    const emit = (raw: string): void => {
      const line = stripAnsi(raw).trim().slice(0, LOG_LINE_MAX);
      if (!line) return;
      if (/\bERROR\b|error:/.test(line)) last.line = line.slice(0, 300);
      this.host.log(/\bERROR\b/.test(line) ? 'error' : /\bWARN\b/.test(line) ? 'warn' : 'info', `${id}: ${line}`, 'gateway.output');
    };
    try {
      for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (pending.length > 4096) pending = pending.slice(-4096);
        for (const line of lines) emit(line);
      }
    } catch { /* the process went away */ }
    if (pending) emit(pending);
  }

  /**
   * Starts the gateway unless it runs already or the core is closing, and
   * resolves once it answers `/health` (true) or failed to (false, with the
   * reason on its state and a relaunch scheduled like a crash). With
   * `relaunch` false a failure only leaves it `crashed`: a relaunch would
   * start it again while the caller reads why, and clear that reason.
   * `candidate` is the program an update tries before its record names it,
   * with the executable name of the release it `replaces`.
   */
  async launch(id: string, relaunch = true, candidate?: { binary: string; executable: string; replaces: string | null }): Promise<boolean> {
    if (this.closing) return false;
    const entry = this.entry(id);
    if (entry.running !== null) return entry.status === 'running';
    this.clock.clearTimeout(entry.relaunch);
    entry.relaunch = null;
    const program = this.executable(id, candidate);
    if (program === null) {
      Object.assign(entry, { status: 'stopped', error: null });
      this.host.changed(id);
      return false;
    }
    const config = join(this.dataDir(id), `${program.executable}.toml`);
    await this.stopOrphan(id, config);
    if (this.closing || entry.running !== null) return entry.status === 'running';
    const port = this.choosePort(id);
    this.writeConfig(id, program.executable, port, candidate?.replaces ?? null);
    const threadId = `plugin:${id}:gateway`;
    let spawned: SpawnedProcess;
    try {
      const [cmd, prefix] = launchOf(program.binary);
      spawned = this.host.procs.spawn(threadId, cmd, [...prefix, '--config', config], { cwd: this.dataDir(id), env: gatewayEnv(process.env), agentRoot: false });
    } catch (error) {
      Object.assign(entry, { status: 'crashed', error: `${id} could not start: ${messageOf(error)}` });
      this.host.log('warn', entry.error!, 'gateway.spawn-failed');
      this.host.changed(id);
      return false;
    }
    const last = { line: '' };
    void this.drain(id, spawned.proc.stdout, last);
    void this.drain(id, spawned.proc.stderr, last);
    const running: Running = { threadId, pid: spawned.record.pid, exited: spawned.exited, relaunch };
    Object.assign(entry, { status: 'starting', pid: running.pid, error: null, version: null, startedAt: this.clock.now(), running });
    try { writeFileSync(join(this.dataDir(id), 'gateway.pid'), `${JSON.stringify({ pid: running.pid, config })}\n`); } catch { /* only the orphan check reads it */ }
    let exitCode: number | null = null;
    void spawned.exited.then((code) => { exitCode = code; this.exited(id, running, code, last.line); });
    this.host.changed(id);
    const deadline = Date.now() + this.readyMs;
    while (Date.now() < deadline && entry.running === running && exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000), redirect: 'error' });
        const body = await response.json() as { status?: unknown; version?: unknown };
        if (response.ok && body.status === 'ok' && entry.running === running) {
          // Started: from here an exit is a crash like any other, relaunched.
          Object.assign(running, { relaunch: true });
          Object.assign(entry, { status: 'running', error: null, version: typeof body.version === 'string' && body.version ? body.version.slice(0, 80) : null });
          this.host.log('info', `${id} ${entry.version ?? ''} listens on 127.0.0.1:${port}`, 'gateway.started');
          this.host.changed(id);
          return true;
        }
      } catch { /* not listening yet */ }
      await Bun.sleep(100);
    }
    if (entry.running === running && exitCode === null) {
      // Alive and silent: stopped like a crash, so the backoff applies. The reason is set first, for `exited` to read.
      entry.error = `${id} did not answer /health within ${Math.round(this.readyMs / 1000)} s`;
      this.host.procs.killTree(threadId);
      await spawned.exited;
    }
    return false;
  }

  private exited(id: string, running: Running, code: number, lastError: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.running !== running) return;
    const silent = entry.status === 'starting' && entry.error?.includes('/health') === true;
    Object.assign(entry, { running: null, pid: null, startedAt: null, exitCode: code, version: null });
    rmSync(join(this.dataDir(id), 'gateway.pid'), { force: true });
    if (this.closing) return;
    if (code === 0 && !silent) {
      Object.assign(entry, { status: 'stopped', error: null, crashes: [] });
      this.host.changed(id);
      return;
    }
    const why = silent ? entry.error! : `${id} exited with code ${code}${lastError ? ` (${lastError})` : ''}`;
    if (!running.relaunch) {
      Object.assign(entry, { status: 'crashed', error: why });
      this.host.log('warn', why, 'gateway.start-failed');
      this.host.changed(id);
      return;
    }
    const now = this.clock.now();
    entry.crashes = [...entry.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const delay = this.relaunchDelaysMs[entry.crashes.length - 1];
    if (delay === undefined) {
      entry.status = 'crashed';
      entry.error = `${why}; it failed ${entry.crashes.length} times in ${CRASH_WINDOW_MS / 60_000} minutes. Start it again from Settings > Plugins.`;
      this.host.log('warn', entry.error, 'gateway.crashed');
    } else {
      entry.status = 'starting';
      entry.error = `${why}; starting it again in ${delay / 1000} s.`;
      this.host.log('info', entry.error, 'gateway.exited');
      entry.relaunch = this.clock.setTimeout(() => { entry.relaunch = null; void this.launch(id); }, delay);
    }
    this.host.changed(id);
  }

  /** Kills the gateway and waits for it, leaving status `stopped`. */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.clock.clearTimeout(entry.relaunch);
    entry.relaunch = null;
    const running = entry.running;
    Object.assign(entry, { running: null, pid: null, startedAt: null, status: 'stopped', error: null, version: null });
    if (running !== null) {
      this.host.procs.killTree(running.threadId);
      entry.exitCode = await running.exited;
      rmSync(join(this.dataDir(id), 'gateway.pid'), { force: true });
    }
    this.host.changed(id);
  }

  /** `plugins.app` on a gateway: start enables and launches, stop disables and kills, restart does both. */
  control(id: string, pluginDir: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    return this.serial(id, async () => {
      if (action === 'stop') {
        await this.setEnabled(pluginDir, false);
        await this.kill(id);
        return;
      }
      await this.setEnabled(pluginDir, true);
      if (action === 'restart') await this.kill(id);
      this.entry(id).crashes = [];
      await this.launch(id);
    });
  }

  private serial(id: string, work: () => Promise<void>): Promise<void> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return run;
  }

  /** At core start, launches the gateway if it starts with the core; after an install, if the owner left it enabled. */
  resume(id: string, pluginDir: string, atStart = false): void {
    const choice = readRunChoice(join(pluginDir, GATEWAY_FILE));
    if (!(atStart ? choice.autostart : choice.enabled)) return;
    const entry = this.entry(id);
    if (entry.running !== null || entry.relaunch !== null) return;
    entry.crashes = [];
    void this.serial(id, async () => { await this.launch(id); });
  }

  /**
   * Before an update replaces the binary: waits until the gateway serves no
   * request (`in_flight` 0 on `/admin/api/summary`), bounded, then stops it.
   * Returns whether it ran, so the update starts the new release after.
   */
  async drainForUpdate(id: string, version: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry?.running == null) return false;
    entry.status = 'updating';
    entry.error = `${id} ${version} starts once the requests in flight end`;
    this.host.changed(id);
    const deadline = Date.now() + this.idleWaitMs;
    while (Date.now() < deadline && entry.running !== null && !this.closing) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port(id)}/admin/api/summary`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
        const body = await response.json() as { in_flight?: unknown };
        if (response.ok && body.in_flight === 0) break;
      } catch { /* read again */ }
      await Bun.sleep(this.idlePollMs);
    }
    if (Date.now() >= deadline) this.host.log('warn', `${id}: requests still in flight after ${Math.round(this.idleWaitMs / 60_000)} minutes; updating anyway`, 'gateway.update-busy');
    await this.kill(id);
    return true;
  }

  /** Before an uninstall deletes the binary. */
  forget(id: string): Promise<void> {
    return this.serial(id, async () => {
      await this.kill(id);
      this.entries.delete(id);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.entries.keys()].map((id) => this.kill(id)));
  }
}
