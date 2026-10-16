import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalDouaneStatus, ProviderInstall, ProviderInstallState, SubscriptionProxy } from '@boite/contracts';
import { stripAnsi } from './ansi.ts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';
import { InstallManager } from './providers/install.ts';
import { compareVersions, fetchText, INSTALL_LATEST_MAX_AGE_MS, resolveLatestInstall, type FetchText } from './providers/install-latest.ts';
import { pointCurrent } from './providers/install-release.ts';
import type { SpawnedProcess } from './procs.ts';

/** A development or test executable used instead of a downloaded release. */
export const DOUANE_BINARY_ENV = 'BOITE_DOUANE_BINARY';
/** Douane's own default port, taken when it is free. */
export const DOUANE_PREFERRED_PORT = 8787;
/** The install's name in its manager, and the trace scope of its process. */
const ID = 'douane';
const SCOPE = 'system:douane';
const PORT_SETTING = 'douane-local-port';
const RELEASES = 'https://github.com/beboite/douane/releases';
/** The waits before each start again after a crash; the last one repeats. */
export const RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
/** A run that stayed up this long was no crash loop: the next crash waits the first delay again. */
const STABLE_MS = 60_000;
/** How long a start may take to answer `/health`. */
const READY_MS = 30_000;
/** How long an update waits for the requests in flight to end before leaving the swap to the next start. */
const IDLE_WAIT_MS = 15 * 60_000;
const LOG_LINE_MAX = 500;

/** The manifest's key and binary for this machine, or null where Douane ships none. */
export function douanePlatform(platform: string = process.platform, arch: string = process.arch): { key: string; binary: string } | null {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (os === null || cpu === null || (os === 'windows' && cpu !== 'x64')) return null;
  const key = `${os}-${cpu}`;
  return { key, binary: `douane-${key}${os === 'windows' ? '.exe' : ''}` };
}

/**
 * The install block Douane's releases are read through: a `binary` install
 * that follows its publisher, as Claude's does. The pinned fields are never
 * used, since nothing installs before the publisher named a release.
 */
export function douaneInstall(target: { key: string; binary: string }, releases = RELEASES): ProviderInstall {
  return {
    version: '0.0.0', format: 'binary', url: `${releases}/download/v0.0.0/${target.binary}`, sha256: '0'.repeat(64), archiveBytes: 1,
    files: [{ path: target.binary, bytes: 1, executable: true }],
    latest: {
      versionUrl: `${releases}/latest/download/VERSION`,
      manifest: `${releases}/download/v{version}/manifest.json`,
      platform: target.key,
      url: `${releases}/download/v{version}/${target.binary}`,
    },
  };
}

/**
 * The publisher has no such release yet, or none for this machine: GitHub
 * answers 404 for `latest` before the first release and for an asset a
 * release lacks, and a manifest can leave a platform out.
 */
function unpublished(error: unknown): boolean {
  return / answered 404$|has no \S+ entry$/.test(messageOf(error));
}

/** A script runs with the Bun running the core: the tests' fake Douane, a checkout's development build. */
function launchOf(executable: string): [string, string[]] {
  return /\.(?:[cm]?[jt]s)$/i.test(executable) ? [process.execPath, [executable]] : [executable, []];
}

export function localProxyUrls(port: number): Pick<SubscriptionProxy, 'baseUrl' | 'dashboardUrl'> {
  return { baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/admin/` };
}

function configText(port: number): string {
  return [
    '# Written by Boite for the Douane it runs on this machine. Boite only rewrites `listen`.',
    '[server]',
    `listen = "127.0.0.1:${port}"`,
    'auth_dir = "auth"',
    'database = "douane.sqlite"',
    '',
  ].join('\n');
}

async function portFree(port: number): Promise<boolean> {
  try {
    const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    probe.stop(true);
    return true;
  } catch { return false; }
}

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

interface Child {
  spawned: SpawnedProcess;
  version: string | null;
  startedAt: number;
  /** Set before a stop the core asked for, so the exit is not read as a crash. */
  stopping: boolean;
}

type State = LocalDouaneStatus['state'];

/**
 * Douane on this machine, for the subscription proxy's local mode. The core
 * installs it from Douane's releases (checked against the manifest's SHA-256
 * and size), writes its configuration under `<dataDir>/douane/`, runs it on a
 * loopback port as a child of its own (traced as `system:douane`), restarts it
 * with a growing delay after a crash and swaps in a newer release once it
 * serves no request. Its accounts and database stay when the mode is turned
 * off; nothing here deletes `auth/`.
 */
export class LocalDouane {
  readonly dir: string;
  readonly installs: InstallManager;
  /** Test seams. */
  readRelease: FetchText = fetchText;
  releases = RELEASES;
  readyMs = READY_MS;
  restartDelaysMs: readonly number[] = RESTART_DELAYS_MS;
  idleWaitMs = IDLE_WAIT_MS;
  idlePollMs = 1_000;

  #state: State = 'off';
  #message: string | undefined;
  #restartAt: number | undefined;
  #progress: LocalDouaneStatus['progress'];
  #child: Child | null = null;
  #crashes = 0;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stop pressed: nothing starts it again before Start or the next core start. */
  #held = false;
  #latest: ProviderInstall | null = null;
  #latestAt = 0;
  #checking: Promise<void> | null = null;
  #updating = false;
  #closed = false;
  /** One start, stop or swap at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly core: Core) {
    this.dir = join(core.dataDir, 'douane');
    this.installs = new InstallManager(core.dataDir, () => join(this.dir, 'program'));
    this.installs.attach({
      emit: (state) => this.#installProgress(state),
      updated: () => {},
      log: (level, message) => this.core.logs.record(level, `Douane install: ${message}`, { source: 'douane', event: 'douane.install' }),
    });
  }

  // -- reading --------------------------------------------------------------

  get development(): string | null {
    const path = process.env[DOUANE_BINARY_ENV];
    return path ? path : null;
  }

  /** Whether the settings ask for Douane on this machine. */
  wanted(): boolean {
    return this.core.settings.get().subscriptionProxy?.mode === 'local';
  }

  /** The port it listens on, or will: the one remembered, Douane's own default before any. */
  port(): number {
    const stored = this.core.journal.getSetting(PORT_SETTING);
    return typeof stored === 'number' && Number.isSafeInteger(stored) && stored > 0 && stored < 65536 ? stored : DOUANE_PREFERRED_PORT;
  }

  installedVersion(): string | null {
    return this.installs.installedVersion(ID);
  }

  status(): LocalDouaneStatus {
    const development = this.development !== null;
    const version = this.#child?.version ?? (development ? null : this.installedVersion());
    const latest = development ? null : this.#latest?.version ?? null;
    const available = latest !== null && version !== null && compareVersions(latest, version) > 0 ? latest : null;
    return {
      state: this.#state, version, available, port: this.port(),
      ...(this.#progress ? { progress: this.#progress } : {}),
      ...(this.#message ? { message: this.#message } : {}),
      ...(this.#restartAt ? { restartAt: this.#restartAt } : {}),
      ...(development ? { development: true } : {}),
    };
  }

  /**
   * The proxy settings in local mode as they are stored: Douane's kind and
   * this core's loopback URLs, whatever the client sent for them.
   */
  localProxy(proxy: SubscriptionProxy): SubscriptionProxy {
    return { ...proxy, kind: 'douane', mode: 'local', ...localProxyUrls(this.port()) };
  }

  // -- lifecycle ------------------------------------------------------------

  /** Core start: runs Douane when the settings ask for it. */
  start(): void {
    if (this.wanted()) void this.#ensure();
  }

  /** After every settings change: the mode turned on starts it, turned off stops it. */
  settingsChanged(): void {
    if (this.#closed) return;
    if (this.wanted()) {
      if (!this.#held && this.#child === null && this.#restartTimer === null) void this.#ensure();
      else if (this.#state === 'off') this.#set('stopped');
      return;
    }
    this.#held = false;
    this.#cancelRestart();
    this.#latest = null;
    void this.#serial(async () => {
      await this.#stopChild();
      this.#progress = undefined;
      this.#set('off');
    });
  }

  async userStart(): Promise<LocalDouaneStatus> {
    if (!this.wanted()) throw refused('Douane runs on this machine only in the subscription proxy\'s local mode', { field: 'subscriptionProxy.mode', expected: 'local' });
    this.#held = false;
    this.#cancelRestart();
    this.#crashes = 0;
    await this.#ensure();
    return this.status();
  }

  async userStop(): Promise<LocalDouaneStatus> {
    if (!this.wanted()) return this.status();
    this.#held = true;
    this.#cancelRestart();
    await this.#serial(async () => {
      await this.#stopChild();
      this.#set('stopped');
    });
    return this.status();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelRestart();
    this.installs.stop();
    await this.#stopChild();
  }

  // -- releases -------------------------------------------------------------

  /** Reads the newest release. A release not published yet reads as `unavailable` while nothing is installed. */
  async check(): Promise<LocalDouaneStatus> {
    if (this.development !== null || !this.wanted()) return this.status();
    await this.#readLatest(true);
    // A release published since the last try installs now.
    if (this.#latest !== null && this.#child === null && !this.#held && this.#restartTimer === null
      && (this.#state === 'unavailable' || this.#state === 'failed')) void this.#ensure();
    return this.status();
  }

  async #readLatest(force: boolean): Promise<ProviderInstall | null> {
    if (!force && this.#latest !== null && Date.now() - this.#latestAt < INSTALL_LATEST_MAX_AGE_MS) return this.#latest;
    const target = douanePlatform();
    if (target === null) {
      this.#set('unavailable', `Douane publishes no release for ${process.platform} ${process.arch}`);
      return null;
    }
    this.#checking ??= (async () => {
      try {
        this.#latest = await resolveLatestInstall(douaneInstall(target, this.releases), this.readRelease);
        this.#latestAt = Date.now();
      } catch (error) {
        this.#latest = null;
        this.core.logs.warn(`Douane release check: ${messageOf(error)}`, { source: 'douane', event: 'douane.check-failed' });
        if (this.installedVersion() === null && this.#child === null) {
          this.#set(unpublished(error) ? 'unavailable' : 'failed', unpublished(error)
            ? `Douane has no release for this machine (${target.key}) yet`
            : `Could not read Douane's releases: ${messageOf(error)}`);
        }
      } finally {
        this.#emit();
      }
    })().finally(() => { this.#checking = null; });
    await this.#checking;
    return this.#latest;
  }

  /** Starts the newer release's install; the swap waits for Douane to serve no request. */
  async update(): Promise<LocalDouaneStatus> {
    if (this.development !== null) throw refused(`${DOUANE_BINARY_ENV} runs a development Douane, which Boite does not update`);
    if (!this.wanted()) throw refused('Douane runs on this machine only in the subscription proxy\'s local mode', { field: 'subscriptionProxy.mode', expected: 'local' });
    if (this.#updating) return this.status();
    const latest = await this.#readLatest(false);
    const installed = this.installedVersion();
    if (latest === null) throw refused(this.#message ?? 'Douane\'s newest release could not be read');
    if (installed !== null && compareVersions(latest.version, installed) <= 0) throw refused(`Douane is up to date on ${installed}`, { version: installed });
    this.#updating = true;
    void this.#serial(() => this.#swap(latest)).finally(() => {
      this.#updating = false;
      this.#emit();
    });
    return this.status();
  }

  async #swap(install: ProviderInstall): Promise<void> {
    const previousVersion = this.installedVersion();
    let previousDir: string | null = null;
    try { previousDir = realpathSync(this.installs.currentDir(ID)); } catch { /* first install */ }
    // Held through the swap, so the release that runs now stays on disk until the new one answers;
    // the release ends with the swap, and the one `current` left behind is pruned then.
    this.installs.acquire(ID);
    try {
      if (this.#child !== null) this.#set('updating', `Downloading Douane ${install.version}`);
      if (!await this.#install(install)) {
        // The release that ran keeps running.
        if (this.#child !== null) this.#set('running', this.#message);
        return;
      }
      if (this.#child === null) {
        // Nothing runs: a held Douane takes the new release at its next start, any other one starts now.
        if (this.#held) this.#set('stopped');
        else {
          this.#cancelRestart();
          void this.#ensure();
        }
        return;
      }
      this.#set('updating', `Douane ${install.version} starts once the requests in flight end`);
      if (!await this.#waitIdle()) {
        this.#set('running', `Douane ${install.version} is installed and starts with Douane's next start`);
        return;
      }
      await this.#stopChild();
      if (await this.#launch(this.#installedExecutable())) {
        this.core.logs.info(`Douane updated from ${previousVersion ?? 'nothing'} to ${install.version}`, { source: 'douane', event: 'douane.updated' });
        return;
      }
      const failure = this.#message ?? 'it did not answer /health';
      // Where no link could be made the old release was moved into `current` and is gone: nothing to go back to.
      if (previousDir !== null && previousVersion !== null && existsSync(previousDir) && previousDir !== this.installs.currentDir(ID)) {
        pointCurrent(ID, this.installs.currentDir(ID), previousDir, (level, message) => this.core.logs.record(level, message, { source: 'douane' }));
        if (await this.#launch(this.#installedExecutable())) {
          this.#set('failed', `Douane ${install.version} did not start (${failure}); ${previousVersion} runs again`);
          return;
        }
      }
      this.#scheduleRestart(`Douane ${install.version} did not start: ${failure}`);
    } finally {
      this.installs.release(ID);
    }
  }

  /** Downloads and checks a release; false with the state set when it did not land. */
  async #install(install: ProviderInstall): Promise<boolean> {
    try { this.installs.start(ID, install); }
    catch (error) {
      this.#set('failed', `Could not install Douane ${install.version}: ${messageOf(error)}`);
      return false;
    }
    const outcome = await this.installs.whenDone(ID);
    this.#progress = undefined;
    if (outcome?.outcome === 'installed') return true;
    this.#set('failed', outcome?.state.state === 'failed' ? `Could not install Douane ${install.version}: ${outcome.state.message}` : 'The Douane install was cancelled');
    return false;
  }

  /** A first install reads as `installing`; an update keeps `updating` while the release that runs serves. */
  #installProgress(state: ProviderInstallState): void {
    if (state.state !== 'downloading' && state.state !== 'verifying' && state.state !== 'extracting') return;
    this.#progress = state.state === 'downloading' ? { receivedBytes: state.receivedBytes, totalBytes: state.totalBytes } : undefined;
    if (this.#child === null) this.#state = 'installing';
    this.#emit();
  }

  /** Polls Douane's summary until it serves no request; false when the wait ran out or it could not be read. */
  async #waitIdle(): Promise<boolean> {
    const deadline = Date.now() + this.idleWaitMs;
    while (Date.now() < deadline && this.#child !== null && !this.#closed) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port()}/admin/api/summary`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
        const body = await response.json() as { in_flight?: unknown };
        if (response.ok && body.in_flight === 0) return true;
      } catch { /* read again */ }
      await Bun.sleep(this.idlePollMs);
    }
    return false;
  }

  // -- running --------------------------------------------------------------

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => {});
    return next;
  }

  #ensure(): Promise<void> {
    return this.#serial(async () => {
      // A pending restart keeps its delay: a settings change in between does not cut it short.
      if (this.#closed || !this.wanted() || this.#held || this.#child !== null || this.#restartTimer !== null) return;
      const executable = await this.#executable();
      if (executable === null || this.#closed || !this.wanted() || this.#held) return;
      if (!await this.#launch(executable)) this.#scheduleRestart(this.#message ?? 'Douane did not start');
    });
  }

  #installedExecutable(): string {
    const target = douanePlatform();
    return realpathSync(join(this.installs.currentDir(ID), target!.binary));
  }

  /** The program to run: the development one, the release on disk, or a release installed now. Null with the state set. */
  async #executable(): Promise<string | null> {
    const development = this.development;
    if (development !== null) {
      if (existsSync(development)) return development;
      this.#set('failed', `${DOUANE_BINARY_ENV} names ${development}, which does not exist`);
      return null;
    }
    if (this.installedVersion() !== null) {
      try { return this.#installedExecutable(); }
      catch (error) { this.#set('failed', `Douane's installed release is incomplete: ${messageOf(error)}`); return null; }
    }
    this.#set('installing');
    const latest = await this.#readLatest(true);
    if (latest === null) return null;
    if (!await this.#install(latest)) return null;
    return this.#installedExecutable();
  }

  /** The remembered port when it is free, Douane's default next, any free one last; remembered and written into the proxy settings. */
  async #choosePort(): Promise<number> {
    const remembered = this.port();
    let port = remembered;
    if (!await portFree(port)) port = port !== DOUANE_PREFERRED_PORT && await portFree(DOUANE_PREFERRED_PORT) ? DOUANE_PREFERRED_PORT : freePort();
    if (port !== remembered || this.core.journal.getSetting(PORT_SETTING) !== port) this.core.journal.setSetting(PORT_SETTING, port);
    const proxy = this.core.settings.get().subscriptionProxy;
    if (proxy?.mode === 'local') {
      const urls = localProxyUrls(port);
      if (proxy.baseUrl !== urls.baseUrl || proxy.dashboardUrl !== urls.dashboardUrl || proxy.kind !== 'douane') {
        this.core.settings.set({ subscriptionProxy: this.localProxy(proxy) });
      }
    }
    if (port !== remembered) this.core.logs.info(`Douane port ${remembered} is taken; it listens on ${port}`, { source: 'douane', event: 'douane.port', data: { port } });
    return port;
  }

  /** Writes the configuration once, then only moves its `listen` line: Douane saves its own settings into the same file. */
  #writeConfig(port: number): string {
    mkdirSync(join(this.dir, 'auth'), { recursive: true });
    const file = join(this.dir, 'douane.toml');
    if (!existsSync(file)) writeFileSync(file, configText(port));
    else {
      const text = readFileSync(file, 'utf8');
      const listen = `listen = "127.0.0.1:${port}"`;
      const next = /^listen\s*=.*$/m.test(text) ? text.replace(/^listen\s*=.*$/m, listen) : text.replace(/^\[server\]\s*$/m, `[server]\n${listen}`);
      if (next !== text) writeFileSync(file, next);
    }
    return file;
  }

  /** Starts Douane and waits for `/health`; false with the reason in the state when it did not answer. */
  async #launch(executable: string): Promise<boolean> {
    this.#cancelRestart();
    await this.#stopOrphan();
    const port = await this.#choosePort();
    const config = this.#writeConfig(port);
    this.#set('starting');
    let spawned: SpawnedProcess;
    try {
      const [program, prefix] = launchOf(executable);
      spawned = this.core.procs.spawn(SCOPE, program, [...prefix, '--config', config], {
        cwd: this.dir, agentRoot: false,
        env: { NO_COLOR: '1', RUST_LOG_STYLE: 'never' },
      });
    } catch (error) {
      this.#set('failed', `Douane could not start: ${messageOf(error)}`);
      return false;
    }
    const child: Child = { spawned, version: null, startedAt: Date.now(), stopping: false };
    this.#child = child;
    this.#writePid(spawned.record.pid, config);
    let lastError = '';
    void this.#drain(spawned.proc.stdout, () => {});
    void this.#drain(spawned.proc.stderr, (line) => { if (/\b(ERROR|error:)/.test(line)) lastError = line.slice(0, 300); });
    let exitCode: number | null = null;
    void spawned.exited.then((code) => {
      exitCode = code;
      this.#exited(child, code);
    });
    const deadline = Date.now() + this.readyMs;
    while (Date.now() < deadline) {
      if (exitCode !== null || this.#child !== child) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000), redirect: 'error' });
        const body = await response.json() as { status?: unknown; version?: unknown };
        if (response.ok && body.status === 'ok') {
          child.version = typeof body.version === 'string' && body.version ? body.version.slice(0, 80) : this.installedVersion();
          this.#set('running');
          this.core.logs.info(`Douane ${child.version ?? ''} listens on 127.0.0.1:${port}`, { source: 'douane', event: 'douane.started', data: { port, pid: spawned.record.pid } });
          return true;
        }
      } catch { /* not listening yet */ }
      await Bun.sleep(100);
    }
    if (exitCode === null && this.#child === child) {
      await this.#stopChild();
      this.#set('failed', `Douane did not answer /health within ${Math.round(this.readyMs / 1000)} s`);
    } else {
      await Bun.sleep(20); // the last stderr line lands after the exit
      this.#set('failed', `Douane exited with code ${String(exitCode)} while starting${lastError ? `: ${lastError}` : ''}`);
    }
    return false;
  }

  #exited(child: Child, code: number): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#removePid();
    if (child.stopping || this.#closed) return;
    // Only a crash after it answered: a failed start schedules its own retry.
    if (this.#state !== 'running' && this.#state !== 'updating') return;
    if (Date.now() - child.startedAt >= STABLE_MS) this.#crashes = 0;
    this.core.logs.warn(`Douane exited with code ${code}`, { source: 'douane', event: 'douane.exited', data: { code } });
    this.#scheduleRestart(`Douane exited with code ${code}`);
  }

  #scheduleRestart(message: string): void {
    if (this.#closed || !this.wanted() || this.#held) return;
    const delays = this.restartDelaysMs;
    const delay = delays[Math.min(this.#crashes, delays.length - 1)] ?? 60_000;
    this.#crashes += 1;
    this.#cancelRestart();
    this.#restartAt = Date.now() + delay;
    this.#set('failed', message);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#restartAt = undefined;
      void this.#ensure();
    }, delay);
    this.#restartTimer.unref?.();
  }

  #cancelRestart(): void {
    if (this.#restartTimer !== null) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#restartAt = undefined;
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    child.stopping = true;
    this.core.procs.killTree(SCOPE);
    await child.spawned.exited.catch(() => {});
    if (this.#child === child) this.#child = null;
    this.#removePid();
  }

  /**
   * A core that died without closing (a crash, a kill) can leave its Douane
   * running off Windows, where no job takes it down. It holds the port and
   * the database the next one would open, so it is stopped first. Only the
   * process recorded here, and only while it still runs this very configuration.
   */
  async #stopOrphan(): Promise<void> {
    const file = join(this.dir, 'douane.pid');
    let pid: number | null = null;
    try { pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid as number; }
    catch { return; }
    rmSync(file, { force: true });
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || process.platform !== 'linux') return;
    try {
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!commandLine.includes(join(this.dir, 'douane.toml'))) return;
      process.kill(pid, 'SIGTERM');
      for (let waited = 0; waited < 5_000 && existsSync(`/proc/${pid}`); waited += 50) await Bun.sleep(50);
      this.core.logs.warn(`Stopped Douane pid ${pid}, left running by a previous core`, { source: 'douane', event: 'douane.orphan-stopped', data: { pid } });
    } catch { /* gone already */ }
  }

  #writePid(pid: number, config: string): void {
    try { writeFileSync(join(this.dir, 'douane.pid'), `${JSON.stringify({ pid, config })}\n`); }
    catch { /* only the orphan check reads it */ }
  }

  #removePid(): void {
    rmSync(join(this.dir, 'douane.pid'), { force: true });
  }

  async #drain(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    const emit = (raw: string): void => {
      const line = stripAnsi(raw).trim().slice(0, LOG_LINE_MAX);
      if (!line) return;
      onLine(line);
      const level = /\bERROR\b/.test(line) ? 'error' : /\bWARN\b/.test(line) ? 'warn' : 'info';
      this.core.logs.record(level, `douane: ${line}`, { source: 'douane', event: 'douane.output' });
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

  // -- reporting ------------------------------------------------------------

  #set(state: State, message?: string): void {
    this.#state = state;
    this.#message = message;
    if (state !== 'installing' && state !== 'updating') this.#progress = undefined;
    if (state !== 'failed') this.#restartAt = this.#restartTimer === null ? undefined : this.#restartAt;
    this.#emit();
  }

  #emit(): void {
    if (this.#closed && this.core.stopping) return;
    this.core.bus.emit('douane.updated', this.status());
  }
}

export function registerLocalDouane(core: Core): void {
  core.router.register('douane.status', () => core.douane.status());
  core.router.register('douane.start', () => core.douane.userStart());
  core.router.register('douane.stop', () => core.douane.userStop());
  core.router.register('douane.check', () => core.douane.check());
  core.router.register('douane.update', () => core.douane.update());
}
