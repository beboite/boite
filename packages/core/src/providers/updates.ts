import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { HarnessUpdate, OsProfile, ProviderDescriptor, ProviderId, ProviderSelfUpdate } from '@boite/contracts';
import type { Core } from '../core.ts';
import { forgetProbes } from '../drivers/index.ts';
import { notFound, refused } from '../errors.ts';
import type { InstallOutcome } from './install.ts';
import { profileFor, resolveCommand } from './resolve.ts';
import { forgetWhich } from './which.ts';

/**
 * The earliest automatic check after the core is up, so nothing spawns or
 * reaches the network while the app starts. A reading kept from the last run
 * pushes it back to six hours after that reading.
 */
const FIRST_CHECK_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** An automatic check or update that found a turn in flight looks again this often. */
const BUSY_RETRY_MS = 10 * 60 * 1000;
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
const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;

/** The synthetic thread an update's processes are traced under. */
export function updateThreadId(providerId: ProviderId): string {
  return `update:${providerId}`;
}

/** Newer, older or the same, reading the numbers first and a pre-release tag as older than none. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { numbers: number[]; tag: string } => {
    const [core = '', ...rest] = value.split('-');
    return { numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0), tag: rest.join('-') };
  };
  const left = split(a), right = split(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const delta = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (left.tag === right.tag) return 0;
  if (left.tag === '') return 1;
  if (right.tag === '') return -1;
  // beta.10 is after beta.2: a numeric part compares as a number.
  return left.tag.localeCompare(right.tag, 'en', { numeric: true }) < 0 ? -1 : 1;
}

/** True when the path sits under that directory, a sibling sharing its first letters left out. */
export function inside(dir: string, path: string): boolean {
  const fold = (value: string): string => (process.platform === 'linux' ? value : value.toLowerCase());
  return fold(path).startsWith(fold(dir.endsWith(sep) ? dir : dir + sep));
}

export function readVersion(output: string): string | null {
  return VERSION_PATTERN.exec(output)?.[0] ?? null;
}

interface Entry {
  route: HarnessUpdate['route'];
  current: string | null;
  latest: string | null;
  state: HarnessUpdate['state'];
  message: string | null;
  checkedAt: number | null;
}

interface Target {
  descriptor: ProviderDescriptor;
  profile: OsProfile;
  route: HarnessUpdate['route'];
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
  /** When the last whole check finished, kept across restarts. */
  private lastCheckAt: number | null = null;
  /** Test seams: the registry read, the only providers a check may touch, and how long a version read may take. */
  npmLatest: (name: string) => Promise<string> = npmLatest;
  only: ReadonlySet<ProviderId> | null = null;
  versionTimeoutMs = VERSION_TIMEOUT_MS;

  constructor(private readonly core: Core) {
    this.skips = this.readSkips();
    this.readReadings();
    core.providers.installs.onSettled((outcome) => this.installSettled(outcome));
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
   * pin a newer one. A row whose provider lost its route, or took another, is
   * dropped. A 'self' row keeps its reading until the scheduled check, which
   * has to run the agent to read it.
   */
  refreshRestored(): void {
    let changed = false;
    for (const [id, entry] of [...this.entries]) {
      if (entry.state === 'updating' || entry.state === 'checking') continue;
      if (this.targetOf(id)?.route !== entry.route) {
        this.entries.delete(id);
        changed = true;
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
      this.entries.set(id, { route: 'managed', ...read, state: 'idle', message: null, checkedAt: Date.now() });
      changed = true;
    }
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
    // A reading kept from before a restart may name a route this machine no longer takes.
    if (entry === undefined || entry.route !== target.route) {
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
    const busy = this.busyThreads(providerId);
    if (busy > 0) {
      throw refused(`${target.descriptor.name} has ${busy} turn${busy === 1 ? '' : 's'} in flight; update it once they finish`, {
        providerId,
        busy,
      });
    }
    // A running program cannot be replaced, and a warm session is one.
    for (const thread of this.core.journal.listThreads()) {
      if (thread.providerId === providerId) this.core.threads.releaseAgent(thread.id);
    }
    this.put(providerId, { ...entry, state: 'updating', message: null });
    void this.runUpdate(target, entry).catch((error: unknown) => {
      this.core.log('error', `updating ${providerId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.describe(providerId)!;
  }

  /** True while this provider's program is being replaced: a turn started now would run on half of it. */
  updating(providerId: ProviderId): boolean {
    return this.entries.get(providerId)?.state === 'updating';
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
    let deferred = false;
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
          if (this.busyThreads(update.providerId) > 0) {
            deferred = true;
            continue;
          }
          await this.update(update.providerId).catch((error: unknown) => {
            this.core.log('warn', `automatic update of ${update.providerId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
    } catch (error) {
      if (this.closed || this.core.stopping) return;
      this.core.log('warn', `checking agent updates: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.schedule(deferred ? BUSY_RETRY_MS : CHECK_EVERY_MS);
  }

  /** The route this provider updates by on this machine, null when there is none. */
  private targetOf(providerId: ProviderId): Target | null {
    const descriptor = this.core.providers.get(providerId);
    const summary = this.core.providers.summary(providerId);
    if (descriptor === undefined || summary === undefined || !summary.available) return null;
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
    if (runsManaged && profile.install !== undefined) return { descriptor, profile, route: 'managed' };
    // A download in flight belongs to the install card, not to this list.
    if (profile.update !== undefined && command !== null) return { descriptor, profile, route: 'self' };
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
          this.entries.set(id, { route: target.route, ...read, state: 'idle', message: null, checkedAt: Date.now() });
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

  private async read(target: Target): Promise<{ current: string | null; latest: string | null }> {
    if (target.route === 'managed') return this.readManaged(target);
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

  /** A managed release is read off disk and the descriptor's pin: nothing runs. */
  private readManaged(target: Target): { current: string | null; latest: string | null } {
    return { current: this.core.providers.installs.installedVersion(target.descriptor.id), latest: target.profile.install?.version ?? null };
  }

  /** One short run of the agent's own program, traced like every process of an agent. */
  private async run(target: Target, args: string[], timeoutMs: number): Promise<string> {
    this.assertOpen();
    const command = resolveCommand(target.profile);
    if (command === null) throw new Error(`${target.descriptor.name} is not on this machine any more`);
    const spawned = this.core.procs.spawnPiped(updateThreadId(target.descriptor.id), command.executable, [...command.prefix, ...args], {
      cwd: this.core.dataDir,
      env: { ...process.env, ...command.updateEnv },
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
        const last = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).at(-1);
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
      if (target.route === 'managed') await this.runManaged(target);
      else await this.run(target, (target.profile.update as ProviderSelfUpdate).args, UPDATE_TIMEOUT_MS);
      // An updater may have moved the program on PATH.
      forgetWhich();
      const read = await this.read(target);
      if (this.closed || this.core.stopping) return;
      const stuck = target.route === 'self' && before.current !== null && read.current === before.current && this.newer({ ...before, ...read });
      this.entries.set(id, {
        route: target.route,
        ...read,
        state: stuck ? 'failed' : 'idle',
        message: stuck ? `${target.descriptor.name} ran its updater and still reports ${read.current}` : null,
        checkedAt: Date.now(),
      });
      // A new release may list other models, and the path may have moved.
      forgetProbes({ providerId: id });
      forgetWhich();
      this.core.bus.emit('providers.updated', this.core.providers.list());
    } catch (error) {
      this.entries.set(id, { ...before, state: 'failed', message: error instanceof Error ? error.message : String(error), checkedAt: Date.now() });
    }
    this.writeReadings();
    this.emit();
  }

  /**
   * The install block's own download, waited on for as long as it takes: its
   * card shows the progress meanwhile, and the download fails by itself once
   * the connection stays dead. A download the install card already started is
   * joined rather than refused as already running.
   */
  private async runManaged(target: Target): Promise<void> {
    const id = target.descriptor.id;
    const installs = this.core.providers.installs;
    let done = installs.whenDone(id);
    if (done === null) {
      installs.start(id, target.profile.install!);
      done = installs.whenDone(id);
    }
    const result = await done;
    if (result === null || result.outcome === 'cancelled') throw new Error('the download was cancelled');
    if (result.state.state === 'failed') throw new Error(result.state.message);
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
    void this.read(target).then((read) => {
      if (this.entries.get(outcome.providerId)?.state === 'updating') return;
      this.put(outcome.providerId, { ...entry, ...read, state: 'idle', message: null, checkedAt: Date.now() });
      this.writeReadings();
    }).catch((error: unknown) => {
      this.core.log('warn', `reading ${outcome.providerId} after its install: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** True while any turn of any agent is queued, running or waiting. */
  private anyBusy(): boolean {
    return this.core.journal.unfinishedTurns().length > 0 ||
      this.core.journal.listThreads().some((thread) => ['queued', 'running', 'waiting'].includes(thread.status));
  }

  private busyThreads(providerId: ProviderId): number {
    const busy = new Set(this.core.journal
      .listThreads()
      .filter((thread) => thread.providerId === providerId && ['queued', 'running', 'waiting'].includes(thread.status))
      .map(thread => thread.id));
    // The picker changes the next turn, not the execution target already accepted.
    for (const turn of this.core.journal.unfinishedTurns()) {
      if (turn.execution?.providerId === providerId) busy.add(turn.threadId);
    }
    return busy.size;
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
