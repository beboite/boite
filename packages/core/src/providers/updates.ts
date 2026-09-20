import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HarnessUpdate, OsProfile, ProviderDescriptor, ProviderId, ProviderSelfUpdate } from '@boite/contracts';
import type { Core } from '../core.ts';
import { forgetProbes, releaseThread } from '../drivers/index.ts';
import { notFound, refused } from '../errors.ts';
import { profileFor, resolveCommand } from './loader.ts';

/** First check after the core is up, so nothing reaches the network at start. */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** An automatic update that found its provider busy looks again this often. */
const BUSY_RETRY_MS = 10 * 60 * 1000;
const VERSION_TIMEOUT_MS = 20_000;
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const SKIPS_FILE = 'harness-updates.json';
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
  return left.tag < right.tag ? -1 : 1;
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

async function npmLatest(name: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, {
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
  /** Test seams: the registry read, and the only providers a check may touch. */
  npmLatest: (name: string) => Promise<string> = npmLatest;
  only: ReadonlySet<ProviderId> | null = null;

  constructor(private readonly core: Core) {
    this.skips = this.readSkips();
  }

  /** Arms the periodic check. The core's entry point calls it; a test core never does. */
  start(): void {
    this.schedule(FIRST_CHECK_MS);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  async list(refresh = false): Promise<HarnessUpdate[]> {
    if (refresh || this.entries.size === 0) return this.check();
    return this.snapshot();
  }

  check(): Promise<HarnessUpdate[]> {
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async update(providerId: ProviderId): Promise<HarnessUpdate> {
    const target = this.targetOf(providerId);
    if (target === null) throw refused(`${providerId} has no update Boite can run on this machine`, { providerId });
    let entry = this.entries.get(providerId);
    if (entry === undefined) {
      await this.check();
      entry = this.entries.get(providerId);
    }
    if (entry === undefined) throw notFound('provider update', providerId);
    if (entry.state === 'updating') throw refused(`${target.descriptor.name} is already updating`, { providerId });
    if (!this.newer(entry)) {
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
      if (thread.providerId === providerId) releaseThread(thread.id);
    }
    this.put(providerId, { ...entry, state: 'updating', message: null });
    void this.runUpdate(target, entry).catch((error: unknown) => {
      this.core.log('error', `updating ${providerId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.describe(providerId)!;
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
      await this.check();
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
    const runsManaged =
      summary.install?.state === 'installed' &&
      command !== null &&
      resolve(command.executable).toLowerCase().startsWith(managedDir.toLowerCase());
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
    await Promise.all(
      targets.map(async (target) => {
        const id = target.descriptor.id;
        if (this.entries.get(id)?.state === 'updating') return;
        try {
          const read = await this.read(target);
          this.entries.set(id, { route: target.route, ...read, state: 'idle', message: null, checkedAt: Date.now() });
        } catch (error) {
          const previous = this.entries.get(id);
          this.entries.set(id, {
            route: target.route,
            current: previous?.current ?? null,
            latest: previous?.latest ?? null,
            state: 'failed',
            message: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now(),
          });
        }
      }),
    );
    this.emit();
    return this.snapshot();
  }

  private async read(target: Target): Promise<{ current: string | null; latest: string | null }> {
    const id = target.descriptor.id;
    if (target.route === 'managed') {
      const state = this.core.providers.installs.stateOf(id, target.profile.install);
      return state?.state === 'installed' ? { current: state.version, latest: state.available } : { current: null, latest: null };
    }
    const spec = target.profile.update as ProviderSelfUpdate;
    const current = readVersion(await this.run(target, spec.versionArgs ?? ['--version'], VERSION_TIMEOUT_MS));
    if (current === null) throw new Error(`${target.descriptor.name} printed no version`);
    let latest: string | null = null;
    if (spec.latestNpm !== undefined) latest = await this.npmLatest(spec.latestNpm);
    else if (spec.latestArgs !== undefined) {
      const output = await this.run(target, spec.latestArgs, VERSION_TIMEOUT_MS);
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

  /** One short run of the agent's own program, traced like every process of an agent. */
  private async run(target: Target, args: string[], timeoutMs: number): Promise<string> {
    const command = resolveCommand(target.profile);
    if (command === null) throw new Error(`${target.descriptor.name} is not on this machine any more`);
    const spawned = this.core.procs.spawnPiped(updateThreadId(target.descriptor.id), command.executable, [...command.prefix, ...args], {
      cwd: this.core.dataDir,
    });
    spawned.proc.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawned.proc.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(spawned.proc.stdout).text(),
        new Response(spawned.proc.stderr).text(),
        spawned.exited,
      ]);
      if (timedOut) throw new Error(`${target.descriptor.name} did not answer \`${args.join(' ')}\` within ${Math.round(timeoutMs / 1000)} s`);
      if (code !== 0) {
        const last = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).at(-1);
        throw new Error(`\`${args.join(' ')}\` exited with ${code}${last === undefined ? '' : `: ${last.slice(0, 300)}`}`);
      }
      return `${stdout}\n${stderr}`;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runUpdate(target: Target, before: Entry): Promise<void> {
    const id = target.descriptor.id;
    try {
      if (target.route === 'managed') await this.runManaged(target);
      else await this.run(target, (target.profile.update as ProviderSelfUpdate).args, UPDATE_TIMEOUT_MS);
      const read = await this.read(target);
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
      this.core.bus.emit('providers.updated', this.core.providers.list());
    } catch (error) {
      this.entries.set(id, { ...before, state: 'failed', message: error instanceof Error ? error.message : String(error), checkedAt: Date.now() });
    }
    this.emit();
  }

  /** The install block's own download, waited on: its card shows the progress meanwhile. */
  private async runManaged(target: Target): Promise<void> {
    const id = target.descriptor.id;
    const install = target.profile.install!;
    const installs = this.core.providers.installs;
    installs.start(id, install);
    const deadline = Date.now() + UPDATE_TIMEOUT_MS;
    for (;;) {
      await new Promise((done) => setTimeout(done, 250));
      const state = installs.stateOf(id, install);
      if (state === null || state.state === 'absent') throw new Error('the download was cancelled');
      if (state.state === 'installed') return;
      if (state.state === 'failed') throw new Error(state.message);
      if (Date.now() > deadline) throw new Error('the download did not finish in time');
    }
  }

  private busyThreads(providerId: ProviderId): number {
    return this.core.journal
      .listThreads()
      .filter((thread) => thread.providerId === providerId && ['queued', 'running', 'waiting'].includes(thread.status)).length;
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
    this.core.bus.emit('providers.updatesChanged', this.snapshot());
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

  private writeSkips(): void {
    writeFileSync(join(this.core.dataDir, SKIPS_FILE), `${JSON.stringify({ skipped: this.skips }, null, 2)}\n`);
  }
}

export function registerUpdateMethods(core: Core): void {
  core.router.register('providers.updates', (params) => core.updates.list(params.refresh === true));
  core.router.register('providers.update', (params) => core.updates.update(core.providers.require(params.providerId).id));
  core.router.register('providers.updateSkip', (params) => core.updates.skip(core.providers.require(params.providerId).id, params.version));
}
