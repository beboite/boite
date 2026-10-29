/*
 * Newer releases of the recommended plugins, found without a Boite release.
 *
 * A recommended entry may name an update source: an https git repository and
 * the ref whose `boite-plugin.json` holds the plugin's latest release. The
 * source sits in Boite's reviewed list, never in a plugin's manifest, so a
 * plugin cannot point Boite anywhere else. The core reads the manifest there
 * through `fetchManifest`, the git path, limits and rules `plugins.inspect`
 * uses, and offers it only when it keeps the reviewed entry's id and features
 * and is strictly newer than both the pinned entry and what is installed.
 * Installing it stays the owner's click, through the same download, digest
 * check and desktop-app stop and restart as any install.
 *
 * Checks run a minute after the core starts, every six hours after, when the
 * owner asks, and before an install of the plugin downloads. A read that fails
 * waits 15 minutes, then twice as long each time, up to six hours. Only
 * installed plugins are read by themselves: a core whose owner never installed
 * one sends nothing.
 */

import { PLUGIN_MANIFEST_FILE } from '@boite/contracts';
import type { PluginManifest, PluginProvides, PluginUpdates } from '@boite/contracts';
import { messageOf } from '../errors.ts';
import { ManifestRefused, artifactFor, isRecord, parseManifest, parseManifestText, platformKey, refusal } from './manifest.ts';
import { checkRef, normalizeSourceUrl } from './source.ts';

export const FIRST_CHECK_MS = 60_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
export const RETRY_FIRST_MS = 15 * 60_000;
/** A manual check this soon after the last one answers with that one. */
export const MANUAL_FLOOR_MS = 10_000;

/** Where an entry's newer manifests are published: a normalized https repository and a ref. */
export interface UpdateSource {
  url: string;
  ref: string;
}

/** One entry of recommended.json: a manifest, plus the optional `updates` field only that list may carry. */
export interface RecommendedEntry {
  manifest: PluginManifest;
  updates: UpdateSource | null;
}

/** The manifest and its `updates` source, each refused with the file, the field and what was expected. */
export function parseRecommendedEntry(raw: unknown, file: string): RecommendedEntry {
  if (!isRecord(raw) || !('updates' in raw)) return { manifest: parseManifest(raw, file), updates: null };
  const { updates, ...rest } = raw;
  const manifest = parseManifest(rest, file);
  if (!isRecord(updates)) throw refusal(file, 'updates', 'an object with repository and ref', updates);
  for (const key of Object.keys(updates)) if (key !== 'repository' && key !== 'ref') throw refusal(file, `updates.${key}`, 'one of repository, ref', key);
  let url: string;
  try {
    url = normalizeSourceUrl(updates['repository']);
  } catch {
    throw refusal(file, 'updates.repository', 'an https URL of a git repository, with no credentials, query or fragment', updates['repository']);
  }
  const ref = updates['ref'];
  try {
    if (typeof ref !== 'string' || ref.length === 0) throw new Error('empty');
    checkRef(ref);
  } catch {
    throw refusal(file, 'updates.ref', 'a branch or tag: letters, digits, ., _, / and -, not starting with - or holding ..', ref);
  }
  return { manifest, updates: { url, ref } };
}

/** Newer, older or equal, by semver precedence. */
export function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/** The features a manifest asks for, in one comparable form. */
function features(provides: PluginProvides): string {
  return JSON.stringify({
    accountPools: provides.accountPools ? [...provides.accountPools.providers].sort() : null,
    desktopApp: provides.desktopApp !== undefined,
  });
}

export type Verdict =
  | { kind: 'offer'; manifest: PluginManifest }
  | { kind: 'current' }
  | { kind: 'ignored'; reason: string };

/**
 * What the manifest read at the source is worth against the reviewed entry
 * and `newest`, the higher of the pinned and the installed version. Every
 * artifact being https with a digest is the manifest rule itself.
 */
export function judge(text: string | null, pinned: PluginManifest, newest: string): Verdict {
  if (text === null) return { kind: 'ignored', reason: `The source has no ${PLUGIN_MANIFEST_FILE}.` };
  let found: PluginManifest;
  try {
    found = parseManifestText(text, PLUGIN_MANIFEST_FILE);
  } catch (error) {
    if (error instanceof ManifestRefused) return { kind: 'ignored', reason: error.message };
    throw error;
  }
  if (found.id !== pinned.id) return { kind: 'ignored', reason: `${PLUGIN_MANIFEST_FILE} there is for "${found.id}", not "${pinned.id}".` };
  // What the owner reads and what Boite runs stay as reviewed; a newer release only brings new binaries and text.
  for (const field of ['name', 'homepage', 'executable'] as const) {
    if (found[field] !== pinned[field]) {
      return { kind: 'ignored', reason: `${found.version} changes ${field} from "${pinned[field]}" to "${found[field]}"; that change comes with a Boite update.` };
    }
  }
  if (features(found.provides) !== features(pinned.provides)) {
    return { kind: 'ignored', reason: `${found.version} asks for other features than the reviewed entry; that change comes with a Boite update.` };
  }
  const order = compareVersions(found.version, newest);
  if (order === 0) return { kind: 'current' };
  if (order < 0) return { kind: 'ignored', reason: `${found.version} found there, older than ${newest}; Boite never goes back.` };
  if (artifactFor(found) === null) return { kind: 'ignored', reason: `${found.version} publishes nothing for ${platformKey()}, this machine.` };
  return { kind: 'offer', manifest: found };
}

interface Entry {
  checking: Promise<void> | null;
  checkedAt: number | null;
  nextCheckAt: number | null;
  available: { manifest: PluginManifest; commit: string; checkedAt: number } | null;
  ignored: string | null;
  error: string | null;
  failures: number;
}

export interface UpdateHost {
  /** The entry's source, null when it names none. */
  source(id: string): UpdateSource | null;
  /** Every recommended id that names a source. */
  ids(): string[];
  pinned(id: string): PluginManifest | null;
  /** The version on disk, null when nothing is installed. */
  installed(id: string): string | null;
  read(source: UpdateSource): Promise<{ commit: string; text: string | null }>;
  changed(id: string): void;
  log(level: 'info' | 'warn', message: string): void;
}

/** The checks of every source, their timer, and what each last found. */
export class PluginUpdateChecks {
  /** Test seam: the clock checks and backoff read. */
  now: () => number = () => Date.now();

  #entries = new Map<string, Entry>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #closed = false;
  #queue: Promise<void> = Promise.resolve();

  #host: UpdateHost;

  constructor(host: UpdateHost) {
    this.#host = host;}

  #entry(id: string): Entry {
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      entry = { checking: null, checkedAt: null, nextCheckAt: null, available: null, ignored: null, error: null, failures: 0 };
      this.#entries.set(id, entry);
    }
    return entry;
  }

  /** The higher of the pinned and the installed version: what a found manifest must beat. */
  #newest(id: string, pinned: PluginManifest): string {
    const installed = this.#host.installed(id);
    return installed !== null && compareVersions(installed, pinned.version) > 0 ? installed : pinned.version;
  }

  /** The newer manifest found for `id`, while it still beats both the pinned entry and the install. */
  offered(id: string): Entry['available'] {
    const available = this.#entries.get(id)?.available ?? null;
    const pinned = this.#host.pinned(id);
    if (available === null || pinned === null || this.#host.source(id) === null) return null;
    return compareVersions(available.manifest.version, this.#newest(id, pinned)) > 0 ? available : null;
  }

  state(id: string): PluginUpdates | null {
    const source = this.#host.source(id);
    if (source === null) return null;
    const entry = this.#entries.get(id);
    const offered = this.offered(id);
    return {
      source: { url: source.url, ref: source.ref },
      checking: entry?.checking != null,
      checkedAt: entry?.checkedAt ?? null,
      nextCheckAt: this.#started && !this.#closed ? entry?.nextCheckAt ?? null : null,
      available: offered === null ? null : { version: offered.manifest.version, commit: offered.commit, checkedAt: offered.checkedAt },
      ignored: entry?.ignored ?? null,
      error: entry?.error ?? null,
    };
  }

  /** At core start: the first check of every installed plugin with a source, a minute later. */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    const at = this.now() + FIRST_CHECK_MS;
    for (const id of this.#host.ids()) this.#entry(id).nextCheckAt ??= at;
    this.arm();
  }

  /**
   * The owner's check: every id named, at once, whatever the backoff says.
   * One read already running, or one finished in the last ten seconds, is
   * what the caller gets instead of another read.
   */
  async check(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => {
      const entry = this.#entry(id);
      if (entry.checking !== null) return entry.checking;
      if (entry.checkedAt !== null && this.now() - entry.checkedAt < MANUAL_FLOOR_MS) return Promise.resolve();
      return this.#run(id);
    }));
  }

  /** Reads one source and records what it held. Never throws: a failure is the entry's `error`. */
  #run(id: string): Promise<void> {
    const entry = this.#entry(id);
    if (entry.checking !== null) return entry.checking;
    const source = this.#host.source(id);
    const pinned = this.#host.pinned(id);
    if (source === null || pinned === null || this.#closed) return Promise.resolve();
    const checking = (async () => {
      try {
        const read = await this.#host.read(source);
        const verdict = judge(read.text, pinned, this.#newest(id, pinned));
        const at = this.now();
        entry.error = null;
        entry.failures = 0;
        entry.ignored = verdict.kind === 'ignored' ? verdict.reason : null;
        // Whatever the source holds now is the answer: a release taken back there is no longer offered.
        entry.available = verdict.kind === 'offer' ? { manifest: verdict.manifest, commit: read.commit, checkedAt: at } : null;
        entry.checkedAt = at;
        entry.nextCheckAt = at + CHECK_INTERVAL_MS;
        if (verdict.kind === 'offer') this.#host.log('info', `plugin ${id} ${verdict.manifest.version} is available from ${source.url} at ${read.commit.slice(0, 7)}`);
      } catch (error) {
        const at = this.now();
        entry.failures += 1;
        entry.error = messageOf(error);
        entry.checkedAt = at;
        entry.nextCheckAt = at + Math.min(RETRY_FIRST_MS * 2 ** (entry.failures - 1), CHECK_INTERVAL_MS);
        this.#host.log('warn', `plugin ${id} update check failed (${entry.error}); next try in ${Math.round((entry.nextCheckAt - at) / 60_000)} minutes`);
      } finally {
        entry.checking = null;
        if (!this.#closed) {
          this.#host.changed(id);
          this.arm();
        }
      }
    })();
    entry.checking = checking;
    this.#host.changed(id);
    return checking;
  }

  /** One timer for the earliest due check. Plugins not installed move on without a read. */
  private arm(): void {
    if (!this.#started || this.#closed) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    let next: number | null = null;
    for (const id of this.#host.ids()) {
      const at = this.#entry(id).nextCheckAt;
      if (at !== null && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    this.#timer = setTimeout(() => this.#tick(), Math.max(1_000, next - this.now()));
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** The due checks, one after the other, never two git fetches at once. */
  #tick(): void {
    this.#timer = null;
    if (this.#closed) return;
    const now = this.now();
    for (const id of this.#host.ids()) {
      const entry = this.#entry(id);
      if (entry.nextCheckAt === null || entry.nextCheckAt > now || entry.checking !== null) continue;
      if (this.#host.installed(id) === null) {
        entry.nextCheckAt = now + CHECK_INTERVAL_MS;
        continue;
      }
      this.#queue = this.#queue.then(() => this.#run(id));
    }
    void this.#queue.then(() => this.arm());
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await Promise.all([...this.#entries.values()].map((entry) => entry.checking ?? Promise.resolve()));
  }
}
