import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { HarnessUpdate, OsProfile, ProviderDescriptor, ProviderId, ProviderInstall, ProviderSelfUpdate, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { forgetProbes } from '../drivers/index.ts';
import { notFound, refused } from '../errors.ts';
import type { InstallOutcome } from './install.ts';
import { npmInstallOf, unwritableDir } from './npm.ts';
import { profileFor, resolveCommand } from './resolve.ts';
import { resumeAfterUpdate, resumePostponed, resumeUnwaited, type Resume } from './update-resume.ts';
import { readVersion, recheckVersions } from './versions.ts';
import { forgetWhich } from './which.ts';
import { compareVersions, INSTALL_LATEST_MAX_AGE_MS, upToDate } from './install-latest.ts';
import { logUpdate } from './install-log.ts';

export { readVersion };

/**
 * The earliest automatic check after the core is up, so nothing spawns or
 * reaches the network while the app starts. A reading kept from the last run
 * pushes it back to six hours after that reading.
 */
const FIRST_CHECK_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** An automatic check that found a turn in flight looks again this often. */
const BUSY_RETRY_MS = 10 * 60 * 1000;
/**
 * How long a paused turn waits for the other turns of its agent to pause. Past
 * it the paused turns go on, on the version they started with, and the update
 * waits for a moment when none of the agent's turns runs: a turn that waits on
 * another one through a tool call would otherwise never let it go.
 */
const PAUSE_LIMIT_MS = 15 * 60 * 1000;
const VERSION_TIMEOUT_MS = 20_000;
/** How long a timed-out run's pipes may stay open once its tree was killed, for a descendant killTree cannot reach. */
const PIPE_GRACE_MS = 2_000;
/** What is kept of each stream of an agent's run: its end, where the error line is. */
const OUTPUT_MAX_BYTES = 256 * 1024;
/** Agents read at once by a check, so an old machine never starts all of them together. */
const CHECK_PARALLEL = 2;
/** An agent's own updater. A managed update has no such limit: its download stops by itself on a dead connection. */
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const SKIPS_FILE = 'harness-updates.json';
/** The last check's readings, so a restart shows them without spawning anything. */
const READINGS_FILE = 'harness-versions.json';

/** The synthetic thread an update's processes are traced under. */
export function updateThreadId(providerId: ProviderId): string {
  return `update:${providerId}`;
}

export { compareVersions } from './install-latest.ts';

/** True when the path sits under that directory, a sibling sharing its first letters left out. */
export function inside(dir: string, path: string): boolean {
  const fold = (value: string): string => (process.platform === 'linux' ? value : value.toLowerCase());
  return fold(path).startsWith(fold(dir.endsWith(sep) ? dir : dir + sep));
}

interface Entry {
  route: HarnessUpdate['route'];
  current: string | null;
  latest: string | null;
  state: HarnessUpdate['state'];
  message: string | null;
  checkedAt: number | null;
  /** The program this reading came from. Null in a reading kept by an older build. */
  program: string | null;
}

/**
 * An update asked for while turns of its agent run. `pause`: each running turn
 * pauses at its next tool boundary. `idle`: the pause limit passed, the paused
 * turns went on, and the update waits for none to run. `run`: the updater runs,
 * and the scheduler holds the agent's queued turns until it is done.
 */
interface Drain {
  target: Target;
  before: Entry;
  phase: 'pause' | 'idle' | 'run';
  limit: ReturnType<typeof setTimeout> | null;
  resume: ReturnType<typeof Promise.withResolvers<Resume | null>>;
  waitingFor: number;
}

interface Target {
  descriptor: ProviderDescriptor;
  profile: OsProfile;
  route: HarnessUpdate['route'];
  /** The program the route resolves to now, as a person would recognise it. */
  program: string;
}

/** Reads a stream to its end, keeping its last OUTPUT_MAX_BYTES, so a chatty program never blocks on a full pipe. */
async function capture(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done || chunk.value === undefined) break;
    chunks.push(chunk.value);
    size += chunk.value.length;
    while (size > OUTPUT_MAX_BYTES && chunks.length > 1) size -= chunks.shift()!.length;
  }
  const text = Buffer.concat(chunks);
  return text.subarray(Math.max(0, text.length - OUTPUT_MAX_BYTES)).toString('utf8');
}

/** stderr carries the failure; stdout often only announces the updater. */
function failureSummary(stdout: string, stderr: string): string | undefined {
  const lines = (output: string): string[] => stripVTControlCharacters(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines(stderr);
  const output = errors.length > 0 ? errors : lines(stdout);
  // npm ends with its log location, after the error explaining the failed operation.
  return output.find((line) => /\berror:|\b(?:EACCES|EPERM)\b.*(?:permission denied|operation not permitted)/i.test(line)) ?? output.at(-1);
}

/**
 * Why an updater that exited with zero left its version where it was, in its
 * own words. `opencode upgrade` reports every failure and every skip this way,
 * through a prompt library whose frame falls back to ASCII letters (`x`, `o`)
 * when its output is not a Unicode terminal, and closes with `Done`.
 */
function stuckReason(output: string): string | undefined {
  const lines = stripVTControlCharacters(output).split(/\r?\n/)
    .map((line) => line.trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/^[xoT]\s{2,}/, '').trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line) && !/^done\.?$/i.test(line));
  // An errno such as EBUSY or EPERM counts in capitals only: `exit` is no error code.
  const reason = lines.findLast((line) => /fail|error|skipped|unknown|denied|cannot|could not|unable/i.test(line) || /\bE[A-Z]{3,}\b/.test(line)) ?? lines.at(-1);
  return reason?.slice(0, 300);
}

async function npmLatest(name: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${name.replaceAll('/', '%2F')}/latest`, {
    signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status} for ${name}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== 'string') throw new Error(`the npm registry named no version for ${name}`);
  return body.version;
}

/**
 * Which copy of an agent a reading belongs to: the program with its links
 * followed, so `~/.local/bin/claude` moved from an npm install to a native one
 * is another program even though its path did not change.
 */
function programIdentity(program: string): string {
  try {
    return realpathSync(program);
  } catch {
    return program;
  }
}

/** The account the core runs as, for a message about what it may write. */
function whoRuns(): string {
  try {
    return userInfo().username;
  } catch {
    return 'the core\'s user';
  }
}

/**
 * The environment an agent's own program runs under here. An npm install is
 * updated by `npm install -g`, which writes under npm's configured prefix: it
 * is pointed at the prefix the running copy lives in, whatever the user's npm
 * configuration names, so the updater replaces the copy Boite runs.
 */
function updaterEnv(program: string, updateEnv: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const install = npmInstallOf(program);
  for (const [key, value] of Object.entries(process.env)) {
    if (install !== null && key.toLowerCase() === 'npm_config_prefix') continue;
    env[key] = value;
  }
  if (install !== null) env['npm_config_prefix'] = install.prefix;
  return { ...env, ...updateEnv };
}

/**
 * Keeps the agents of this machine current. Each core looks after its own:
 * a client connected to three machines hears three lists and asks the machine
 * that owns the agent to update it, and a server with `autoUpdateHarnesses`
 * on does it with nobody connected.
 */
export class HarnessUpdates {
  private readonly entries = new Map<ProviderId, Entry>();
  private skips: Record<string, string> = {};
  private checking: Promise<HarnessUpdate[]> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly drains = new Map<ProviderId, Drain>();
  /** When the last whole check finished, kept across restarts. */
  private lastCheckAt: number | null = null;
  /** Test seams: the registry read, the only providers a check may touch, how long a version read and a pause may take. */
  npmLatest: (name: string) => Promise<string> = npmLatest;
  only: ReadonlySet<ProviderId> | null = null;
  versionTimeoutMs = VERSION_TIMEOUT_MS;
  pauseLimitMs = PAUSE_LIMIT_MS;

  constructor(private readonly core: Core) {
    this.skips = this.readSkips();
    this.readReadings();
    core.providers.installs.onSettled((outcome) => this.installSettled(outcome));
    // A turn that ends may be the last one an update waits for.
    core.bus.onAny((name) => {
      if (name === 'turn.finished' && this.drains.size > 0) setTimeout(() => this.advanceAll(), 0);
    });
  }

  /**
   * Arms the periodic check. The core's entry point calls it, an e2e core
   * included; `BOITE_HOST_AGENTS=0`, which that suite sets, leaves it no agent
   * to read, so it runs no CLI and asks no registry. A unit test core never arms it.
   */
  start(): void {
    this.refreshRestored();
    this.schedule(this.firstDelay());
  }

  /**
   * Brings the readings kept from the last run up to this build without
   * spawning anything. A managed row is read again at once, since its read is
   * the release on disk and the version this Boite pins, and a new build may
   * pin a newer one. A row whose provider lost its route, took another, or now
   * resolves to another program is dropped. A 'self' row keeps its reading
   * until the scheduled check, which has to run the agent to read it. A 'self'
   * row dropped because its program moved leaves nothing to show for that
   * agent, so the last check stops counting: the first one comes at the usual
   * ten minutes rather than up to six hours later.
   */
  refreshRestored(): void {
    let changed = false;
    let moved = false;
    for (const [id, entry] of [...this.entries]) {
      if (entry.state === 'updating' || entry.state === 'checking') continue;
      const target = this.targetOf(id);
      if (target?.route !== entry.route) {
        this.entries.delete(id);
        changed = true;
      } else if (entry.program !== null && target.program !== entry.program) {
        this.entries.delete(id);
        changed = true;
        moved ||= entry.route === 'self';
      }
    }
    for (const summary of this.core.providers.list().loaded) {
      const id = summary.id;
      if (this.core.providers.installs.installedVersion(id) === null) continue;
      const target = this.targetOf(id);
      const previous = this.entries.get(id);
      if (target?.route !== 'managed' || previous?.state === 'updating' || previous?.state === 'checking') continue;
      const read = this.readManaged(target);
      if (previous !== undefined && previous.current === read.current && previous.latest === read.latest) continue;
      this.entries.set(id, { route: 'managed', ...read, state: 'idle', message: null, checkedAt: Date.now(), program: target.program });
      changed = true;
    }
    if (moved) this.lastCheckAt = null;
    if (!changed) return;
    this.writeReadings();
    this.emit();
  }

  /** How long after start the first automatic check waits: ten minutes, or until the kept reading is six hours old. */
  firstDelay(now = Date.now()): number {
    const due = this.lastCheckAt === null ? 0 : this.lastCheckAt + CHECK_EVERY_MS - now;
    return Math.min(CHECK_EVERY_MS, Math.max(FIRST_CHECK_MS, due));
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.entries.keys()) this.core.procs.killTree(updateThreadId(id));
    for (const drain of this.drains.values()) {
      if (drain.limit !== null) clearTimeout(drain.limit);
      drain.resume.resolve(null);
    }
    this.drains.clear();
  }

  /**
   * What the last check read. Only `refresh` runs the agents: a client that
   * connects is answered from memory, and the scheduled check pushes its
   * reading as `providers.updatesChanged`.
   */
  async list(refresh = false): Promise<HarnessUpdate[]> {
    return refresh ? this.check() : this.snapshot();
  }

  check(): Promise<HarnessUpdate[]> {
    if (this.closed || this.core.stopping) return Promise.reject(refused('the core is stopping; agent updates are closed'));
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async update(providerId: ProviderId): Promise<HarnessUpdate> {
    this.assertOpen();
    const target = this.targetOf(providerId);
    if (target === null) throw refused(`${providerId} has no update Boite can run on this machine`, { providerId });
    // A check in flight writes its reading when it lands: an update started under it
    // would be written over as idle, and a second updater could then start.
    if (this.checking !== null) await this.checking.catch(() => {});
    let entry = this.entries.get(providerId);
    // A reading kept from before a restart may name a route this machine no longer
    // takes, or a program PATH no longer finds.
    if (entry === undefined || entry.route !== target.route || (entry.program !== null && entry.program !== target.program)) {
      await this.check();
      entry = this.entries.get(providerId);
    }
    this.assertOpen();
    if (entry === undefined) throw notFound('provider update', providerId);
    if (entry.state === 'updating') throw refused(`${target.descriptor.name} is already updating`, { providerId });
    // An agent with no way to name its newest release is still updated on request:
    // its updater checks by itself, and what it installed is read afterwards.
    const blind = target.route === 'self' && entry.latest === null && entry.current !== null;
    if (!blind && !this.newer(entry)) {
      throw refused(`${target.descriptor.name} is already on its newest known version`, {
        providerId,
        current: entry.current,
        latest: entry.latest,
      });
    }
    // Turns of this agent in flight pause between two tool calls rather than refuse the update.
    const drain: Drain = { target, before: entry, phase: 'pause', limit: null, resume: Promise.withResolvers(), waitingFor: 0 };
    this.drains.set(providerId, drain);
    this.entries.set(providerId, { ...entry, state: 'updating', message: null });
    for (const threadId of this.runningThreads(providerId)) this.core.threads.runner.requestPause(threadId, providerId);
    drain.waitingFor = this.waitingFor(providerId);
    this.emit();
    this.advance(providerId);
    return this.describe(providerId)!;
  }

  /** The version last read from this provider's program, null before the first check. */
  current(providerId: ProviderId): string | null {
    return this.entries.get(providerId)?.current ?? null;
  }

  /** True while this provider's update is asked for and not done. */
  updating(providerId: ProviderId): boolean {
    return this.entries.get(providerId)?.state === 'updating';
  }

  /** True while this provider's turns should pause at their next tool boundary. */
  wantsPause(providerId: ProviderId): boolean {
    return this.drains.get(providerId)?.phase === 'pause';
  }

  /** True while the updater runs: the scheduler starts none of this provider's turns. */
  holds(providerId: ProviderId | undefined): boolean {
    return providerId !== undefined && this.drains.get(providerId)?.phase === 'run';
  }

  /** What a turn that paused for this provider's update waits on. */
  resumeOf(providerId: ProviderId): Promise<Resume | null> {
    const drain = this.drains.get(providerId);
    if (drain !== undefined) return drain.resume.promise;
    return Promise.resolve(resumeUnwaited(this.core.providers.get(providerId)?.name ?? providerId));
  }

  /** A turn paused: the update may start, and the pause limit runs from the first one. */
  turnPaused(providerId: ProviderId): void {
    const drain = this.drains.get(providerId);
    if (drain === undefined) return;
    if (drain.limit === null && drain.phase === 'pause') {
      drain.limit = setTimeout(() => this.postpone(providerId), this.pauseLimitMs);
      drain.limit.unref?.();
    }
    this.advance(providerId);
  }

  skip(providerId: ProviderId, version: string | null): HarnessUpdate {
    const current = this.describe(providerId);
    if (current === null) throw notFound('provider update', providerId);
    if (version === null) delete this.skips[providerId];
    else this.skips[providerId] = version;
    this.writeSkips();
    this.emit();
    return this.describe(providerId)!;
  }

  // ---------------------------------------------------------------------

  private schedule(delay: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      // A check started by hand since the timer was armed already counts.
      const recent = this.lastCheckAt !== null && Date.now() - this.lastCheckAt < CHECK_EVERY_MS - BUSY_RETRY_MS;
      if (!recent) {
        // Reading every agent while a turn runs competes with it: wait for a quiet moment.
        if (this.anyBusy()) {
          this.schedule(BUSY_RETRY_MS);
          return;
        }
        await this.check();
      }
      if (this.closed || this.core.stopping) return;
      if (this.core.settings.get().autoUpdateHarnesses) {
        for (const update of this.snapshot()) {
          if (!update.pending) continue;
          // A turn in flight pauses at its next tool boundary for it, and goes on after.
          await this.update(update.providerId).catch((error: unknown) => {
            this.core.log('warn', `automatic update of ${update.providerId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
    } catch (error) {
      if (this.closed || this.core.stopping) return;
      this.core.log('warn', `checking agent updates: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.schedule(CHECK_EVERY_MS);
  }

  /** The route this provider updates by on this machine, null when there is none. */
  private targetOf(providerId: ProviderId): Target | null {
    const descriptor = this.core.providers.get(providerId);
    const summary = this.core.providers.summary(providerId);
    // A provider turned off is never asked its version and never updated.
    if (descriptor === undefined || summary === undefined || !summary.available || summary.enabled === false) return null;
    if (this.only !== null && !this.only.has(providerId)) return null;
    const profile = profileFor(descriptor);
    if (profile === undefined) return null;
    const command = resolveCommand(profile);
    const managedDir = resolve(this.core.providers.installs.currentDir(providerId));
    // A release on disk under `current` is what makes the route managed, whatever
    // the install card is doing: an update under way or a failed one still leave it there.
    const runsManaged =
      this.core.providers.installs.installedVersion(providerId) !== null &&
      command !== null &&
      inside(managedDir, resolve(command.executable));
    if (runsManaged && profile.install !== undefined) return { descriptor, profile, route: 'managed', program: programIdentity(command.shown) };
    // A download in flight belongs to the install card, not to this list.
    if (profile.update !== undefined && command !== null) return { descriptor, profile, route: 'self', program: programIdentity(command.shown) };
    return null;
  }

  private async runCheck(): Promise<HarnessUpdate[]> {
    const targets = this.core.providers
      .list()
      .loaded.map((summary) => this.targetOf(summary.id))
      .filter((target): target is Target => target !== null);
    for (const id of [...this.entries.keys()]) {
      if (!targets.some((target) => target.descriptor.id === id)) this.entries.delete(id);
    }
    for (const target of targets) {
      const previous = this.entries.get(target.descriptor.id);
      if (previous?.state === 'updating') continue;
      this.entries.set(target.descriptor.id, {
        route: target.route,
        current: previous?.current ?? null,
        latest: previous?.latest ?? null,
        state: 'checking',
        message: null,
        checkedAt: previous?.checkedAt ?? null,
        program: target.program,
      });
    }
    this.emit();
    const queue = [...targets];
    const readNext = async (): Promise<void> => {
      for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        const id = target.descriptor.id;
        if (this.entries.get(id)?.state === 'updating') continue;
        try {
          const read = await this.read(target);
          if (this.entries.get(id)?.state === 'updating') continue;
          this.entries.set(id, { route: target.route, ...read, state: 'idle', message: null, checkedAt: Date.now(), program: target.program });
        } catch (error) {
          const previous = this.entries.get(id);
          if (previous?.state === 'updating') continue;
          this.entries.set(id, {
            route: target.route,
            current: previous?.current ?? null,
            latest: previous?.latest ?? null,
            state: 'failed',
            message: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now(),
            program: target.program,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, queue.length) }, readNext));
    this.lastCheckAt = Date.now();
    this.writeReadings();
    this.emit();
    return this.snapshot();
  }

  /** `maxAgeMs` is how old a publisher's answer may be: a check asks again, a read right after an install need not. */
  private async read(target: Target, maxAgeMs = 0): Promise<{ current: string | null; latest: string | null }> {
    if (target.route === 'managed') {
      // A release that follows its publisher reads it, and nothing runs.
      await this.freshInstall(target, maxAgeMs);
      return this.readManaged(target);
    }
    const spec = target.profile.update as ProviderSelfUpdate;
    const current = readVersion(await this.run(target, spec.versionArgs ?? ['--version'], this.versionTimeoutMs));
    if (current === null) throw new Error(`${target.descriptor.name} printed no version`);
    let latest: string | null = null;
    if (spec.latestNpm !== undefined) latest = await this.npmLatest(spec.latestNpm);
    else if (spec.latestArgs !== undefined) {
      const output = await this.run(target, spec.latestArgs, this.versionTimeoutMs);
      const start = output.indexOf('{');
      const end = output.lastIndexOf('}');
      try {
        const parsed = JSON.parse(output.slice(start, end + 1)) as { latestVersion?: unknown };
        if (typeof parsed.latestVersion === 'string') latest = parsed.latestVersion;
      } catch {
        // fall through to the refusal below
      }
      if (latest === null) throw new Error(`${target.descriptor.name} named no latestVersion when asked for updates`);
    }
    return { current, latest };
  }

  /**
   * A managed release is read off disk and the install block: the pin, or the
   * newest release its publisher named. Nothing runs. A release that follows
   * its publisher never offers an older one than it has, which the pin is
   * after a restart until the publisher is read again.
   */
  private readManaged(target: Target): { current: string | null; latest: string | null } {
    const id = target.descriptor.id;
    const current = this.core.providers.installs.installedVersion(id);
    const install = this.core.providers.installBlock(id);
    const latest = install?.version ?? null;
    return { current, latest: install !== undefined && upToDate(current, install) ? current : latest };
  }

  /** One short run of the agent's own program, traced like every process of an agent. */
  private async run(target: Target, args: string[], timeoutMs: number): Promise<string> {
    this.assertOpen();
    // An updater just rewrote the program, or it was never asked its version: a
    // candidate that names a major resolves once the program has answered.
    if (resolveCommand(target.profile) === null) await this.core.providers.settle(this.versionTimeoutMs);
    const command = resolveCommand(target.profile);
    if (command === null) throw new Error(`${target.descriptor.name} is not on this machine any more`);
    const spawned = this.core.procs.spawnPiped(updateThreadId(target.descriptor.id), command.executable, [...command.prefix, ...args], {
      cwd: this.core.dataDir,
      env: updaterEnv(command.shown, command.updateEnv),
    });
    spawned.proc.stdin.end();
    const readers = [spawned.proc.stdout.getReader(), spawned.proc.stderr.getReader()] as const;
    let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let giveUp = (): void => {};
    const late = new Promise<'late'>((resolve) => {
      giveUp = () => resolve('late');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // The whole tree: a launcher's child that inherited the pipes would hold them open.
      // A check and an update of one agent never overlap, so nothing else runs under this id.
      this.core.procs.killTree(updateThreadId(target.descriptor.id));
      grace = setTimeout(giveUp, PIPE_GRACE_MS);
    }, timeoutMs);
    try {
      const ran = await Promise.race([Promise.all([capture(readers[0]), capture(readers[1]), spawned.exited]), late]);
      if (ran === 'late' || timedOut) throw new Error(`${target.descriptor.name} did not answer \`${args.join(' ')}\` within ${Math.round(timeoutMs / 1000)} s`);
      const [stdout, stderr, code] = ran;
      if (code !== 0) {
        const last = failureSummary(stdout, stderr);
        throw new Error(`\`${args.join(' ')}\` exited with ${code}${last === undefined ? '' : `: ${last.slice(0, 300)}`}`);
      }
      return `${stdout}\n${stderr}`;
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      // A descendant that outlived the kill keeps the pipe; stop reading it rather than wait on it.
      if (timedOut) for (const reader of readers) void reader.cancel().catch(() => {});
    }
  }

  private async runUpdate(target: Target, before: Entry): Promise<void> {
    const id = target.descriptor.id;
    try {
      let said = '';
      if (target.route === 'managed') await this.runManaged(target);
      else {
        this.assertWritable(target);
        said = await this.run(target, (target.profile.update as ProviderSelfUpdate).args, UPDATE_TIMEOUT_MS);
      }
      // An updater may have moved the program on PATH.
      forgetWhich();
      recheckVersions();
      const read = await this.read(target, INSTALL_LATEST_MAX_AGE_MS);
      if (this.closed || this.core.stopping) return;
      const stuck = target.route === 'self' && before.current !== null && read.current === before.current && this.newer({ ...before, ...read });
      const reason = stuck ? stuckReason(said) : undefined;
      // An updater that checks by itself and exits cleanly has just named its
      // newest release: the one it now reports, moved or not. Without this the
      // row would offer the same run again, as if nothing had happened.
      const confirmed = target.route === 'self' && read.latest === null ? { ...read, latest: read.current } : read;
      this.entries.set(id, {
        route: target.route,
        ...confirmed,
        state: stuck ? 'failed' : 'idle',
        message: stuck ? `${target.descriptor.name} ran its updater and still reports ${read.current}${reason === undefined ? '' : `: ${reason}`}` : null,
        checkedAt: Date.now(),
        program: this.targetOf(id)?.program ?? target.program,
      });
      // A new release may list other models, and the path may have moved.
      forgetProbes({ providerId: id });
      forgetWhich();
      recheckVersions();
      // The list that goes out names the program as it stands after the update.
      await this.core.providers.settle(this.versionTimeoutMs);
      if (this.closed || this.core.stopping) return;
      this.core.bus.emit('providers.updated', this.core.providers.list());
    } catch (error) {
      this.entries.set(id, { ...before, state: 'failed', message: error instanceof Error ? error.message : String(error), checkedAt: Date.now(), program: target.program });
    }
    this.writeReadings();
    this.emit();
  }

  /**
   * Refuses, before anything runs, an npm install this user cannot replace: a
   * copy root installed system-wide would otherwise run its updater for nothing
   * and bury the one fact that matters in npm's output.
   */
  private assertWritable(target: Target): void {
    const install = npmInstallOf(target.program);
    const denied = install === null ? null : unwritableDir(install);
    if (install === null || denied === null) return;
    const user = whoRuns();
    throw new Error(
      `${target.descriptor.name} is installed under ${install.prefix}, and ${user} cannot write ${denied}, so its updater cannot replace it. ` +
        `Install it under an npm prefix ${user} owns and put that prefix's bin directory first on the core's PATH.`,
    );
  }

  /**
   * The install block's own download, waited on for as long as it takes: its
   * card shows the progress meanwhile, and the download fails by itself once
   * the connection stays dead. A download the install card already started is
   * joined rather than refused as already running; when it lands an older
   * release than the publisher now names, that one is fetched after it.
   */
  private async runManaged(target: Target): Promise<void> {
    const id = target.descriptor.id;
    const installs = this.core.providers.installs;
    const settled = async (done: ReturnType<typeof installs.whenDone>): Promise<void> => {
      const result = await done;
      if (result === null || result.outcome === 'cancelled') throw new Error('the download was cancelled');
      if (result.state.state === 'failed') throw new Error(result.state.message);
    };
    const joined = installs.whenDone(id);
    if (joined !== null) await settled(joined);
    const install = await this.freshInstall(target, INSTALL_LATEST_MAX_AGE_MS);
    if (install === undefined) throw new Error(`${target.descriptor.name} has nothing for Boite to install on this platform`);
    // Nothing to fetch: the joined download landed it, or the publisher names what is on disk.
    if (upToDate(installs.installedVersion(id), install)) return;
    if (installs.whenDone(id) === null) installs.start(id, install);
    await settled(installs.whenDone(id));
  }

  private freshInstall(target: Target, maxAgeMs: number): Promise<ProviderInstall | undefined> {
    return this.core.providers.freshInstallBlock(target.descriptor.id, (level, message) => this.core.log(level, message), maxAgeMs);
  }

  /**
   * An install that lands from the install card moves the managed release
   * too: the row is read again at once rather than offering, until the next
   * check, an update that is already on disk.
   */
  private installSettled(outcome: InstallOutcome): void {
    const entry = this.entries.get(outcome.providerId);
    if (this.closed || outcome.outcome !== 'installed' || entry?.route !== 'managed' || entry.state === 'updating') return;
    const target = this.targetOf(outcome.providerId);
    if (target?.route !== 'managed') return;
    void this.read(target, INSTALL_LATEST_MAX_AGE_MS).then((read) => {
      if (this.entries.get(outcome.providerId)?.state === 'updating') return;
      this.put(outcome.providerId, { ...entry, ...read, state: 'idle', message: null, checkedAt: Date.now() });
      this.writeReadings();
    }).catch((error: unknown) => {
      this.core.log('warn', `reading ${outcome.providerId} after its install: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** The threads whose turn of this provider is running, a paused one included. */
  private runningThreads(providerId: ProviderId): ThreadId[] {
    const threads = new Set<ThreadId>();
    for (const turn of this.core.journal.unfinishedTurns()) {
      if (turn.status !== 'running') continue;
      const owner = turn.execution?.providerId ?? this.core.journal.getThread(turn.threadId)?.providerId;
      if (owner === providerId) threads.add(turn.threadId);
    }
    return [...threads];
  }

  /** The running turns of this provider that have not paused: what the updater waits for. */
  private waitingFor(providerId: ProviderId): number {
    return this.runningThreads(providerId).filter((threadId) => !this.core.threads.runner.isPaused(threadId)).length;
  }

  private advanceAll(): void {
    for (const id of [...this.drains.keys()]) this.advance(id);
  }

  /** Starts the updater once no turn of the provider runs unpaused, or says how many it still waits for. */
  private advance(providerId: ProviderId): void {
    const drain = this.drains.get(providerId);
    if (drain === undefined || drain.phase === 'run' || this.closed) return;
    const waiting = this.waitingFor(providerId);
    if (waiting > 0) {
      if (waiting !== drain.waitingFor) {
        logUpdate(this.core, providerId, 'waiting', { running: waiting });
        drain.waitingFor = waiting;
        this.emit();
      }
      return;
    }
    drain.phase = 'run';
    drain.waitingFor = 0;
    if (drain.limit !== null) clearTimeout(drain.limit);
    drain.limit = null;
    // A running program cannot be replaced, and a warm session is one: a paused turn's included.
    for (const thread of this.core.journal.listThreads()) {
      if (thread.providerId === providerId) this.core.threads.releaseAgent(thread.id);
    }
    this.emit();
    const updateAt = logUpdate(this.core, providerId, 'started', { from: drain.before.current });
    void this.runUpdate(drain.target, drain.before)
      .then(() => logUpdate(this.core, providerId, 'finished', { from: drain.before.current, to: this.entries.get(providerId)?.current ?? null, state: this.entries.get(providerId)?.state ?? null }, updateAt))
      .catch((error: unknown) => {
        this.core.log('error', `updating ${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.drains.get(providerId) !== drain) return;
        this.drains.delete(providerId);
        const entry = this.entries.get(providerId);
        drain.resume.resolve(this.closed || this.core.stopping ? null
          : resumeAfterUpdate(drain.target.descriptor.name, drain.before.current, entry?.current ?? null, entry?.state === 'failed'));
        // The turns queued while the updater ran start now, on the new version.
        if (!this.closed && !this.core.stopping) this.core.scheduler.retry();
      });
  }

  /**
   * The pause limit passed with turns still inside a tool call: the paused
   * ones go on, and the update waits for none of the agent's turns to run.
   */
  private postpone(providerId: ProviderId): void {
    const drain = this.drains.get(providerId);
    if (drain === undefined || drain.phase !== 'pause') return;
    drain.limit = null;
    drain.phase = 'idle';
    for (const threadId of this.runningThreads(providerId)) this.core.threads.runner.cancelPause(threadId);
    const name = drain.target.descriptor.name;
    const waiting = drain.resume;
    drain.resume = Promise.withResolvers();
    this.core.log('info', `${name}: turns still in a tool call after ${Math.round(this.pauseLimitMs / 60000)} min; the paused ones go on and the update waits for an idle moment`);
    waiting.resolve(resumePostponed(name));
    this.advance(providerId);
  }

  /** True while any turn of any agent is queued, running or waiting. */
  private anyBusy(): boolean {
    return this.core.journal.unfinishedTurns().length > 0 ||
      this.core.journal.listThreads().some((thread) => ['queued', 'running', 'waiting'].includes(thread.status));
  }

  private newer(entry: Pick<Entry, 'route' | 'current' | 'latest'>): boolean {
    if (entry.current === null || entry.latest === null) return false;
    // A managed release is whatever this Boite pins, newer or not.
    return entry.route === 'managed' ? entry.current !== entry.latest : compareVersions(entry.latest, entry.current) > 0;
  }

  private put(providerId: ProviderId, entry: Entry): void {
    this.entries.set(providerId, entry);
    this.emit();
  }

  private describe(providerId: ProviderId): HarnessUpdate | null {
    const entry = this.entries.get(providerId);
    const descriptor = this.core.providers.get(providerId);
    if (entry === undefined || descriptor === undefined) return null;
    const skipped = this.skips[providerId] ?? null;
    return {
      providerId,
      name: descriptor.name,
      route: entry.route,
      current: entry.current,
      latest: entry.latest,
      pending: entry.state !== 'updating' && entry.state !== 'checking' && this.newer(entry) && skipped !== entry.latest,
      skipped,
      state: entry.state,
      message: entry.message,
      checkedAt: entry.checkedAt,
      ...(entry.state === 'updating' ? { waitingFor: this.drains.get(providerId)?.waitingFor ?? 0 } : {}),
    };
  }

  private snapshot(): HarnessUpdate[] {
    return [...this.entries.keys()]
      .map((id) => this.describe(id))
      .filter((update): update is HarnessUpdate => update !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private emit(): void {
    if (this.closed || this.core.stopping) return;
    this.core.bus.emit('providers.updatesChanged', this.snapshot());
  }

  private assertOpen(): void {
    if (this.closed || this.core.stopping) throw refused('the core is stopping; agent updates are closed');
  }

  private readSkips(): Record<string, string> {
    const file = join(this.core.dataDir, SKIPS_FILE);
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { skipped?: unknown };
      const out: Record<string, string> = {};
      if (typeof parsed.skipped === 'object' && parsed.skipped !== null) {
        for (const [key, value] of Object.entries(parsed.skipped)) if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch (error) {
      this.core.log('warn', `${file}: unreadable, expected {"skipped": {"<provider id>": "<version>"}}; no version is skipped (${error instanceof Error ? error.message : String(error)})`);
      return {};
    }
  }

  /** Loads the last check's readings. A missing or broken file is no reading: the next check makes one. */
  private readReadings(): void {
    const file = join(this.core.dataDir, READINGS_FILE);
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { checkedAt?: unknown; readings?: unknown };
      if (typeof parsed.checkedAt === 'number' && Number.isFinite(parsed.checkedAt)) this.lastCheckAt = Math.min(parsed.checkedAt, Date.now());
      if (typeof parsed.readings !== 'object' || parsed.readings === null) return;
      const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
      for (const [id, raw] of Object.entries(parsed.readings as Record<string, Record<string, unknown> | null>)) {
        if (typeof raw !== 'object' || raw === null || (raw['route'] !== 'self' && raw['route'] !== 'managed')) continue;
        const failed = raw['state'] === 'failed';
        this.entries.set(id as ProviderId, {
          route: raw['route'],
          current: text(raw['current']),
          latest: text(raw['latest']),
          // A check or an update the last run left half done is only its last reading now.
          state: failed ? 'failed' : 'idle',
          message: failed ? text(raw['message']) : null,
          checkedAt: typeof raw['checkedAt'] === 'number' ? raw['checkedAt'] : null,
          program: text(raw['program']),
        });
      }
    } catch (error) {
      this.core.log('warn', `${file}: unreadable, expected {"checkedAt": <ms>, "readings": {"<provider id>": {...}}}; the next check reads again (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private writeReadings(): void {
    if (this.closed || this.core.stopping) return;
    const readings: Record<string, Entry> = {};
    for (const [id, entry] of this.entries) {
      if (entry.state === 'checking' || entry.state === 'updating') continue;
      readings[id] = entry;
    }
    try {
      writeFileSync(join(this.core.dataDir, READINGS_FILE), `${JSON.stringify({ checkedAt: this.lastCheckAt, readings }, null, 2)}\n`);
    } catch (error) {
      this.core.log('warn', `writing ${READINGS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeSkips(): void {
    writeFileSync(join(this.core.dataDir, SKIPS_FILE), `${JSON.stringify({ skipped: this.skips }, null, 2)}\n`);
  }
}

export function registerUpdateMethods(core: Core): void {
  core.router.register('providers.updates', (params) => core.updates.list(params.refresh === true));
  core.router.register('providers.update', (params) => core.updates.update(core.providers.require(params.providerId).id));
  core.router.register('providers.updateSkip', (params) => core.updates.skip(core.providers.require(params.providerId).id, params.version));
}
