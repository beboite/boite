/*
 * `boite desktop`'s core half: one private virtual desktop per conversation on
 * a Linux machine. Xvfb draws in memory, openbox manages the windows (without
 * a window manager agent-desktop proves no window), a D-Bus session of its own
 * carries the accessibility bus, and the apps an agent starts there outlive
 * its turn. The user's screen, session bus and sound are never reached.
 * agent-desktop itself runs from the agent's shell with the environment this
 * returns (desktop-cli.ts). See docs/desktop.md.
 */
import {
  VIRTUAL_DESKTOP_APPS_MAX,
  VIRTUAL_DESKTOP_SIZE,
  virtualDesktopCommandError,
  virtualDesktopSizeError,
  type RpcParams,
  type RpcResult,
  type ThreadSummary,
  type VirtualDesktopApp,
  type VirtualDesktopSession,
  type VirtualDesktopSupport,
} from '@boite/contracts';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import type { SpawnedProcess } from '../process-spawn-types.ts';
import type { Connection } from '../router.ts';
import { DESKTOP_MARK, DESKTOP_XDG_DIRS, desktopEnv, withDesktopEnv } from './env.ts';
import { runCommand } from '../run-command.ts';

const SCOPE = 'system:desktop';
const START_TIMEOUT_MS = 15_000;
/** How long `desktop.run` waits to report a program that exits at once. */
const EARLY_EXIT_MS = 1_000;
const APP_LOG_BYTES = 1024 * 1024;
const READY = 'boite-desktop-ready';
/** Where distributions put the accessibility bus launcher, which is not on PATH. */
const ATSPI_LAUNCHERS = ['/usr/libexec/at-spi-bus-launcher', '/usr/lib/at-spi2-core/at-spi-bus-launcher', '/usr/lib/at-spi-bus-launcher', '/usr/lib64/at-spi-bus-launcher'];
export interface DesktopTools {
  xvfb: string;
  dbus: string;
  atspi: string;
  openbox: string;
  /** Optional: the accessibility bus is waited on through it, else for a moment. */
  dbusSend: string | null;
}

/** The programs a desktop needs, or what is missing, by package name. */
export function findDesktopTools(platform = process.platform, which: (name: string) => string | null = name => Bun.which(name), exists: (path: string) => boolean = existsSync): DesktopTools | VirtualDesktopSupport {
  if (platform !== 'linux') {
    return { available: false, reason: 'a virtual desktop needs Linux (Xvfb); on Windows and macOS agent-desktop would act on the user\'s own session, which Boite does not offer' };
  }
  const xvfb = which('Xvfb'), dbus = which('dbus-daemon'), openbox = which('openbox');
  const atspi = ATSPI_LAUNCHERS.find(exists) ?? null;
  const missing = [xvfb ? null : 'xvfb', dbus ? null : 'dbus-daemon', atspi ? null : 'at-spi2-core', openbox ? null : 'openbox'].filter((name): name is string => name !== null);
  if (missing.length > 0) return { available: false, reason: `missing ${missing.join(', ')}: install them with the system's package manager (apt install ${missing.join(' ')})`, missing };
  return { xvfb: xvfb!, dbus: dbus!, atspi: atspi!, openbox: openbox!, dbusSend: which('dbus-send') };
}

const isTools = (value: DesktopTools | VirtualDesktopSupport): value is DesktopTools => 'xvfb' in value;

/**
 * An Xauthority file holding one MIT-MAGIC-COOKIE-1 for any address and
 * display, as libXau reads it: without a cookie any local account could open
 * the display and read or type into its apps.
 */
export function xauthority(cookie: Uint8Array): Buffer {
  const field = (bytes: Uint8Array) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([family, field(new Uint8Array()), field(new Uint8Array()), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

/**
 * The desktop's session bus: the standard session policy, listening in the
 * desktop's folder, with no service directory. Nothing starts on demand, so a
 * keyring that wants a new password, a portal or a notifier never opens a
 * window over the agent's app; the accessibility bus is started by the core.
 */
export function busConfig(dir: string): string {
  const escaped = dir.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${escaped}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;
}

/** The first line of `stream` that `accept` turns into a value, before the process exits or time runs out. */
async function firstLine<T>(stream: ReadableStream<Uint8Array>, accept: (line: string) => T | null, exited: Promise<number>, what: string, timeoutMs: number): Promise<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '', timer: ReturnType<typeof setTimeout> | undefined;
  const lines = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`${what} closed its output before it was ready`);
      text += decoder.decode(value, { stream: true });
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n')) {
        const found = accept(text.slice(0, end).trim());
        text = text.slice(end + 1);
        if (found !== null) return found;
      }
    }
  })();
  try {
    return await Promise.race([
      lines,
      exited.then(code => { throw new Error(`${what} exited with code ${code} before it was ready`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} was not ready after ${timeoutMs / 1000} s`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    // A read still pending (the process died first) keeps the lock; the stop that follows closes the pipe.
    try { reader.releaseLock(); } catch { /* still reading */ }
  }
}

/** Reads a pipe to its end so the program never blocks on it, keeping the first `APP_LOG_BYTES` in `path`. */
function drainTo(stream: ReadableStream<Uint8Array>, path: string | null, budget: { left: number }): void {
  void (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (path && budget.left > 0) {
          const kept = value.subarray(0, budget.left);
          budget.left -= kept.length;
          try { appendFileSync(path, kept); } catch { budget.left = 0; }
        }
      }
    } catch {
      // The process is gone.
    }
  })();
}

/** Linux: the processes whose environment carries `mark`, which left the group a stop reaches. */
export function markedProcesses(mark: string, proc = '/proc'): number[] {
  const needle = Buffer.from(`\0${DESKTOP_MARK}=${mark}\0`);
  const found: number[] = [];
  let entries: string[];
  try { entries = readdirSync(proc); } catch { return found; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const environ = Buffer.concat([Buffer.from([0]), readFileSync(join(proc, entry, 'environ'))]);
      if (environ.includes(needle)) found.push(Number(entry));
    } catch {
      // Gone, or another account's.
    }
  }
  return found;
}

interface Running {
  app: VirtualDesktopApp;
  spawned: SpawnedProcess;
}

interface Session {
  id: string;
  dir: string;
  display: string;
  width: number;
  height: number;
  startedAt: number;
  env: Record<string, string>;
  /** The stack in start order: Xvfb, D-Bus, the accessibility bus, openbox. */
  stack: SpawnedProcess[];
  apps: Running[];
  stopping: boolean;
  /** The one teardown every stop of this desktop waits for. */
  stopped?: Promise<void>;
}

/** A desktop being started: an archive or the core stopping meanwhile cancels it before it is published. */
interface Starting {
  promise: Promise<Session>;
  cancelled: boolean;
  /** What it launched so far, stopped at once on a cancel so no wait for readiness holds it up. */
  stack: SpawnedProcess[];
}

const CANCELLED = 'its conversation was archived or Boite is stopping';

export interface VirtualDesktopsOptions {
  tools?: () => DesktopTools | VirtualDesktopSupport;
  tempRoot?: string;
}

export class VirtualDesktops {
  readonly #core: Core;
  readonly #tools: () => DesktopTools | VirtualDesktopSupport;
  readonly #tempRoot: string;
  readonly #sessions = new Map<string, Session>();
  /** One start per conversation, shared by the calls that arrive meanwhile. */
  readonly #starting = new Map<string, Starting>();
  readonly #stops = new Set<Promise<void>>();
  /** The core is stopping: no desktop starts any more. */
  #closed = false;

  constructor(core: Core, options: VirtualDesktopsOptions = {}) {
    this.#core = core;
    this.#tools = options.tools ?? (() => findDesktopTools());
    this.#tempRoot = options.tempRoot ?? tmpdir();
  }

  status({ threadId }: RpcParams<'desktop.status'>, connection?: Connection): RpcResult<'desktop.status'> {
    this.#thread(threadId, connection, true);
    const tools = this.#tools();
    const session = this.#sessions.get(threadId);
    return { support: isTools(tools) ? { available: true } : tools, session: session ? this.#describe(session) : null };
  }

  async start({ threadId, width, height }: RpcParams<'desktop.start'>, connection?: Connection): Promise<RpcResult<'desktop.start'>> {
    const problem = virtualDesktopSizeError(width, height);
    if (problem) throw invalidParams(problem, { width, height });
    const session = await this.#session(this.#thread(threadId, connection), width, height);
    return { session: this.#describe(session) };
  }

  async run({ threadId, command, cwd }: RpcParams<'desktop.run'>, connection?: Connection): Promise<RpcResult<'desktop.run'>> {
    const problem = virtualDesktopCommandError(command);
    if (problem) throw invalidParams(problem, { field: 'command' });
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !isDirectory(cwd)) throw invalidParams('cwd: expected the absolute path of an existing folder', { field: 'cwd' });
    const session = await this.#session(this.#thread(threadId, connection));
    if (session.stopping) throw refused('the desktop is stopping', { threadId });
    const [program, ...args] = command;
    const log = join(session.dir, 'logs', `${Date.now()}-${session.apps.length}.log`);
    let spawned: SpawnedProcess;
    try {
      spawned = this.#core.procs.spawn(SCOPE, program!, args, { agentRoot: false, cwd, env: withDesktopEnv(process.env, session.env) });
    } catch (error) {
      throw refused(`${program} did not start: ${messageOf(error)}`, { threadId });
    }
    writeFileSync(log, '', { mode: 0o600 });
    const budget = { left: APP_LOG_BYTES };
    drainTo(spawned.proc.stdout, log, budget);
    drainTo(spawned.proc.stderr, log, budget);
    const app: VirtualDesktopApp = { pid: spawned.record.pid, command: command.join(' ').slice(0, 200), startedAt: Date.now(), exitCode: null, log };
    session.apps.push({ app, spawned });
    void spawned.exited.then(code => { app.exitCode = code; });
    this.#forgetOldApps(session);
    this.#core.logs.info(`Started a program on virtual desktop ${session.display}`, { source: 'desktop', event: 'desktop.run', threadId, data: { display: session.display, pid: app.pid } });
    await Promise.race([spawned.exited, Bun.sleep(EARLY_EXIT_MS)]);
    return { app: { ...app }, session: this.#describe(session) };
  }

  async stop({ threadId }: RpcParams<'desktop.stop'>, connection?: Connection): Promise<RpcResult<'desktop.stop'>> {
    this.#thread(threadId, connection, true);
    await this.#starting.get(threadId)?.promise.catch(() => {});
    const session = this.#sessions.get(threadId);
    if (!session) return { stopped: false };
    await this.#teardown(threadId, session, 'asked');
    return { stopped: true };
  }

  /** An archived or removed conversation: its desktop goes, and one still starting never opens, without waiting. */
  release(threadId: string): void {
    const starting = this.#starting.get(threadId);
    if (starting) this.#cancel(starting);
    const session = this.#sessions.get(threadId);
    if (session) this.#track(this.#teardown(threadId, session, 'its conversation was archived'));
  }

  /** The core stops: every desktop with it, those still starting included. */
  async stopAll(): Promise<void> {
    this.#closed = true;
    const starting = [...this.#starting.values()];
    for (const start of starting) this.#cancel(start);
    await Promise.allSettled(starting.map(start => start.promise));
    for (const [threadId, session] of this.#sessions) this.#track(this.#teardown(threadId, session, 'Boite stopped'));
    await Promise.allSettled([...this.#stops]);
  }

  /** The start fails as soon as the part it waits on exits; its catch then clears what remains. */
  #cancel(starting: Starting): void {
    starting.cancelled = true;
    for (const part of starting.stack) void part.stop().catch(() => {});
  }

  #track(stop: Promise<void>): void {
    this.#stops.add(stop);
    void stop.finally(() => this.#stops.delete(stop));
  }

  #thread(threadId: string, connection?: Connection, allowArchived = false): ThreadSummary {
    const thread = this.#core.threads.require(threadId);
    if (thread.archived && !allowArchived) throw refused('a virtual desktop needs an active conversation', { threadId });
    if (connection?.identity.principal === 'session' && !connection.subscriptions.has(threadId)) {
      throw refused('subscribe to the conversation before using its desktop', { threadId });
    }
    return thread;
  }

  #describe(session: Session): VirtualDesktopSession {
    return {
      display: session.display,
      width: session.width,
      height: session.height,
      startedAt: session.startedAt,
      env: { ...session.env },
      apps: session.apps.map(({ app }) => ({ ...app })),
    };
  }

  #forgetOldApps(session: Session): void {
    while (session.apps.length > VIRTUAL_DESKTOP_APPS_MAX) {
      const at = session.apps.findIndex(({ app }) => app.exitCode !== null);
      if (at === -1) return;
      session.apps.splice(at, 1);
    }
  }

  async #session(thread: ThreadSummary, width?: number, height?: number): Promise<Session> {
    const open = this.#sessions.get(thread.id);
    if (open && !open.stopping) return open;
    if (this.#core.procs.protection.policy(thread.id)) {
      throw refused('this conversation runs under execution protection: what its desktop starts would run outside it', { threadId: thread.id });
    }
    if (this.#closed) throw refused('Boite is stopping', { threadId: thread.id });
    const pending = this.#starting.get(thread.id);
    if (pending) return pending.promise;
    const tools = this.#tools();
    if (!isTools(tools)) throw refused(`no virtual desktop on this machine: ${tools.reason}`, { threadId: thread.id, missing: tools.missing });
    const starting = { cancelled: false, stack: [] } as unknown as Starting;
    starting.promise = this.#launch(thread.id, tools, width ?? VIRTUAL_DESKTOP_SIZE.defaultWidth, height ?? VIRTUAL_DESKTOP_SIZE.defaultHeight, starting)
      .finally(() => { if (this.#starting.get(thread.id) === starting) this.#starting.delete(thread.id); });
    this.#starting.set(thread.id, starting);
    return starting.promise;
  }

  async #launch(threadId: string, tools: DesktopTools, width: number, height: number, starting: Starting): Promise<Session> {
    const dir = await mkdtemp(join(this.#tempRoot, 'boite-desktop-'));
    const id = randomBytes(12).toString('hex');
    const stack = starting.stack;
    const spawn = (command: string, args: string[], env: Record<string, string | undefined>) => {
      if (starting.cancelled) throw new Error(CANCELLED);
      const spawned = this.#core.procs.spawn(SCOPE, command, args, { agentRoot: false, cwd: dir, env });
      stack.push(spawned);
      return spawned;
    };
    try {
      for (const sub of ['agent-desktop', 'logs', ...DESKTOP_XDG_DIRS]) mkdirSync(join(dir, sub), { mode: 0o700 });
      writeFileSync(join(dir, 'Xauthority'), xauthority(randomBytes(16)), { mode: 0o600 });
      writeFileSync(join(dir, 'bus.conf'), busConfig(dir), { mode: 0o600 });
      const base = withDesktopEnv(process.env, { ...desktopEnv(dir, '', '', id), DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '' });

      // -displayfd picks a free display and prints its number once it accepts clients.
      const xvfb = spawn(tools.xvfb, ['-displayfd', '1', '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-auth', join(dir, 'Xauthority')], base);
      drainTo(xvfb.proc.stderr, null, { left: 0 });
      const display = `:${await firstLine(xvfb.proc.stdout, line => /^\d+$/.test(line) ? line : null, xvfb.exited, 'Xvfb', START_TIMEOUT_MS)}`;
      drainTo(xvfb.proc.stdout, null, { left: 0 });

      const bus = spawn(tools.dbus, [`--config-file=${join(dir, 'bus.conf')}`, '--nofork', '--print-address=1'], { ...base, DISPLAY: display });
      drainTo(bus.proc.stderr, null, { left: 0 });
      const address = await firstLine(bus.proc.stdout, line => line.startsWith('unix:') ? line : null, bus.exited, 'dbus-daemon', START_TIMEOUT_MS);
      drainTo(bus.proc.stdout, null, { left: 0 });

      const env = desktopEnv(dir, display, address, id);
      const full = withDesktopEnv(process.env, env);
      const atspi = spawn(tools.atspi, ['--launch-immediately'], full);
      drainTo(atspi.proc.stdout, null, { left: 0 });
      drainTo(atspi.proc.stderr, null, { left: 0 });
      await this.#accessibilityBus(tools, full, starting);

      // openbox runs its --startup command once it manages the screen.
      const openbox = spawn(tools.openbox, ['--sm-disable', '--startup', `echo ${READY}`], full);
      drainTo(openbox.proc.stderr, null, { left: 0 });
      await firstLine(openbox.proc.stdout, line => line === READY ? true : null, openbox.exited, 'openbox', START_TIMEOUT_MS);
      drainTo(openbox.proc.stdout, null, { left: 0 });

      // Archived, removed or the core stopping while it started: it is not published, and the catch below stops it.
      if (starting.cancelled || this.#closed || this.#core.threads.require(threadId).archived) throw new Error(CANCELLED);
      const session: Session = { id, dir, display, width, height, startedAt: Date.now(), env, stack, apps: [], stopping: false };
      this.#sessions.set(threadId, session);
      // The display, the bus or the window manager gone takes the desktop with it.
      for (const part of stack) void part.exited.then(() => { if (this.#sessions.get(threadId) === session && !session.stopping) this.#track(this.#teardown(threadId, session, 'a part of it exited')); });
      this.#core.logs.info(`Started virtual desktop ${display} at ${width}x${height}`, { source: 'desktop', event: 'desktop.start', threadId, data: { display, width, height } });
      return session;
    } catch (error) {
      await this.#kill(stack, [], id, dir);
      // A cancel shows up as a part that exited before it was ready: say why it really stopped.
      throw refused(`the virtual desktop did not start: ${starting.cancelled || this.#closed ? CANCELLED : messageOf(error)}`, { threadId });
    }
  }

  /** Waits until the accessibility bus answers on the session bus, so the first app finds it. */
  async #accessibilityBus(tools: DesktopTools, env: Record<string, string | undefined>, starting: Starting): Promise<void> {
    if (!tools.dbusSend) { await Bun.sleep(500); return; }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (starting.cancelled) throw new Error(CANCELLED);
      const run = await runCommand(this.#core.procs, SCOPE, tools.dbusSend, [
        '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.a11y.Bus',
      ], 2_000, { env });
      if (new TextDecoder().decode(run.stdout).includes('boolean true')) return;
      await Bun.sleep(100);
    }
    throw new Error('the accessibility bus did not answer within 5 s');
  }

  #teardown(threadId: string, session: Session, why: string): Promise<void> {
    session.stopping = true;
    session.stopped ??= (async () => {
      await this.#kill(session.stack, session.apps.map(({ spawned }) => spawned), session.id, session.dir);
      if (this.#sessions.get(threadId) === session) this.#sessions.delete(threadId);
      this.#core.logs.info(`Stopped virtual desktop ${session.display}: ${why}`, { source: 'desktop', event: 'desktop.stop', threadId, data: { display: session.display } });
    })();
    return session.stopped;
  }

  /** Apps first, then the stack from the top, then whatever carries the mark, then the folder. */
  async #kill(stack: SpawnedProcess[], apps: SpawnedProcess[], id: string, dir: string): Promise<void> {
    await Promise.allSettled(apps.map(app => app.stop()));
    for (const part of [...stack].reverse()) await part.stop().catch(() => {});
    if (process.platform === 'linux') {
      for (const pid of markedProcesses(id)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
