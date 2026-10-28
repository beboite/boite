/*
 * The plugin store. A plugin is one native executable Boite downloads over
 * https, checks against the sha256 its manifest publishes, and runs through
 * `core.procs` for the features the manifest names. The recommended ones ship
 * in plugins/recommended.json; the owner adds others from a git URL, with
 * `plugins.inspect` showing the manifest before `plugins.add` installs it.
 *
 * An installed plugin is `<dataDir>/plugins/<id>/`: the executable and
 * `installed.json`, which records the manifest it came from, the commit a URL
 * resolved to and when. That directory is all an install writes, so uninstall
 * deletes it and nothing else. docs/plugins.md is the authoring guide.
 *
 * A recommended entry may name an update source; plugins/updates.ts reads it
 * and the newest of the pinned entry, the release found there and the install
 * is what Install and Update bring.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { threadActive, PLUGIN_MANIFEST_FILE } from '@boite/contracts';
import type { PluginArtifact, PluginManifest, PluginPool, PluginPreview, PluginRejected, PluginSource, PluginState, RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused } from './errors.ts';
import { newToken } from './ids.ts';
import {
  ManifestRefused,
  POOL_COMMANDS,
  artifactFor,
  commandsOf,
  isPluginId,
  isRecord,
  parseManifest,
  parseManifestText,
  platformKey,
  poolsOf,
  providesApp,
  providesGateway,
  refusal,
} from './plugins/manifest.ts';
import { PluginApps } from './plugins/apps.ts';
import { DOUANE_PLUGIN, PluginGateways } from './plugins/gateway.ts';
import { recoverActivation, switchRelease, type Activation } from './plugins/activation.ts';
import { PluginLanes } from './plugins/lanes.ts';
import { checkRef, fetchManifest, normalizeSourceUrl } from './plugins/source.ts';
import { PluginUpdateChecks, compareVersions, parseRecommendedEntry, type UpdateSource } from './plugins/updates.ts';
import recommendedList from './plugins/recommended.json';

const INSTALLED_FILE = 'installed.json';
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** A download that receives nothing for this long stops; one still receiving goes on, up to the ceiling. */
const DOWNLOAD_IDLE_MS = 30_000;
const DOWNLOAD_CEILING_MS = 30 * 60_000;
/** How long an install waits on its update source before taking the newest version it already knows. */
const INSTALL_SOURCE_WAIT_MS = 15_000;
const RUN_MAX_BYTES = 4 * 1024 * 1024;
const RUN_TIMEOUT_MS = 60_000;
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_MAX = 16;

let recommendedEntries: ReturnType<typeof parseRecommendedEntry>[] | undefined;
/** The recommended entries, parsed on the first plugins call rather than at every start. A bad entry fails the core's own tests. */
function parsedRecommended(): ReturnType<typeof parseRecommendedEntry>[] {
  return recommendedEntries ??= (recommendedList as unknown[]).map((raw, index) => parseRecommendedEntry(raw, `recommended.json[${index}]`));
}
/** The recommended plugins. */
export function recommendedPlugins(): PluginManifest[] { return parsedRecommended().map((entry) => entry.manifest); }
/** Where an entry's newer releases are published, by id, for the entries that name one. */
export function recommendedUpdates(): Record<string, UpdateSource> {
  return Object.fromEntries(parsedRecommended().flatMap((entry) => (entry.updates === null ? [] : [[entry.manifest.id, entry.updates]])));
}

export function verifyPluginDownload(bytes: Uint8Array, digest: string, name = 'plugin'): void {
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error(`${name} download sha256 does not match the one its manifest publishes.`);
  }
}

/** One `list -<pool> -Json` answer, the account pool contract docs/plugins.md describes. */
export function parsePluginPool(provider: string, text: string, name = 'plugin'): PluginPool {
  let raw: { accounts?: unknown };
  try { raw = JSON.parse(text) as { accounts?: unknown }; }
  catch { throw new Error(`${name} ${provider} returned invalid JSON.`); }
  if (!raw || typeof raw !== 'object') throw new Error(`${name} ${provider} JSON must be an object.`);
  if (!Array.isArray(raw.accounts)) throw new Error(`${name} ${provider} JSON must contain an accounts array.`);
  return { provider, accounts: raw.accounts.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error(`${name} ${provider} account must be an object.`);
    const row = value as Record<string, unknown>;
    if (typeof row['email'] !== 'string' || !row['email']) throw new Error(`${name} ${provider} account.email must be a nonempty string.`);
    return { email: row['email'], active: row['live'] === true,
      checkedSecondsAgo: typeof row['checkedSecondsAgo'] === 'number' ? row['checkedSecondsAgo'] : null,
      windows: [['fiveHour', '5 hours'], ['sevenDay', 'Weekly']].flatMap(([key, label]) => {
        const percent = row[key!];
        // The list JSON reports percentages but no per-window reset time.
        return typeof percent === 'number' && Number.isFinite(percent) ? [{ id: key!, label: label!, usedPercent: Math.max(0, Math.min(100, percent)), resetsAt: null }] : [];
      }),
    };
  }) };
}

type Origin = PluginState['origin'];

interface Installed {
  version: string;
  origin: Origin;
  source: PluginSource | null;
  manifest: PluginManifest;
  binary: string;
}

type OnDisk =
  | { kind: 'none' }
  | { kind: 'installed'; installed: Installed }
  | { kind: 'error'; message: string }
  | { kind: 'rejected'; rejected: PluginRejected };

interface Job {
  controller: AbortController;
  progress: number;
  promise: Promise<void>;
  /** The install finished, or stopped the desktop app to replace its binary: start the app again after. */
  relaunch: boolean;
}

interface Pending {
  manifest: PluginManifest;
  source: PluginSource;
}

/** installed.json as `plugins.add` and `plugins.install` write it. */
function readRecord(data: Record<string, unknown>, file: string, id: string, dir: string): Omit<Installed, 'binary'> {
  const keys = ['schema', 'origin', 'source', 'installedAt', 'manifest'];
  for (const key of Object.keys(data)) if (!keys.includes(key)) throw refusal(file, key, `one of ${keys.join(', ')}`, key);
  if (data['schema'] !== 1) throw refusal(file, 'schema', '1', data['schema']);
  const origin = data['origin'];
  if (origin !== 'recommended' && origin !== 'url') throw refusal(file, 'origin', 'recommended or url', origin);
  if (typeof data['installedAt'] !== 'number') throw refusal(file, 'installedAt', 'a timestamp in milliseconds', data['installedAt']);
  const manifest = parseManifest(data['manifest'], file, 'manifest.');
  if (manifest.id !== id) throw refusal(file, 'manifest.id', `${id}, the name of ${dir}`, manifest.id);
  let source: PluginSource | null = null;
  if (origin === 'url') {
    const raw = data['source'];
    if (!isRecord(raw)) throw refusal(file, 'source', 'an object with url, ref and commit', raw);
    if (typeof raw['url'] !== 'string' || raw['url'].length === 0) throw refusal(file, 'source.url', 'the repository URL', raw['url']);
    if (typeof raw['ref'] !== 'string' || raw['ref'].length === 0) throw refusal(file, 'source.ref', 'a branch, tag or commit', raw['ref']);
    if (typeof raw['commit'] !== 'string' || !/^[0-9a-f]{40,64}$/.test(raw['commit'])) throw refusal(file, 'source.commit', 'a full commit hash', raw['commit']);
    source = { url: raw['url'], ref: raw['ref'], commit: raw['commit'] };
  } else if (data['source'] !== null) {
    throw refusal(file, 'source', 'null for a recommended plugin', data['source']);
  }
  return { version: manifest.version, origin, source, manifest };
}

/** Windows holds an executable a moment after its process exits. */
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw refused(`could not remove ${path}: ${messageOf(error)}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

export class PluginStore {
  #recommended: PluginManifest[] | undefined;
  #updateSources: Record<string, UpdateSource> | undefined;
  /** The manifests `plugins.list` offers. Tests swap an entry to point an install at a fixture. */
  get recommended(): PluginManifest[] { return this.#recommended ??= recommendedPlugins(); }
  set recommended(value: PluginManifest[]) { this.#recommended = value; }
  /** The update source of each recommended entry that names one. Tests swap it like `recommended`. */
  get updateSources(): Record<string, UpdateSource> { return this.#updateSources ??= recommendedUpdates(); }
  set updateSources(value: Record<string, UpdateSource>) { this.#updateSources = value; }
  /** Lets `plugins.inspect` read a repository by its path on disk. Tests only; no client can set it. */
  allowLocalSources = false;
  /** Test seam: how an update source is read. The git path of `plugins.inspect` otherwise. */
  readUpdateSource = (source: UpdateSource): Promise<{ commit: string; text: string | null }> =>
    fetchManifest(this.core, source.url, source.ref, { allowLocal: this.allowLocalSources, signal: this.shutdown.signal });

  private jobs = new Map<string, Job>();
  private failures = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private previews = new Map<string, Pending & { expiresAt: number }>();
  private running = new Map<string, string>();
  private exits = new Set<Promise<number>>();
  private listings = new Map<string, Promise<PluginPool[]>>();
  private cache = new Map<string, { pools: PluginPool[]; at: number }>();
  private action: { id: string; provider: string } | null = null;
  private inspecting = new Set<Promise<unknown>>();
  private shutdown = new AbortController();
  private sequence = 0;
  private closing = false;
  /** Install and uninstall hold a plugin alone; its commands share it. */
  private lanes = new PluginLanes();

  /** Test seam: how long a download may receive nothing. */
  downloadIdleMs = DOWNLOAD_IDLE_MS;

  /** The desktop apps plugins provide: started, stopped and relaunched here. */
  readonly apps: PluginApps;
  /** The gateways plugins provide: run in the background on a loopback port. */
  readonly gateways: PluginGateways;
  /** Newer releases of recommended plugins, read from the update sources the list names. */
  readonly updates: PluginUpdateChecks;

  constructor(private core: Core) {
    this.updates = new PluginUpdateChecks({
      // The admin policy's `plugins.recommended: false` leaves every source unread.
      source: (id) => (core.policy.recommendedPluginsOff() || this.recommendedManifest(id) === null ? null : this.updateSources[id] ?? null),
      ids: () => core.policy.recommendedPluginsOff() ? [] : this.recommended.map((manifest) => manifest.id).filter((id) => this.updateSources[id] !== undefined),
      pinned: (id) => this.recommendedManifest(id),
      installed: (id) => {
        try {
          const disk = this.onDisk(id);
          return disk.kind === 'installed' ? disk.installed.version : null;
        } catch {
          return null;
        }
      },
      read: (source) => this.readUpdateSource(source),
      changed: (id) => this.emit(id),
      log: (level, message) => core.log(level, message),
    });
    this.apps = new PluginApps({
      procs: core.procs,
      coreUrl: () => core.baseUrl(),
      ownerToken: () => core.token,
      log: (level, message) => core.log(level, message),
      installed: (id) => {
        const disk = this.onDisk(id);
        if (disk.kind !== 'installed' || !providesApp(disk.installed.manifest)) return null;
        return { binary: disk.installed.binary, dir: this.directory(id) };
      },
      changed: (id) => this.emit(id),
    });
    this.gateways = new PluginGateways({
      procs: core.procs,
      dataDir: core.dataDir,
      log: (level, message, event) => core.logs.record(level, message, { source: 'plugins', event }),
      getSetting: (key) => core.journal.getSetting(key),
      setSetting: (key, value) => core.journal.setSetting(key, value),
      installed: (id) => {
        const disk = this.onDisk(id);
        if (disk.kind !== 'installed' || !providesGateway(disk.installed.manifest)) return null;
        return { binary: disk.installed.binary, executable: disk.installed.manifest.executable };
      },
      changed: (id) => this.emit(id),
      moved: (id, port) => { if (id === DOUANE_PLUGIN) core.settings.followGateway(port); },
    });
  }

  private root(): string {
    return resolve(this.core.dataDir, 'plugins');
  }

  private directory(id: string): string {
    const root = this.root();
    const dir = resolve(root, id);
    // A cancelled install can remove its directory while state is being polled.
    for (const path of [root, dir]) if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw refused(`plugin path ${path} must not be a symbolic link`);
    return dir;
  }

  private binaryPath(dir: string, manifest: PluginManifest): string {
    return join(dir, process.platform === 'win32' ? `${manifest.executable}.exe` : manifest.executable);
  }

  private recommendedManifest(id: string): PluginManifest | null {
    return this.recommended.find((manifest) => manifest.id === id) ?? null;
  }

  /**
   * What installing a recommended plugin brings: the newest of the pinned
   * entry, a release its update source offers and the manifest installed.
   * The installed one only wins a tie, so a retry reinstalls it rather than
   * going back to an older pinned entry.
   */
  private recommendedTarget(id: string, installed: Installed | null): PluginManifest | null {
    const pinned = this.recommendedManifest(id);
    if (pinned === null) return null;
    let best = installed?.origin === 'recommended' && installed.manifest.id === id ? installed.manifest : pinned;
    for (const candidate of [pinned, this.updates.offered(id)?.manifest ?? null]) {
      if (candidate !== null && compareVersions(candidate.version, best.version) > 0) best = candidate;
    }
    return best;
  }

  /** The id, when it names a recommended plugin or one this core has anything of. */
  private known(id: unknown): string {
    const expected = `a plugin id from plugins.list: ${this.recommended.map((manifest) => manifest.id).join(', ')} or one added from a URL`;
    if (isPluginId(id) && (this.recommendedManifest(id) !== null || this.pending.has(id) || this.jobs.has(id) || existsSync(join(this.root(), id)))) return id;
    throw invalidParams(`unknown plugin ${String(id)}; expected ${expected}`, { field: 'id', expected });
  }

  /**
   * What the plugin's directory holds. A manifest a power loss truncated must
   * not take the Plugins page with it: the state carries the file and what was
   * expected, and the page can still reinstall or remove.
   */
  private onDisk(id: string): OnDisk {
    const dir = this.directory(id);
    // An activation a stopped core left half done settles first, unless it is this core's own, still running.
    if (this.lanes.rewrite(id) === null) {
      try {
        if (recoverActivation(dir) === 'restored') this.core.log('warn', `plugin ${id}: an update that did not finish was rolled back`);
      } catch (error) {
        return { kind: 'error', message: `${dir} holds an update that did not finish and could not be rolled back (${messageOf(error)}). Reinstall ${id}.` };
      }
    }
    const file = join(dir, INSTALLED_FILE);
    if (!existsSync(file)) return { kind: 'none' };
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { kind: 'error', message: `${file} is not readable JSON (${messageOf(error)}). Reinstall ${id}.` };
    }
    if (!isRecord(data)) return { kind: 'error', message: `${file} must be a JSON object. Reinstall ${id}.` };
    let record: Omit<Installed, 'binary'>;
    try {
      record = readRecord(data, file, id, dir);
    } catch (error) {
      if (error instanceof ManifestRefused) return { kind: 'rejected', rejected: error.rejected };
      throw error;
    }
    const binary = this.binaryPath(dir, record.manifest);
    if (!existsSync(binary)) return { kind: 'error', message: `${binary} is missing. Reinstall ${id}.` };
    return { kind: 'installed', installed: { ...record, binary } };
  }

  state(id: string): PluginState {
    const recommended = this.recommendedManifest(id);
    const disk = this.onDisk(id);
    const job = this.jobs.get(id);
    const pending = this.pending.get(id);
    const installed = disk.kind === 'installed' ? disk.installed : null;
    // What an install brings; the recommended list wins, then a URL add in progress.
    const target = this.recommendedTarget(id, installed) ?? pending?.manifest ?? installed?.manifest ?? null;
    const running = installed?.manifest ?? target;
    const failure = this.failures.get(id) ?? (disk.kind === 'error' ? disk.message : null);
    return {
      id,
      name: target?.name ?? id,
      origin: recommended !== null ? 'recommended' : 'url',
      description: target?.description ?? '',
      homepage: target?.homepage ?? null,
      version: installed?.version ?? null,
      availableVersion: target?.version ?? null,
      status: job ? 'installing' : disk.kind === 'rejected' ? 'rejected' : failure !== null ? 'error' : installed ? 'installed' : 'not-installed',
      progress: job?.progress ?? 0,
      error: failure,
      source: recommended !== null ? null : installed?.source ?? pending?.source ?? null,
      artifact: target ? artifactFor(target) : null,
      platform: platformKey(),
      commands: running ? commandsOf(running) : [],
      pools: running ? poolsOf(running) : [],
      rejected: disk.kind === 'rejected' ? disk.rejected : null,
      app: running !== null && providesApp(running) ? this.apps.state(id, this.directory(id)) : null,
      gateway: running !== null && providesGateway(running) ? this.gateways.state(id, this.directory(id)) : null,
      updates: recommended !== null ? this.updates.state(id) : null,
    };
  }

  /** The recommended plugins in their list order, then the URL ones by id. */
  list(): PluginState[] {
    return this.ids().map((id) => this.state(id));
  }

  /** Every plugin id the store knows: recommended, being installed or with an install on disk. */
  private ids(): string[] {
    const ids = new Set<string>([...this.pending.keys(), ...this.jobs.keys()]);
    const root = this.root();
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        // `.fetch-*` is a repository `plugins.inspect` is reading.
        if (!entry.isDirectory() || entry.name.startsWith('.') || !isPluginId(entry.name)) continue;
        if (existsSync(join(root, entry.name, INSTALLED_FILE))) ids.add(entry.name);
      }
    }
    for (const manifest of this.recommended) ids.delete(manifest.id);
    return [...this.recommended.map((manifest) => manifest.id), ...[...ids].sort()];
  }

  private emit(id: string): void {
    try {
      this.core.bus.emit('plugins.updated', this.state(id));
    } catch (error) {
      this.core.log('warn', `plugin ${id} state unreadable: ${messageOf(error)}`);
    }
  }

  /** Installs a recommended plugin, or reinstalls a URL one from the manifest it recorded. */
  install(id: string): PluginState {
    this.core.policy.assert(this.core.policy.pluginInstallsOff(), 'plugins.install', id);
    this.known(id);
    if (this.jobs.has(id)) return this.state(id);
    const recommended = this.recommendedManifest(id);
    if (recommended !== null) {
      const target = () => {
        const disk = this.onDisk(id);
        return this.recommendedTarget(id, disk.kind === 'installed' ? disk.installed : null) ?? recommended;
      };
      // The pinned entry can be releases behind its source, and the periodic
      // checks read only installed plugins: the source is read first, so a
      // first install brings the latest release rather than the pinned one.
      const latest = this.updateSources[id] === undefined ? undefined : async (signal: AbortSignal) => {
        const aborted = new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }));
        await Promise.race([this.updates.check([id]), Bun.sleep(INSTALL_SOURCE_WAIT_MS), aborted]);
        return target();
      };
      return this.start(id, target(), null, 'recommended', latest);
    }
    const pending = this.pending.get(id);
    if (pending !== undefined) return this.start(id, pending.manifest, pending.source, 'url');
    const disk = this.onDisk(id);
    if (disk.kind === 'installed' && disk.installed.source !== null) return this.start(id, disk.installed.manifest, disk.installed.source, 'url');
    if (disk.kind === 'rejected') throw refused(`${id} was refused (${disk.rejected.message}). Remove it, then add it again from its URL.`, disk.rejected);
    throw refused(`${id} has no manifest to reinstall from. Remove it, then add it again from its URL.`);
  }

  /** `latest`, when given, may swap `manifest` for a newer one before the download starts. */
  private start(id: string, manifest: PluginManifest, source: PluginSource | null, origin: Origin, latest?: (signal: AbortSignal) => Promise<PluginManifest>): PluginState {
    if (this.closing) throw refused('Boite is shutting down.');
    if (this.lanes.busy(id)) throw refused('Wait for the current plugin operation before installing.');
    const artifact = artifactFor(manifest);
    if (artifact === null) throw refused(`${id} has no binary for ${platformKey()}`);
    this.failures.delete(id);
    // A first install that fails leaves nothing behind; an update that fails keeps the version that worked.
    const fresh = this.onDisk(id).kind !== 'installed';
    const controller = new AbortController();
    const job: Job = { controller, progress: 0, promise: Promise.resolve(), relaunch: false };
    this.jobs.set(id, job);
    job.promise = this.lanes.alone(id, 'install', () => (latest === undefined ? Promise.resolve(manifest) : latest(controller.signal))
      .then((target) => {
        const found = target === manifest ? artifact : artifactFor(target);
        if (found === null) throw new Error(`${id} ${target.version} has no binary for ${platformKey()}`);
        return this.download(id, target, source, origin, found, job);
      })
      .then(() => { this.pending.delete(id); job.relaunch = true; })
      .catch(async (error: unknown) => {
        if (!controller.signal.aborted) this.failures.set(id, messageOf(error));
        if (fresh) await removeTree(this.directory(id)).catch(() => undefined);
        if (fresh && controller.signal.aborted) this.pending.delete(id);
      })
      .finally(() => {
        this.jobs.delete(id);
        this.cache.delete(id);
        this.emit(id);
        if (job.relaunch) this.resumeApp(id);
      }), 'Wait for the current plugin operation before installing.');
    this.emit(id);
    return this.state(id);
  }

  private async download(id: string, manifest: PluginManifest, source: PluginSource | null, origin: Origin, artifact: PluginArtifact, job: Job): Promise<void> {
    const signal = job.controller.signal;
    const dir = this.directory(id);
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, 'download.part');
    // An idle timer rather than a deadline on the whole transfer: a slow link that
    // keeps sending finishes, a silent one stops with words saying so.
    let size = 0;
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error(`${id} download stalled: no data for ${Math.round(this.downloadIdleMs / 1000)} seconds after ${size} bytes.`)), this.downloadIdleMs);
    };
    const ceiling = setTimeout(() => idle.abort(new Error(`${id} download did not finish within ${DOWNLOAD_CEILING_MS / 60_000} minutes.`)), DOWNLOAD_CEILING_MS);
    const stop = AbortSignal.any([signal, idle.signal]);
    // A body already handed over does not always hear the abort: every wait races it.
    const stopped = new Promise<never>((_, reject) => stop.addEventListener('abort', () => reject(stop.reason), { once: true }));
    stopped.catch(() => undefined);
    try {
      arm();
      const response = await Promise.race([fetch(artifact.url, { signal: stop }), stopped]);
      if (response.url !== '' && !response.url.startsWith('https://')) {
        throw new Error(`${id} download was redirected to ${response.url}; artifacts come over https only.`);
      }
      if (!response.ok || !response.body) throw new Error(`${id} download returned HTTP ${response.status}.`);
      const declared = Number(response.headers.get('content-length'));
      if (declared > DOWNLOAD_MAX_BYTES) throw new Error(`${id} download is ${declared} bytes, past the 64 MB a plugin may take.`);
      const total = declared || 3_000_000;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await Promise.race([reader.read(), stopped]);
          if (chunk.done) break;
          arm();
          size += chunk.value.length;
          if (size > DOWNLOAD_MAX_BYTES) throw new Error(`${id} download exceeds the 64 MB a plugin may take.`);
          chunks.push(chunk.value);
          const progress = Math.min(95, Math.floor(size / total * 95));
          if (progress !== job.progress) { job.progress = progress; this.emit(id); }
        }
      } finally { clearTimeout(timer); clearTimeout(ceiling); void reader.cancel().catch(() => undefined); }
      const bytes = Buffer.concat(chunks);
      verifyPluginDownload(bytes, artifact.sha256, id);
      signal.throwIfAborted();
      await writeFile(temporary, bytes, { mode: 0o700 });
      if (process.platform !== 'win32') await chmod(temporary, 0o700);
      signal.throwIfAborted();
      const previous = this.onDisk(id);
      const installed = previous.kind === 'installed' ? previous.installed : null;
      // Windows locks a running executable: the app stops before its binary is replaced.
      if (installed !== null && providesApp(installed.manifest)) {
        job.relaunch = true;
        await this.apps.kill(id);
      }
      // A gateway still serving would be cut off: it waits for its requests like an update, then stops.
      const ran = installed !== null && providesGateway(installed.manifest) && await this.gateways.drainForUpdate(id, manifest.version);
      await this.activate(id, dir, installed, manifest, temporary, ran, JSON.stringify({ schema: 1, origin, source, installedAt: Date.now(), manifest }, null, 2));
      job.progress = 100;
    } finally {
      clearTimeout(timer);
      clearTimeout(ceiling);
      await rm(temporary, { force: true });
    }
  }

  /**
   * The new binary and its record replace the previous ones together
   * (`plugins/activation.ts`). A gateway that ran before starts from the new
   * binary and must answer `/health` before the record commits; when it does
   * not, or the record cannot be written, the previous binary and record go
   * back, the previous gateway starts again, and the update fails with the
   * reason, keeping the version that worked.
   */
  private async activate(id: string, dir: string, previous: Installed | null, manifest: PluginManifest, temporary: string, ran: boolean, record: string): Promise<void> {
    const binary = this.binaryPath(dir, manifest);
    let activation: Activation | null = null;
    let why: string | null = null;
    try {
      activation = switchRelease(dir, { previous: previous?.binary ?? null, binary, temporary, record });
      // The record names the previous release until the commit: the gateway is handed the new binary.
      if (ran && providesGateway(manifest) && !await this.gateways.launch(id, false, { binary, executable: manifest.executable, replaces: previous?.manifest.executable ?? null })) {
        why = this.gateways.state(id, dir).error ?? `${id} ${manifest.version} did not start`;
        throw new Error(why);
      }
      activation.commit();
    } catch (error) {
      if (ran) await this.gateways.kill(id);
      activation?.rollback();
      if (!ran || previous === null) throw error;
      const restarted = await this.gateways.launch(id);
      if (!restarted) {
        throw new Error(`${why ?? messageOf(error)}. ${previous.version} did not start again: ${this.gateways.state(id, dir).error ?? 'the gateway is not running'}.`);
      }
      throw new Error(`${why ?? messageOf(error)}. ${previous.version} runs again.`);
    }
  }

  /**
   * Fetches the repository at `ref` and reads its manifest. Nothing is
   * downloaded or run; the preview is what the owner confirms.
   */
  async inspect(params: RpcParams<'plugins.inspect'>): Promise<PluginPreview> {
    if (this.closing) throw refused('Boite is shutting down.');
    const url = normalizeSourceUrl(params.url, this.allowLocalSources);
    const ref = checkRef(params.ref);
    const fetching = fetchManifest(this.core, url, ref, { allowLocal: this.allowLocalSources, signal: this.shutdown.signal });
    this.inspecting.add(fetching);
    let fetched: Awaited<typeof fetching>;
    try { fetched = await fetching; } finally { this.inspecting.delete(fetching); }
    const source: PluginSource = { url, ref, commit: fetched.commit };
    const preview: PluginPreview = {
      previewId: null, source, manifest: null, rejected: null, artifact: null,
      platform: platformKey(), commands: [], replaces: null, expiresAt: Date.now() + PREVIEW_TTL_MS,
    };
    if (fetched.text === null) {
      const rejected = refusal(PLUGIN_MANIFEST_FILE, '(file)', `a ${PLUGIN_MANIFEST_FILE} at the root of the repository`, undefined).rejected;
      return { ...preview, rejected };
    }
    let manifest: PluginManifest;
    try {
      manifest = parseManifestText(fetched.text, PLUGIN_MANIFEST_FILE);
    } catch (error) {
      if (error instanceof ManifestRefused) return { ...preview, rejected: error.rejected };
      throw error;
    }
    const read: PluginPreview = { ...preview, manifest, artifact: artifactFor(manifest), commands: commandsOf(manifest) };
    const conflict = this.conflict(manifest, url);
    if (conflict !== null) return { ...read, rejected: conflict };
    if (read.artifact === null) {
      const published = Object.keys(manifest.artifacts).join(', ');
      return { ...read, rejected: refusal(PLUGIN_MANIFEST_FILE, 'artifacts', `an artifact for ${platformKey()}, this machine`, published).rejected };
    }
    this.prunePreviews();
    const previewId = newToken();
    this.previews.set(previewId, { manifest, source, expiresAt: preview.expiresAt });
    const disk = this.onDisk(manifest.id);
    return { ...read, previewId, replaces: disk.kind === 'installed' ? disk.installed.version : null };
  }

  /**
   * Why `manifest` cannot take its id here, or null. A recommended id stays
   * the recommended plugin's; an id added from one URL is not taken over by
   * another. The same URL again is an update.
   */
  private conflict(manifest: PluginManifest, url: string): PluginRejected | null {
    const found = manifest.id;
    if (this.recommendedManifest(found) !== null) {
      return refusal(PLUGIN_MANIFEST_FILE, 'id', `an id no recommended plugin uses (${this.recommended.map((entry) => entry.id).join(', ')})`, found).rejected;
    }
    const pending = this.pending.get(found);
    const disk = this.onDisk(found);
    const taken = pending?.source.url ?? (disk.kind === 'installed' ? disk.installed.source?.url ?? null : null);
    if (taken !== null && taken !== url) {
      return refusal(PLUGIN_MANIFEST_FILE, 'id', `an id not already used by the plugin from ${taken}`, found).rejected;
    }
    if (taken === null && (disk.kind === 'rejected' || disk.kind === 'error')) {
      return refusal(PLUGIN_MANIFEST_FILE, 'id', `an id free of the broken ${found} already installed; remove it first`, found).rejected;
    }
    return null;
  }

  private prunePreviews(): void {
    const now = Date.now();
    for (const [key, preview] of this.previews) if (preview.expiresAt <= now) this.previews.delete(key);
    while (this.previews.size >= PREVIEW_MAX) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
  }

  /** Installs what one preview showed, at the commit it showed. A preview is used once. */
  add(previewId: unknown): PluginState {
    const expected = 'a previewId plugins.inspect returned in the last 10 minutes';
    if (typeof previewId !== 'string') throw invalidParams(`plugin previewId must be ${expected}`, { field: 'previewId', expected });
    const preview = this.previews.get(previewId);
    if (preview === undefined || preview.expiresAt <= Date.now()) {
      this.previews.delete(previewId);
      throw invalidParams(`plugin preview is unknown or expired; inspect the URL again`, { field: 'previewId', expected });
    }
    this.previews.delete(previewId);
    const { manifest, source } = preview;
    const conflict = this.conflict(manifest, source.url);
    if (conflict !== null) throw refused(conflict.message, conflict);
    if (this.lanes.busy(manifest.id)) throw refused('Wait for the current plugin operation before installing.');
    const before = this.pending.get(manifest.id);
    this.pending.set(manifest.id, { manifest, source });
    try {
      return this.start(manifest.id, manifest, source, 'url');
    } catch (error) {
      if (before === undefined) this.pending.delete(manifest.id);
      else this.pending.set(manifest.id, before);
      throw error;
    }
  }

  async cancel(id: string): Promise<PluginState> {
    this.known(id);
    const job = this.jobs.get(id);
    if (job !== undefined) {
      job.controller.abort();
      await job.promise;
    }
    return this.state(id);
  }

  /** Deletes the plugin's directory, the whole of what its install wrote. */
  async uninstall(id: string): Promise<PluginState> {
    this.known(id);
    // Held before the first await: an install or a start asked for meanwhile is refused, not erased.
    return this.lanes.alone(id, 'uninstall', async () => {
      await this.apps.forget(id);
      // Its data directory stays: a gateway's sign-ins outlive its program.
      await this.gateways.forget(id);
      await removeTree(this.directory(id));
      this.pending.delete(id);
      this.failures.delete(id);
      this.cache.delete(id);
      return this.state(id);
    }, 'Wait for the current plugin operation before uninstalling.').then((state) => {
      this.core.bus.emit('plugins.updated', state);
      return state;
    });
  }

  /** The installed plugin an account call runs, or the reason there is none. */
  private usable(id: string): Installed {
    if (this.closing) throw refused('Boite is shutting down.');
    this.lanes.assertUsable(id);
    const disk = this.onDisk(id);
    if (disk.kind === 'rejected') throw refused(`${id} was refused: ${disk.rejected.message}`, disk.rejected);
    if (disk.kind !== 'installed') throw refused(`Install ${id} first.`);
    return disk.installed;
  }

  private async run(id: string, installed: Installed, args: string[]): Promise<string> {
    if (this.closing) throw refused('Boite is shutting down.');
    const threadId = `plugin:${id}:${++this.sequence}`;
    const spawned = this.core.procs.spawn(threadId, installed.binary, args, { cwd: this.directory(id) });
    this.running.set(threadId, id);
    this.exits.add(spawned.exited);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > RUN_MAX_BYTES) throw new Error(`${id} output exceeds 4 MB.`);
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    };
    try {
      const output = Promise.all([read(spawned.proc.stdout), read(spawned.proc.stderr), spawned.exited]);
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${id} did not finish within 60 seconds.`)), RUN_TIMEOUT_MS); });
      const [stdout, , code] = await Promise.race([output, expired]);
      // Never forward the executable's own output: it may carry login material.
      if (code !== 0) throw new Error(`${installed.manifest.executable} ${args.slice(0, 2).join(' ')} failed with exit code ${code}.`);
      return stdout;
    } finally {
      clearTimeout(timer);
      this.core.procs.killTree(threadId);
      await spawned.exited;
      this.running.delete(threadId);
      this.exits.delete(spawned.exited);
    }
  }

  async accounts(id: string, refresh = false): Promise<PluginPool[]> {
    this.known(id);
    const installed = this.usable(id);
    const listing = this.listings.get(id);
    if (listing !== undefined) return listing;
    const cached = this.cache.get(id);
    if (cached !== undefined && Date.now() - cached.at < (refresh ? 10_000 : 60_000)) return cached.pools;
    const promise = this.lanes.shared(id, async () => {
      const pools: PluginPool[] = [];
      for (const provider of poolsOf(installed.manifest)) {
        pools.push(parsePluginPool(provider, await this.run(id, installed, [...POOL_COMMANDS.list(provider, refresh)]), installed.manifest.executable));
      }
      this.cache.set(id, { pools, at: Date.now() });
      return pools;
    });
    this.listings.set(id, promise);
    try { return await promise; } finally { this.listings.delete(id); }
  }

  blocksAccount(accountId: string): boolean {
    if (this.action === null) return false;
    const account = this.core.journal.getAccount(accountId);
    return account?.providerId === this.action.provider && account.isolationDir === null;
  }

  async accountAction(params: RpcParams<'plugins.accountAction'>): Promise<PluginPool[]> {
    const id = this.known(params.id);
    const installed = this.usable(id);
    const pools = poolsOf(installed.manifest);
    if (!pools.includes(params.provider)) throw invalidParams(`plugin provider must be one of ${pools.join(', ')}`, { field: 'provider' });
    if (!['add', 'switch', 'remove'].includes(params.action)) throw invalidParams('plugin action must be add, switch or remove', { field: 'action' });
    if (params.action !== 'add' && (typeof params.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(params.email))) throw invalidParams('plugin email must be an email address', { field: 'email' });
    // One login change at a time across plugins: `blocksAccount` holds the scheduler for one provider.
    if (this.action !== null || this.listings.has(id)) throw refused('Wait for the current plugin operation to finish.');
    return this.lanes.shared(id, () => this.changeLogin(id, installed, params));
  }

  private async changeLogin(id: string, installed: Installed, params: RpcParams<'plugins.accountAction'>): Promise<PluginPool[]> {
    this.action = { id, provider: params.provider };
    try {
      const affected = this.core.journal.listThreads().filter((thread) => this.blocksAccount(thread.accountId));
      if (this.core.scheduler.activeAccountIds().some((accountId) => this.blocksAccount(accountId))) throw refused('Stop this provider\'s default-account turns before changing its saved login.');
      if (affected.some((thread) => threadActive(thread.status))) throw refused('Stop this provider\'s default-account turns before changing its saved login.');
      for (const thread of affected) this.core.threads.releaseAgent(thread.id);
      const args = params.action === 'add' ? POOL_COMMANDS.add(params.provider)
        : params.action === 'switch' ? POOL_COMMANDS.switch(params.provider, params.email!)
        : POOL_COMMANDS.remove(params.provider, params.email!);
      await this.run(id, installed, [...args]);
      if (this.closing) throw refused('Boite is shutting down.');
      this.cache.delete(id);
      // The saved login changed hands: its last quota reading is someone else's now.
      this.core.quotas.forget((accountId) => this.blocksAccount(accountId));
      this.core.quotas.invalidate();
      // Announced whatever the status reads: a switch between two signed-in
      // logins leaves it at 'ok', yet the model lists belong to the old login.
      for (const account of this.core.accounts.list()) if (this.blocksAccount(account.id)) this.core.accounts.check(account.id, true);
      return await this.accounts(id);
    } finally {
      this.action = null;
      if (!this.closing) this.core.scheduler.onSettingsChanged();
    }
  }

  /** Starts the plugin's desktop app and gateway it provides: at core start those that start with it, after an install those left enabled. */
  private resumeApp(id: string, atStart = false): void {
    if (this.closing) return;
    try {
      const disk = this.onDisk(id);
      if (disk.kind === 'installed' && providesApp(disk.installed.manifest)) this.apps.resume(id, this.directory(id), atStart);
      if (disk.kind === 'installed' && providesGateway(disk.installed.manifest)) this.gateways.resume(id, this.directory(id), atStart);
    } catch (error) {
      this.core.log('warn', `plugin ${id} app did not start: ${messageOf(error)}`);
    }
  }

  /**
   * At core start: every installed desktop app and gateway that starts with
   * the core. One plugin the store cannot read is logged by `resumeApp` and
   * skipped; the others still start.
   */
  startApps(): void {
    let ids: string[];
    try {
      ids = this.ids();
    } catch (error) {
      this.core.log('warn', `desktop apps did not start: ${messageOf(error)}`);
      return;
    }
    for (const id of ids) if (!this.jobs.has(id)) this.resumeApp(id, true);
  }

  /** `plugins.autostart`: whether the plugin's desktop app and gateway start when the core starts. */
  async autostart(params: RpcParams<'plugins.autostart'>): Promise<PluginState> {
    const id = this.known(params.id);
    if (typeof params.autostart !== 'boolean') throw invalidParams('autostart must be true or false', { field: 'autostart', expected: 'true or false' });
    const installed = this.usable(id);
    const app = providesApp(installed.manifest);
    const gateway = providesGateway(installed.manifest);
    if (!app && !gateway) throw refused(`${id} provides no desktop app or gateway to start with Boite.`);
    await this.lanes.shared(id, async () => {
      if (app) await this.apps.setAutostart(id, this.directory(id), params.autostart);
      if (gateway) await this.gateways.setAutostart(id, this.directory(id), params.autostart);
    });
    return this.state(id);
  }

  /** `plugins.app`: start, stop or restart a desktop-app plugin. */
  async app(params: RpcParams<'plugins.app'>): Promise<PluginState> {
    const id = this.known(params.id);
    if (!['start', 'stop', 'restart'].includes(params.action)) {
      throw invalidParams('plugin app action must be start, stop or restart', { field: 'action', expected: 'start, stop or restart' });
    }
    const installed = this.usable(id);
    if (!providesApp(installed.manifest)) throw refused(`${id} provides no desktop app.`);
    await this.lanes.shared(id, () => this.apps.control(id, this.directory(id), params.action));
    return this.state(id);
  }

  /** `plugins.gateway`: start, stop or restart a gateway plugin. */
  async gateway(params: RpcParams<'plugins.gateway'>): Promise<PluginState> {
    const id = this.known(params.id);
    if (!['start', 'stop', 'restart'].includes(params.action)) {
      throw invalidParams('plugin gateway action must be start, stop or restart', { field: 'action', expected: 'start, stop or restart' });
    }
    const installed = this.usable(id);
    if (!providesGateway(installed.manifest)) throw refused(`${id} provides no gateway.`);
    await this.lanes.shared(id, () => this.gateways.control(id, this.directory(id), params.action));
    return this.state(id);
  }

  /** At core start: the update checks of the recommended plugins that name a source. */
  startUpdateChecks(): void {
    if (!this.closing) this.updates.start();
  }

  /** `plugins.checkUpdates`: reads the update sources now and answers with the states they leave. */
  async checkUpdates(params: RpcParams<'plugins.checkUpdates'>): Promise<PluginState[]> {
    if (this.closing) throw refused('Boite is shutting down.');
    const sourced = this.recommended.map((manifest) => manifest.id).filter((id) => this.updateSources[id] !== undefined);
    let ids = sourced;
    if (params?.id !== undefined) {
      const expected = `a recommended plugin that names an update source: ${sourced.join(', ') || 'none'}`;
      if (!sourced.includes(params.id)) throw invalidParams(`plugin ${String(params.id)} has no update source; expected ${expected}`, { field: 'id', expected });
      ids = [params.id];
    }
    await this.updates.check(ids);
    return ids.map((id) => this.state(id));
  }

  async close(): Promise<void> {
    this.closing = true;
    const apps = this.apps.close();
    const gateways = this.gateways.close();
    this.shutdown.abort();
    const checks = this.updates.close();
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all([...jobs.map((job) => job.promise), ...this.lanes.rewrites()]);
    for (const threadId of this.running.keys()) this.core.procs.killTree(threadId);
    await Promise.all(this.exits);
    await Promise.all([...this.listings.values(), ...this.inspecting].map((pending) => pending.catch(() => undefined)));
    await apps;
    await gateways;
    await checks;
  }
}
