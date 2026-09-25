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
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PLUGIN_MANIFEST_FILE } from '@boite/contracts';
import type { PluginArtifact, PluginManifest, PluginPool, PluginPreview, PluginRejected, PluginSource, PluginState, RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused } from './errors.ts';
import { getDriver } from './drivers/index.ts';
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
  refusal,
} from './plugins/manifest.ts';
import { checkRef, fetchManifest, normalizeSourceUrl } from './plugins/source.ts';
import recommendedList from './plugins/recommended.json';

const INSTALLED_FILE = 'installed.json';
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** A download that receives nothing for this long stops; one still receiving goes on, up to the ceiling. */
const DOWNLOAD_IDLE_MS = 30_000;
const DOWNLOAD_CEILING_MS = 30 * 60_000;
const RUN_MAX_BYTES = 4 * 1024 * 1024;
const RUN_TIMEOUT_MS = 60_000;
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_MAX = 16;

/** The recommended plugins, read when the core loads. A bad entry fails the core's own tests. */
export const RECOMMENDED: readonly PluginManifest[] = (recommendedList as unknown[]).map((raw, index) =>
  parseManifest(raw, `recommended.json[${index}]`));

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
  /** The manifests `plugins.list` offers. Tests swap an entry to point an install at a fixture. */
  recommended: PluginManifest[] = [...RECOMMENDED];
  /** Lets `plugins.inspect` read a repository by its path on disk. Tests only; no client can set it. */
  allowLocalSources = false;

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

  /** Test seam: how long a download may receive nothing. */
  downloadIdleMs = DOWNLOAD_IDLE_MS;

  constructor(private core: Core) {}

  private root(): string {
    return resolve(this.core.dataDir, 'plugins');
  }

  private directory(id: string): string {
    const root = this.root();
    const dir = resolve(root, id);
    for (const path of [root, dir]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw refused(`plugin path ${path} must not be a symbolic link`);
    return dir;
  }

  private binaryPath(dir: string, manifest: PluginManifest): string {
    return join(dir, process.platform === 'win32' ? `${manifest.executable}.exe` : manifest.executable);
  }

  private recommendedManifest(id: string): PluginManifest | null {
    return this.recommended.find((manifest) => manifest.id === id) ?? null;
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
    const file = join(dir, INSTALLED_FILE);
    if (!existsSync(file)) return { kind: 'none' };
    const recommended = this.recommendedManifest(id);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { kind: 'error', message: `${file} is not readable JSON (${messageOf(error)}). Reinstall ${id}.` };
    }
    if (!isRecord(data)) return { kind: 'error', message: `${file} must be a JSON object. Reinstall ${id}.` };
    let record: Omit<Installed, 'binary'>;
    if (data['schema'] === undefined && recommended !== null) {
      // What kebacc-switcher wrote before manifests: its version alone.
      if (typeof data['version'] !== 'string') {
        return { kind: 'error', message: `${file} must carry a "version" string, found ${typeof data['version']}. Reinstall ${id}.` };
      }
      record = { version: data['version'], origin: 'recommended', source: null, manifest: recommended };
    } else {
      try {
        record = readRecord(data, file, id, dir);
      } catch (error) {
        if (error instanceof ManifestRefused) return { kind: 'rejected', rejected: error.rejected };
        throw error;
      }
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
    const target = recommended ?? pending?.manifest ?? installed?.manifest ?? null;
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
    };
  }

  /** The recommended plugins in their list order, then the URL ones by id. */
  list(): PluginState[] {
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
    return [...this.recommended.map((manifest) => manifest.id), ...[...ids].sort()].map((id) => this.state(id));
  }

  private emit(id: string): void {
    try {
      this.core.bus.emit('plugins.updated', this.state(id));
    } catch (error) {
      this.core.log('warn', `plugin ${id} state unreadable: ${messageOf(error)}`);
    }
  }

  private busy(id: string): boolean {
    return this.jobs.has(id) || [...this.running.values()].includes(id) || this.action?.id === id || this.listings.has(id);
  }

  /** Installs a recommended plugin, or reinstalls a URL one from the manifest it recorded. */
  install(id: string): PluginState {
    this.known(id);
    if (this.jobs.has(id)) return this.state(id);
    const recommended = this.recommendedManifest(id);
    if (recommended !== null) return this.start(id, recommended, null, 'recommended');
    const pending = this.pending.get(id);
    if (pending !== undefined) return this.start(id, pending.manifest, pending.source, 'url');
    const disk = this.onDisk(id);
    if (disk.kind === 'installed' && disk.installed.source !== null) return this.start(id, disk.installed.manifest, disk.installed.source, 'url');
    if (disk.kind === 'rejected') throw refused(`${id} was refused (${disk.rejected.message}). Remove it, then add it again from its URL.`, disk.rejected);
    throw refused(`${id} has no manifest to reinstall from. Remove it, then add it again from its URL.`);
  }

  private start(id: string, manifest: PluginManifest, source: PluginSource | null, origin: Origin): PluginState {
    if (this.closing) throw refused('Boite is shutting down.');
    if (this.busy(id)) throw refused('Wait for the current plugin operation before installing.');
    const artifact = artifactFor(manifest);
    if (artifact === null) throw refused(`${id} has no binary for ${platformKey()}`);
    this.failures.delete(id);
    // A first install that fails leaves nothing behind; an update that fails keeps the version that worked.
    const fresh = this.onDisk(id).kind !== 'installed';
    const controller = new AbortController();
    const job: Job = { controller, progress: 0, promise: Promise.resolve() };
    this.jobs.set(id, job);
    job.promise = this.download(id, manifest, source, origin, artifact, job)
      .then(() => { this.pending.delete(id); })
      .catch(async (error: unknown) => {
        if (!controller.signal.aborted) this.failures.set(id, messageOf(error));
        if (fresh) await removeTree(this.directory(id)).catch(() => undefined);
        if (fresh && controller.signal.aborted) this.pending.delete(id);
      })
      .finally(() => {
        this.jobs.delete(id);
        this.cache.delete(id);
        this.emit(id);
      });
    this.emit(id);
    return this.state(id);
  }

  private async download(id: string, manifest: PluginManifest, source: PluginSource | null, origin: Origin, artifact: PluginArtifact, job: Job): Promise<void> {
    const signal = job.controller.signal;
    const dir = this.directory(id);
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, 'download.part');
    const record = join(dir, `${INSTALLED_FILE}.part`);
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
      const binary = this.binaryPath(dir, manifest);
      await rename(temporary, binary);
      if (previous.kind === 'installed' && previous.installed.binary !== binary) await rm(previous.installed.binary, { force: true });
      await writeFile(record, JSON.stringify({ schema: 1, origin, source, installedAt: Date.now(), manifest }, null, 2), 'utf8');
      await rename(record, join(dir, INSTALLED_FILE));
      job.progress = 100;
    } finally {
      clearTimeout(timer);
      clearTimeout(ceiling);
      await rm(temporary, { force: true });
      await rm(record, { force: true });
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
    if (this.busy(manifest.id)) throw refused('Wait for the current plugin operation before installing.');
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
    if (this.busy(id)) throw refused('Wait for the current plugin operation before uninstalling.');
    await removeTree(this.directory(id));
    this.pending.delete(id);
    this.failures.delete(id);
    this.cache.delete(id);
    const state = this.state(id);
    this.core.bus.emit('plugins.updated', state);
    return state;
  }

  /** The installed plugin an account call runs, or the reason there is none. */
  private usable(id: string): Installed {
    if (this.closing) throw refused('Boite is shutting down.');
    const disk = this.onDisk(id);
    if (disk.kind === 'rejected') throw refused(`${id} was refused: ${disk.rejected.message}`, disk.rejected);
    if (disk.kind !== 'installed') throw refused(`Install ${id} first.`);
    if (this.jobs.has(id)) throw refused(`Wait for ${id} installation to finish.`);
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
    const promise = (async () => {
      const pools: PluginPool[] = [];
      for (const provider of poolsOf(installed.manifest)) {
        pools.push(parsePluginPool(provider, await this.run(id, installed, [...POOL_COMMANDS.list(provider, refresh)]), installed.manifest.executable));
      }
      this.cache.set(id, { pools, at: Date.now() });
      return pools;
    })();
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
    if (this.action !== null || this.listings.has(id) || this.jobs.has(id)) throw refused('Wait for the current plugin operation to finish.');
    this.action = { id, provider: params.provider };
    try {
      const affected = this.core.journal.listThreads().filter((thread) => this.blocksAccount(thread.accountId));
      if (this.core.scheduler.activeAccountIds().some((accountId) => this.blocksAccount(accountId))) throw refused('Stop this provider\'s default-account turns before changing its saved login.');
      if (affected.some((thread) => ['running', 'queued', 'waiting'].includes(thread.status))) throw refused('Stop this provider\'s default-account turns before changing its saved login.');
      for (const thread of affected) {
        const provider = this.core.providers.require(thread.providerId);
        getDriver(provider.protocol).releaseThread?.(thread.id);
      }
      const args = params.action === 'add' ? POOL_COMMANDS.add(params.provider)
        : params.action === 'switch' ? POOL_COMMANDS.switch(params.provider, params.email!)
        : POOL_COMMANDS.remove(params.provider, params.email!);
      await this.run(id, installed, [...args]);
      if (this.closing) throw refused('Boite is shutting down.');
      this.cache.delete(id);
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

  async close(): Promise<void> {
    this.closing = true;
    this.shutdown.abort();
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.promise));
    for (const threadId of this.running.keys()) this.core.procs.killTree(threadId);
    await Promise.all(this.exits);
    await Promise.all([...this.listings.values(), ...this.inspecting].map((pending) => pending.catch(() => undefined)));
  }
}
