import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  rmdirSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { ProviderId, ProviderInstall, ProviderInstallState } from '@boite/contracts';
import { newId } from '../ids.ts';
import { agentsDirPath, currentOs, providerAgentDir } from '../paths.ts';
import { messageOf, refused, unavailable } from '../errors.ts';
import { forgetWhich } from './which.ts';

/** Room left on the volume after the archive and the unpacked files, so nothing fills the disk. */
export const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

/** Written beside the files a release unpacked to, and the only proof an install finished. */
export const RELEASE_RECORD = '.install-complete.json';

/** How often a download reports itself while it runs. */
const PROGRESS_INTERVAL_MS = 250;

/** Compressed bytes handed to the unzip at once, and how long it may hold the thread before yielding. */
const EXTRACT_SLICE_BYTES = 16 * 1024;
const EXTRACT_YIELD_MS = 10;

/** A download that receives nothing for this long is dropped and tried again from where it stopped. */
const IDLE_TIMEOUT_MS = 30_000;

/** The wait before each new attempt after a dropped connection: five retries, then the install fails and keeps what it has. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

interface ReleaseRecord {
  version: string;
  files: string[];
  installedAt: number;
}

/** Written beside a `.part`, so a later install knows the bytes it holds belong to the same archive. */
interface PartRecord {
  url: string;
  sha256: string;
  /** The server's strong ETag or Last-Modified, sent back as `If-Range`; null when it gave neither. */
  validator: string | null;
}

/** The bytes a download holds so far and their running digest. */
interface Progress {
  received: number;
  hasher: Bun.CryptoHasher;
  /** What the server said identifies the file, sent back as `If-Range` by the next attempt. */
  validator: string | null;
}

/** What the manager writes back to the rest of the core. */
export interface InstallSink {
  emit(state: ProviderInstallState & { providerId: ProviderId }): void;
  /** Once the files land or are removed, so every client re-lists the summaries. */
  updated(): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

interface Running {
  operationId: string;
  controller: AbortController;
  state: ProviderInstallState;
}

/** How a run ended, and the state it left: a cancelled update reads as the old release, which is not a success. */
export interface InstallOutcome {
  providerId: ProviderId;
  outcome: 'installed' | 'failed' | 'cancelled';
  state: ProviderInstallState;
}

class Cancelled extends Error {
  /** True when the core is stopping rather than the user cancelling: the bytes already downloaded stay for the next install. */
  readonly keep: boolean;
  constructor(keep = false) {
    super('the install was cancelled');
    this.name = 'InstallCancelled';
    this.keep = keep;
  }
}

/** One attempt lost its connection, stalled or met a server error that may pass: the download tries again. */
class Retryable extends Error {}

/** Every retry failed. The `.part` stays, so installing again resumes where this stopped. */
class Dropped extends Error {}

/** A zip member may not climb out of the directory it is unpacked into. */
export function safeEntryPath(name: string): string | null {
  const cleaned = name.split('\\').join('/');
  if (cleaned.length === 0 || cleaned.endsWith('/')) return null;
  if (cleaned.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split('/').includes('..')) return null;
  return cleaned;
}

function totalFileBytes(install: ProviderInstall): number {
  return install.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** Bytes still free on the volume the data directory sits on, or null where the OS will not say. */
export function freeBytesAt(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function humanMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Managed installs: one release per provider, downloaded on request, unpacked
 * under the data directory, and pointed at by `{agentsDir}`. The state of each
 * lives here while an operation runs and on disk the rest of the time, so a
 * core that restarts mid-download comes back saying `absent` rather than
 * pretending an install is still going.
 */
export class InstallManager {
  #sink: InstallSink | null = null;
  #running = new Map<ProviderId, Running>();
  /** A failure stands until the next `providers.install` on that provider. */
  #failed = new Map<ProviderId, ProviderInstallState>();
  /** How many live processes are running out of this provider's managed files. */
  #leases = new Map<ProviderId, number>();
  #waiters = new Map<ProviderId, ((outcome: InstallOutcome) => void)[]>();
  #settledListeners: ((outcome: InstallOutcome) => void)[] = [];
  /** Test seams: how long a silent download waits, and the pauses between attempts. */
  idleTimeoutMs = IDLE_TIMEOUT_MS;
  retryDelaysMs: readonly number[] = RETRY_DELAYS_MS;

  constructor(private readonly dataDir: string) {}

  attach(sink: InstallSink): void {
    this.#sink = sink;
  }

  // -- paths ----------------------------------------------------------------

  currentDir(providerId: ProviderId): string {
    return agentsDirPath(this.dataDir, providerId);
  }

  releaseDir(providerId: ProviderId, version: string): string {
    return this.#inside(join(providerAgentDir(this.dataDir, providerId), 'releases'), version);
  }

  partFile(providerId: ProviderId, version: string): string {
    return this.#inside(join(providerAgentDir(this.dataDir, providerId), 'downloads'), `${version}.zip.part`);
  }

  /** A version is deleted recursively on failure: whatever it says, it stays one entry of its directory. */
  #inside(dir: string, name: string): string {
    const path = join(dir, name);
    const within = relative(dir, path);
    if (within.length === 0 || within.startsWith('..') || isAbsolute(within) || /[\\/]/.test(within)) {
      throw refused(`the release version ${name} is not a plain directory name under ${dir}`, { dir, name });
    }
    return path;
  }

  #partRecordFile(part: string): string {
    return `${part}.json`;
  }

  #readPartRecord(part: string): PartRecord | null {
    try {
      const raw = JSON.parse(readFileSync(this.#partRecordFile(part), 'utf8')) as Partial<PartRecord>;
      if (typeof raw.url !== 'string' || typeof raw.sha256 !== 'string') return null;
      return { url: raw.url, sha256: raw.sha256, validator: typeof raw.validator === 'string' ? raw.validator : null };
    } catch {
      return null;
    }
  }

  /** The bytes a `.part` of this exact archive already holds, zero when there is none or it belongs to another. */
  #resumableBytes(part: string, install: ProviderInstall): number {
    const record = this.#readPartRecord(part);
    if (record === null || record.url !== install.url || record.sha256.toLowerCase() !== install.sha256.toLowerCase()) return 0;
    try {
      const size = statSync(part).size;
      return size <= install.archiveBytes ? size : 0;
    } catch {
      return 0;
    }
  }

  #dropPart(part: string): void {
    rmSync(part, { force: true });
    rmSync(this.#partRecordFile(part), { force: true });
  }

  // -- state ----------------------------------------------------------------

  /** What the summaries carry. Null when this profile has nothing to install. */
  stateOf(providerId: ProviderId, install: ProviderInstall | undefined): ProviderInstallState | null {
    if (install === undefined) return null;
    if (install.arch && install.arch !== process.arch) {
      return { state: 'failed', version: install.version, message: `${providerId} requires ${install.arch}; this machine is ${process.arch}` };
    }
    const running = this.#running.get(providerId);
    if (running !== undefined) return running.state;
    const failed = this.#failed.get(providerId);
    if (failed !== undefined && failed.version === install.version) return failed;
    let record: ReleaseRecord | null;
    try { record = this.#readRecord(providerId); }
    catch (error) { return { state: 'failed', version: install.version, message: messageOf(error) }; }
    if (record !== null) {
      // What is on disk, and what the descriptor offers today: an older record
      // is an update waiting, not an absent provider whose files are missing.
      return {
        state: 'installed',
        version: record.version,
        installedAt: record.installedAt,
        available: install.version,
      };
    }
    return { state: 'absent', version: install.version, archiveBytes: install.archiveBytes };
  }

  /** The release `current` holds, whatever runs meanwhile; null when there is none or its record is unreadable. */
  installedVersion(providerId: ProviderId): string | null {
    try { return this.#readRecord(providerId)?.version ?? null; }
    catch { return null; }
  }

  #readRecord(providerId: ProviderId): ReleaseRecord | null {
    const file = join(this.currentDir(providerId), RELEASE_RECORD);
    if (!existsSync(file)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof raw !== 'object' || raw === null) throw new Error('expected an object');
      const record = raw as Partial<ReleaseRecord>;
      if (typeof record.version !== 'string' || record.version.length === 0) throw new Error('version must be a nonempty string');
      if (!Array.isArray(record.files) || !record.files.every((entry) => typeof entry === 'string' && safeEntryPath(entry) !== null)) {
        throw new Error('files must be an array of relative file paths');
      }
      if (typeof record.installedAt !== 'number' || !Number.isFinite(record.installedAt)) throw new Error('installedAt must be a finite timestamp');
      return {
        version: record.version,
        files: record.files,
        installedAt: record.installedAt,
      };
    } catch (error) {
      throw refused(`${file}: invalid completion record: ${messageOf(error)}. Uninstall this release before installing again.`);
    }
  }

  // -- leases ---------------------------------------------------------------

  /** Held for the life of a process this provider launched, so a remove cannot pull the exe out from under it. */
  acquire(providerId: ProviderId): void {
    this.#leases.set(providerId, (this.#leases.get(providerId) ?? 0) + 1);
  }

  release(providerId: ProviderId): void {
    const count = this.#leases.get(providerId) ?? 0;
    if (count <= 1) {
      this.#leases.delete(providerId);
      // The last process may have run out of a release an update replaced.
      queueMicrotask(() => this.prune(providerId));
    } else this.#leases.set(providerId, count - 1);
  }

  leaseCount(providerId: ProviderId): number {
    return this.#leases.get(providerId) ?? 0;
  }

  /**
   * Deletes the releases `current` no longer points at, once nothing runs out
   * of this provider's files and no install is under way. A file Windows still
   * holds is left for the next prune. `keepDownload` names the version whose
   * `.part` may still be resumed; every other download goes, and leaving it
   * out leaves the downloads alone.
   */
  prune(providerId: ProviderId, keepDownload?: string | null): void {
    if (this.#running.has(providerId) || this.leaseCount(providerId) > 0) return;
    const root = providerAgentDir(this.dataDir, providerId);
    let current: string;
    try { current = realpathSync(this.currentDir(providerId)); }
    catch { return; }
    const same = (a: string, b: string): boolean => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
    const remove = (path: string): void => {
      try { rmSync(path, { recursive: true, force: true }); }
      catch (error) { this.#log('warn', `${path} could not be removed yet (${messageOf(error)}); the next prune tries again`); }
    };
    for (const name of this.#list(join(root, 'releases'))) {
      const dir = join(root, 'releases', name);
      let target = dir;
      try { target = realpathSync(dir); } catch { /* compared as it is */ }
      if (!same(target, current)) remove(dir);
    }
    if (keepDownload === undefined) return;
    for (const name of this.#list(join(root, 'downloads'))) {
      if (keepDownload !== null && name.startsWith(`${keepDownload}.zip.part`)) continue;
      remove(join(root, 'downloads', name));
    }
  }

  #list(dir: string): string[] {
    try { return readdirSync(dir); }
    catch { return []; }
  }

  // -- waiting on a run ------------------------------------------------------

  /** The end of the run in flight for this provider, or null when none is. */
  whenDone(providerId: ProviderId): Promise<InstallOutcome> | null {
    if (!this.#running.has(providerId)) return null;
    return new Promise((resolve) => {
      this.#waiters.set(providerId, [...(this.#waiters.get(providerId) ?? []), resolve]);
    });
  }

  /** Called once each run ends, whoever started it. */
  onSettled(listener: (outcome: InstallOutcome) => void): void {
    this.#settledListeners.push(listener);
  }

  #settle(outcome: InstallOutcome): void {
    const waiters = this.#waiters.get(outcome.providerId) ?? [];
    this.#waiters.delete(outcome.providerId);
    for (const resolve of waiters) resolve(outcome);
    for (const listener of this.#settledListeners) {
      try { listener(outcome); }
      catch (error) { this.#log('error', `after installing ${outcome.providerId}: ${messageOf(error)}`); }
    }
  }

  // -- operations -----------------------------------------------------------

  /**
   * The download, and the update: a provider whose record names an older
   * version installs the new release beside it and repoints `current`. The old
   * release goes once no process of this provider is left (`prune`), since one
   * may still be running out of it; `uninstall` takes the whole directory.
   */
  start(providerId: ProviderId, install: ProviderInstall): ProviderInstallState {
    if (install.arch && install.arch !== process.arch) {
      throw refused(`${providerId} requires ${install.arch}; this machine is ${process.arch}`, { providerId, expectedArch: install.arch, actualArch: process.arch });
    }
    if (this.#running.has(providerId)) {
      throw refused(`an install of ${providerId} is already running`, {
        providerId,
        operationId: this.#running.get(providerId)?.operationId,
      });
    }
    // Both paths are checked here, where a refusal reaches the caller, not inside the run.
    this.releaseDir(providerId, install.version);
    this.partFile(providerId, install.version);
    const record = this.#readRecord(providerId);
    if (record !== null && record.version === install.version) {
      throw refused(`${providerId} is up to date on ${install.version}`, {
        providerId,
        version: install.version,
      });
    }
    this.#failed.delete(providerId);

    const extractedBytes = install.format === 'binary' ? 0 : totalFileBytes(install);
    // What an earlier attempt left in the `.part` is already on the disk.
    const already = this.#resumableBytes(this.partFile(providerId, install.version), install);
    const needed = install.archiveBytes - already + extractedBytes + FREE_SPACE_MARGIN;
    const free = freeBytesAt(this.dataDir);
    if (free === null) {
      this.#log('warn', `no free space reading on this platform, installing ${providerId} without the check`);
    } else if (free < needed) {
      throw refused(
        `not enough free space for ${providerId}: ${humanMegabytes(needed)} needed, ${humanMegabytes(free)} free`,
        { providerId, neededBytes: needed, freeBytes: free },
      );
    }

    const operationId = newId('inst_');
    const running: Running = {
      operationId,
      controller: new AbortController(),
      state: {
        state: 'downloading',
        version: install.version,
        receivedBytes: 0,
        totalBytes: install.archiveBytes,
        operationId,
      },
    };
    this.#running.set(providerId, running);
    this.#emit(providerId, running.state);

    void this.#run(providerId, install, running);
    return running.state;
  }

  cancel(providerId: ProviderId, operationId: string): ProviderInstallState {
    const running = this.#running.get(providerId);
    if (running === undefined) throw refused(`no install of ${providerId} is running`, { providerId });
    if (running.operationId !== operationId) {
      throw refused('that operation is not the one running', {
        providerId,
        operationId,
        runningOperationId: running.operationId,
      });
    }
    running.controller.abort(new Cancelled());
    return running.state;
  }

  async uninstall(providerId: ProviderId, install: ProviderInstall | undefined): Promise<ProviderInstallState> {
    if (install === undefined) {
      throw refused(`${providerId} has nothing Boite installed`, { providerId });
    }
    if (this.#running.has(providerId)) {
      throw refused(`an install of ${providerId} is running`, { providerId });
    }
    const held = this.leaseCount(providerId);
    if (held > 0) {
      throw refused(`${providerId} is running ${held} process${held === 1 ? '' : 'es'} right now`, {
        providerId,
        leases: held,
      });
    }
    const dir = providerAgentDir(this.dataDir, providerId);
    this.#removeCurrent(providerId);
    rmSync(dir, { recursive: true, force: true });
    forgetWhich();
    this.#failed.delete(providerId);
    await Promise.resolve();
    const state: ProviderInstallState = {
      state: 'absent',
      version: install.version,
      archiveBytes: install.archiveBytes,
    };
    this.#emit(providerId, state);
    this.#sink?.updated();
    return state;
  }

  /** Core shutdown: abort what is still downloading rather than leaving a fetch behind. Its bytes stay for the next install. */
  stop(): void {
    for (const running of this.#running.values()) running.controller.abort(new Cancelled(true));
    this.#running.clear();
  }

  // -- the run itself -------------------------------------------------------

  async #run(providerId: ProviderId, install: ProviderInstall, running: Running): Promise<void> {
    const part = this.partFile(providerId, install.version);
    const releaseDir = this.releaseDir(providerId, install.version);
    try {
      await this.#download(providerId, install, running, part);
      this.#move(running, providerId, { state: 'extracting', version: install.version, operationId: running.operationId });
      rmSync(releaseDir, { recursive: true, force: true });
      await this.#extract(install, running, part, releaseDir);
      this.#checkSizes(install, releaseDir);
      this.#markExecutable(install, releaseDir);
      writeFileSync(
        join(releaseDir, RELEASE_RECORD),
        `${JSON.stringify(
          { version: install.version, files: install.files.map((file) => file.path), installedAt: Date.now() },
          null,
          2,
        )}\n`,
      );
      this.#point(providerId, releaseDir);
      forgetWhich();
      this.#dropPart(part);

      const record = this.#readRecord(providerId);
      const state: ProviderInstallState = {
        state: 'installed',
        version: install.version,
        installedAt: record?.installedAt ?? Date.now(),
        available: install.version,
      };
      this.#running.delete(providerId);
      // The release this one replaced goes now, or when its last process ends.
      this.prune(providerId, null);
      // The provider list goes out first: a client that saw `installed` while it
      // still held the provider as missing would offer a repair for one frame.
      this.#sink?.updated();
      this.#emit(providerId, state);
      this.#settle({ providerId, outcome: 'installed', state });
    } catch (error) {
      // A connection that kept dropping, or a core that stopped, leaves the bytes
      // it got so far: the next install resumes there. A cancel, a wrong size or
      // a wrong digest starts over.
      if (!(error instanceof Dropped) && !(error instanceof Cancelled && error.keep)) this.#dropPart(part);
      rmSync(releaseDir, { recursive: true, force: true });
      this.#running.delete(providerId);
      if (error instanceof Cancelled || (error as { name?: string } | null)?.name === 'InstallCancelled') {
        // Back to what is on disk: absent for a first install, the release that
        // was already there for an update nobody finished.
        const state = this.stateOf(providerId, install) ?? {
          state: 'absent' as const,
          version: install.version,
          archiveBytes: install.archiveBytes,
        };
        this.#emit(providerId, state);
        this.#settle({ providerId, outcome: 'cancelled', state });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const state: ProviderInstallState = { state: 'failed', version: install.version, message };
      this.#failed.set(providerId, state);
      this.#log('error', `installing ${providerId} failed: ${message}`);
      this.#emit(providerId, state);
      this.#settle({ providerId, outcome: 'failed', state });
    }
  }

  async #download(
    providerId: ProviderId,
    install: ProviderInstall,
    running: Running,
    part: string,
  ): Promise<void> {
    mkdirSync(dirname(part), { recursive: true });
    const progress: Progress = { received: 0, hasher: new Bun.CryptoHasher('sha256'), validator: null };
    if (this.#resumableBytes(part, install) > 0) {
      progress.validator = this.#readPartRecord(part)?.validator ?? null;
      for await (const chunk of Bun.file(part).stream()) {
        if (running.controller.signal.aborted) throw running.controller.signal.reason;
        progress.hasher.update(chunk);
        progress.received += chunk.byteLength;
      }
      this.#log('info', `resuming the download of ${providerId} at ${humanMegabytes(progress.received)} of ${humanMegabytes(install.archiveBytes)}`);
    } else {
      this.#dropPart(part);
    }
    this.#report(running, providerId, install, progress);

    let retries = 0;
    while (progress.received < install.archiveBytes) {
      try {
        await this.#attempt(providerId, install, running, part, progress);
        break;
      } catch (error) {
        if (!(error instanceof Retryable)) throw error;
        const delay = this.retryDelaysMs[retries];
        const at = `${humanMegabytes(progress.received)} of ${humanMegabytes(install.archiveBytes)}`;
        if (delay === undefined) {
          throw new Dropped(`${error.message} at ${at}, and ${retries} retr${retries === 1 ? 'y' : 'ies'} did not get past it; install again to resume`);
        }
        retries += 1;
        this.#log('warn', `downloading ${providerId}: ${error.message} at ${at}, retrying (${retries}/${this.retryDelaysMs.length})`);
        await new Promise<void>((done) => {
          const timer = setTimeout(done, delay);
          running.controller.signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
        });
        if (running.controller.signal.aborted) throw running.controller.signal.reason;
      }
    }

    this.#move(running, providerId, {
      state: 'verifying',
      version: install.version,
      operationId: running.operationId,
    });

    if (progress.received !== install.archiveBytes) {
      throw refused(
        `${install.url} is ${progress.received} bytes, the descriptor expected ${install.archiveBytes}`,
        { providerId, url: install.url, expectedBytes: install.archiveBytes, actualBytes: progress.received },
      );
    }
    const digest = progress.hasher.digest('hex');
    if (digest !== install.sha256.toLowerCase()) {
      throw refused(
        `${install.url} hashes to ${digest}, the descriptor expected ${install.sha256.toLowerCase()}`,
        { providerId, url: install.url, expectedSha256: install.sha256.toLowerCase(), actualSha256: digest },
      );
    }
  }

  /** One request, appended to `progress`. Throws `Retryable` for what another attempt may get past. */
  async #attempt(
    providerId: ProviderId,
    install: ProviderInstall,
    running: Running,
    part: string,
    progress: Progress,
  ): Promise<void> {
    const attempt = new AbortController();
    const signal = AbortSignal.any([running.controller.signal, attempt.signal]);
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; attempt.abort(); }, this.idleTimeoutMs);
    };
    // What the network threw, in words: the user's cancel stays a cancel, the
    // rest is worth another attempt. Bun's own text asks for `verbose: true`.
    const lost = (error: unknown): Error => {
      if (running.controller.signal.aborted) return running.controller.signal.reason as Error;
      if (stalled) return new Retryable(`no data for ${Math.round(this.idleTimeoutMs / 1000)} s`);
      return new Retryable(`the connection dropped (${error instanceof Error ? error.name : 'error'})`);
    };

    let handle: number | null = null;
    arm();
    try {
      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      if (progress.received > 0) {
        headers['range'] = `bytes=${progress.received}-`;
        if (progress.validator !== null) headers['if-range'] = progress.validator;
      }
      let response: Response;
      try {
        response = await fetch(install.url, { signal, headers });
      } catch (error) {
        throw lost(error);
      }
      const status = response.status;
      if (status === 408 || status === 429 || status >= 500) {
        throw new Retryable(`the server answered ${status} ${response.statusText}`.trim());
      }
      if (status === 206) {
        const start = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1];
        if (start === undefined || Number(start) !== progress.received) {
          // A range the download did not ask for: the next attempt takes the whole file.
          this.#restart(part, progress);
          throw new Retryable(`the server resumed at byte ${start ?? 'unknown'} instead of ${progress.received}`);
        }
      } else if (status === 200) {
        // The whole file: a server that does not resume, or a file that changed.
        if (progress.received > 0) this.#restart(part, progress);
      } else {
        throw unavailable(`${install.url} answered ${status} ${response.statusText}`.trim(), {
          providerId,
          url: install.url,
          status,
        });
      }
      if (response.body === null) {
        throw unavailable(`${install.url} answered ${status} with no body`, { providerId, url: install.url, status });
      }
      const length = response.headers.get('content-length');
      if (length !== null && response.headers.get('content-encoding') === null) {
        const total = progress.received + Number(length);
        if (total !== install.archiveBytes) {
          throw refused(`${install.url} is ${total} bytes, the descriptor expected ${install.archiveBytes}`, {
            providerId, url: install.url, expectedBytes: install.archiveBytes, actualBytes: total,
          });
        }
      }
      const etag = response.headers.get('etag');
      // `If-Range` takes a strong ETag or a date; a weak one would never match.
      progress.validator = etag !== null && !etag.startsWith('W/')
        ? etag
        : (response.headers.get('last-modified') ?? (status === 206 ? progress.validator : null));
      const record: PartRecord = { url: install.url, sha256: install.sha256, validator: progress.validator };
      writeFileSync(this.#partRecordFile(part), `${JSON.stringify(record)}\n`);

      handle = openSync(part, progress.received > 0 ? 'a' : 'w');
      const reader = response.body.getReader();
      let lastReport = 0;
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (error) {
          throw lost(error);
        }
        // An abort does not always reach a body that already has data waiting.
        if (signal.aborted) throw lost(null);
        if (read.done) break;
        arm();
        const chunk = read.value;
        if (progress.received + chunk.byteLength > install.archiveBytes) {
          throw refused(`${install.url} sent more than the ${install.archiveBytes} bytes the descriptor expected`, {
            providerId, url: install.url, expectedBytes: install.archiveBytes,
          });
        }
        progress.hasher.update(chunk);
        writeSync(handle, chunk);
        progress.received += chunk.byteLength;
        const now = Date.now();
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          this.#report(running, providerId, install, progress);
        }
      }
      if (running.controller.signal.aborted) throw running.controller.signal.reason;
    } finally {
      clearTimeout(timer);
      if (handle !== null) closeSync(handle);
      attempt.abort();
    }
  }

  /** Throws away what a download held, for a server that answers with the whole file again. */
  #restart(part: string, progress: Progress): void {
    rmSync(part, { force: true });
    progress.received = 0;
    progress.hasher = new Bun.CryptoHasher('sha256');
  }

  #report(running: Running, providerId: ProviderId, install: ProviderInstall, progress: Progress): void {
    this.#move(running, providerId, {
      state: 'downloading',
      version: install.version,
      receivedBytes: progress.received,
      totalBytes: install.archiveBytes,
      operationId: running.operationId,
    });
  }

  /**
   * fflate's streaming unzip, one archive chunk at a time, so a 400 MB member
   * never sits in memory. A member the descriptor does not list is skipped by
   * simply never being started.
   */
  async #extract(
    install: ProviderInstall,
    running: Running,
    part: string,
    releaseDir: string,
  ): Promise<void> {
    const wanted = new Map(install.files.map((file) => [file.path.split('\\').join('/'), file]));
    mkdirSync(releaseDir, { recursive: true });
    if (install.format === 'binary') {
      if (running.controller.signal.aborted) throw running.controller.signal.reason;
      const file = install.files[0];
      if (!file || install.files.length !== 1 || safeEntryPath(file.path) === null) {
        throw refused('a binary install requires exactly one safe relative file path');
      }
      const target = join(releaseDir, file.path.split('\\').join('/'));
      mkdirSync(dirname(target), { recursive: true });
      renameSync(part, target);
      return;
    }

    const open = new Map<string, number>();
    let failure: Error | null = null;

    // Loaded here, not at the top: evaluating fflate builds its Huffman tables,
    // about 8 ms that every core start would pay for an install it rarely runs.
    const { Unzip, UnzipInflate } = await import('fflate');
    const unzip = new Unzip((file) => {
      if (failure !== null) return;
      const safe = safeEntryPath(file.name);
      if (safe === null) {
        if (file.name.endsWith('/') || file.name.endsWith('\\')) return;
        failure = refused(`the archive holds an entry that escapes its directory: ${file.name}`, {
          entry: file.name,
        });
        return;
      }
      if (!wanted.has(safe)) return;

      const target = join(releaseDir, safe);
      mkdirSync(dirname(target), { recursive: true });
      const handle = openSync(target, 'w');
      open.set(safe, handle);
      file.ondata = (error, chunk, final): void => {
        if (error !== null && error !== undefined) {
          failure ??= error;
          return;
        }
        if (chunk.byteLength > 0) writeSync(handle, chunk);
        if (final) {
          closeSync(handle);
          open.delete(safe);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);

    try {
      const stream = Bun.file(part).stream();
      const reader = stream.getReader();
      // Inflating runs on the core's own thread: a compressible member turns one
      // read into megabytes of output. Small slices, and a turn of the event loop
      // whenever a few milliseconds went by, keep RPCs and the cancel answering.
      let lastYield = performance.now();
      for (;;) {
        if (running.controller.signal.aborted) throw running.controller.signal.reason;
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += EXTRACT_SLICE_BYTES) {
          unzip.push(value.subarray(offset, offset + EXTRACT_SLICE_BYTES), false);
          if (failure !== null) throw failure;
          if (performance.now() - lastYield >= EXTRACT_YIELD_MS) {
            await new Promise<void>((done) => setImmediate(done));
            lastYield = performance.now();
            if (running.controller.signal.aborted) throw running.controller.signal.reason;
          }
        }
      }
      unzip.push(new Uint8Array(0), true);
      if (failure !== null) throw failure;
    } finally {
      for (const handle of open.values()) closeSync(handle);
      open.clear();
    }
  }

  #checkSizes(install: ProviderInstall, releaseDir: string): void {
    for (const file of install.files) {
      const target = join(releaseDir, file.path.split('\\').join('/'));
      if (!existsSync(target)) {
        throw refused(`the archive does not hold ${file.path}`, { file: file.path });
      }
      const actual = lstatSync(target).size;
      if (actual !== file.bytes) {
        throw refused(`${file.path} unpacked to ${actual} bytes, the descriptor expected ${file.bytes}`, {
          file: file.path,
          expectedBytes: file.bytes,
          actualBytes: actual,
        });
      }
    }
  }

  /** Off Windows a zip carries no mode Boite trusts, so the executable is made one. */
  #markExecutable(install: ProviderInstall, releaseDir: string): void {
    if (currentOs() === 'windows') return;
    for (const [index, file] of install.files.entries()) {
      if (index === 0 || file.executable === true) {
        chmodSync(join(releaseDir, file.path.split('\\').join('/')), 0o755);
      }
    }
  }

  /**
   * `current` points at the release that just landed: a junction on Windows, a
   * symlink elsewhere, and a plain rename of the directory where neither can be
   * made (an unprivileged account with no developer mode is the case). On that
   * last path an update has nothing to keep: the old release was moved into
   * `current` rather than linked, so repointing takes it.
   */
  #point(providerId: ProviderId, releaseDir: string): void {
    const link = this.currentDir(providerId);
    mkdirSync(dirname(link), { recursive: true });
    this.#removeCurrent(providerId);
    try {
      symlinkSync(releaseDir, link, currentOs() === 'windows' ? 'junction' : 'dir');
    } catch (error) {
      this.#log(
        'warn',
        `${providerId}: no link could be made (${error instanceof Error ? error.message : String(error)}), the release directory was moved into place instead`,
      );
      renameSync(releaseDir, link);
    }
  }

  /**
   * `existsSync` follows the link, so a broken one would read as absent and be
   * left behind. The link itself is what is looked at, and a Windows junction
   * refuses `unlink` while answering `rmdir`.
   */
  #removeCurrent(providerId: ProviderId): void {
    const link = this.currentDir(providerId);
    let stats;
    try {
      stats = lstatSync(link);
    } catch {
      return;
    }
    if (stats.isSymbolicLink()) {
      try {
        unlinkSync(link);
        return;
      } catch {
        /* a junction: rmdir takes it */
      }
      try {
        rmdirSync(link);
        return;
      } catch {
        /* neither: fall through to the recursive remove */
      }
    }
    rmSync(link, { recursive: true, force: true });
  }

  // -- reporting ------------------------------------------------------------

  #move(running: Running, providerId: ProviderId, state: ProviderInstallState): void {
    running.state = state;
    this.#emit(providerId, state);
  }

  #emit(providerId: ProviderId, state: ProviderInstallState): void {
    this.#sink?.emit({ ...state, providerId });
  }

  #log(level: 'info' | 'warn' | 'error', message: string): void {
    this.#sink?.log(level, message);
  }
}
