import { readdirSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ProviderId, ProviderInstall, ProviderInstallState } from '@boite/contracts';
import { newId } from '../ids.ts';
import { agentsDirPath, providerAgentDir } from '../paths.ts';
import { messageOf, refused } from '../errors.ts';
import { forgetWhich } from './which.ts';
import {
  downloadArchive,
  dropPart,
  Dropped,
  humanMegabytes,
  IDLE_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  resumableBytes,
} from './install-download.ts';
import { pointCurrent, readReleaseRecord, removeCurrent, writeReleaseRecord, type ReleaseRecord } from './install-release.ts';
import { checkSizes, extractRelease, markExecutable } from './install-unpack.ts';

/** Room left on the volume after the archive and the unpacked files, so nothing fills the disk. */
export const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

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

/**
 * Managed installs: one release per provider, downloaded on request, unpacked
 * under the data directory, and pointed at by `{agentsDir}`. The state of each
 * lives here while an operation runs and on disk the rest of the time, so a
 * core that restarts mid-download comes back saying `absent` rather than
 * pretending an install is still going. The download is `install-download.ts`,
 * the unpacking `install-unpack.ts`, the record and the `current` link
 * `install-release.ts`.
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
    return readReleaseRecord(this.currentDir(providerId));
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
    const already = resumableBytes(this.partFile(providerId, install.version), install);
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
    removeCurrent(this.currentDir(providerId));
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
      await downloadArchive({
        providerId,
        install,
        operationId: running.operationId,
        signal: running.controller.signal,
        part,
        idleTimeoutMs: this.idleTimeoutMs,
        retryDelaysMs: this.retryDelaysMs,
        move: (state) => this.#move(running, providerId, state),
        log: (level, message) => this.#log(level, message),
      });
      this.#move(running, providerId, { state: 'extracting', version: install.version, operationId: running.operationId });
      rmSync(releaseDir, { recursive: true, force: true });
      await extractRelease(install, running.controller.signal, part, releaseDir);
      checkSizes(install, releaseDir);
      markExecutable(install, releaseDir);
      writeReleaseRecord(releaseDir, install);
      pointCurrent(providerId, this.currentDir(providerId), releaseDir, (level, message) => this.#log(level, message));
      forgetWhich();
      dropPart(part);

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
      if (!(error instanceof Dropped) && !(error instanceof Cancelled && error.keep)) dropPart(part);
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
