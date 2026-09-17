import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import type { ProviderId, ProviderInstall, ProviderInstallState } from '@boite/contracts';
import { newId } from '../ids.ts';
import { agentsDirPath, currentOs, providerAgentDir } from '../paths.ts';
import { messageOf, refused, unavailable } from '../errors.ts';

/** Room left on the volume after the archive and the unpacked files, so nothing fills the disk. */
export const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

/** Written beside the files a release unpacked to, and the only proof an install finished. */
export const RELEASE_RECORD = '.install-complete.json';

/** How often a download reports itself while it runs. */
const PROGRESS_INTERVAL_MS = 250;

interface ReleaseRecord {
  version: string;
  files: string[];
  installedAt: number;
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

class Cancelled extends Error {
  constructor() {
    super('the install was cancelled');
    this.name = 'InstallCancelled';
  }
}

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

  constructor(private readonly dataDir: string) {}

  attach(sink: InstallSink): void {
    this.#sink = sink;
  }

  // -- paths ----------------------------------------------------------------

  currentDir(providerId: ProviderId): string {
    return agentsDirPath(this.dataDir, providerId);
  }

  releaseDir(providerId: ProviderId, version: string): string {
    return join(providerAgentDir(this.dataDir, providerId), 'releases', version);
  }

  partFile(providerId: ProviderId, version: string): string {
    return join(providerAgentDir(this.dataDir, providerId), 'downloads', `${version}.zip.part`);
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
    if (count <= 1) this.#leases.delete(providerId);
    else this.#leases.set(providerId, count - 1);
  }

  leaseCount(providerId: ProviderId): number {
    return this.#leases.get(providerId) ?? 0;
  }

  // -- operations -----------------------------------------------------------

  /**
   * The download, and the update: a provider whose record names an older
   * version installs the new release beside it and repoints `current`. Nothing
   * of the old release is deleted here, a process may still be running out of
   * it; `uninstall` takes the whole directory.
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
    const record = this.#readRecord(providerId);
    if (record !== null && record.version === install.version) {
      throw refused(`${providerId} is up to date on ${install.version}`, {
        providerId,
        version: install.version,
      });
    }
    this.#failed.delete(providerId);

    const extractedBytes = install.format === 'binary' ? 0 : totalFileBytes(install);
    const needed = install.archiveBytes + extractedBytes + FREE_SPACE_MARGIN;
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

  /** Core shutdown: abort what is still downloading rather than leaving a fetch behind. */
  stop(): void {
    for (const running of this.#running.values()) running.controller.abort(new Cancelled());
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
      rmSync(part, { force: true });

      const record = this.#readRecord(providerId);
      const state: ProviderInstallState = {
        state: 'installed',
        version: install.version,
        installedAt: record?.installedAt ?? Date.now(),
        available: install.version,
      };
      this.#running.delete(providerId);
      this.#emit(providerId, state);
      this.#sink?.updated();
    } catch (error) {
      rmSync(part, { force: true });
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
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const state: ProviderInstallState = { state: 'failed', version: install.version, message };
      this.#failed.set(providerId, state);
      this.#log('error', `installing ${providerId} failed: ${message}`);
      this.#emit(providerId, state);
    }
  }

  async #download(
    providerId: ProviderId,
    install: ProviderInstall,
    running: Running,
    part: string,
  ): Promise<void> {
    mkdirSync(dirname(part), { recursive: true });
    rmSync(part, { force: true });

    const response = await fetch(install.url, { signal: running.controller.signal });
    if (!response.ok || response.body === null) {
      throw unavailable(`${install.url} answered ${response.status} ${response.statusText}`, {
        providerId,
        url: install.url,
        status: response.status,
      });
    }

    const hasher = new Bun.CryptoHasher('sha256');
    const handle = openSync(part, 'w');
    let received = 0;
    let lastReport = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (running.controller.signal.aborted) throw new Cancelled();
        hasher.update(chunk);
        writeSync(handle, chunk);
        received += chunk.byteLength;
        const now = Date.now();
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          this.#move(running, providerId, {
            state: 'downloading',
            version: install.version,
            receivedBytes: received,
            totalBytes: install.archiveBytes,
            operationId: running.operationId,
          });
        }
      }
    } finally {
      closeSync(handle);
    }

    this.#move(running, providerId, {
      state: 'verifying',
      version: install.version,
      operationId: running.operationId,
    });

    if (received !== install.archiveBytes) {
      throw refused(
        `${install.url} is ${received} bytes, the descriptor expected ${install.archiveBytes}`,
        { providerId, url: install.url, expectedBytes: install.archiveBytes, actualBytes: received },
      );
    }
    const digest = hasher.digest('hex');
    if (digest !== install.sha256.toLowerCase()) {
      throw refused(
        `${install.url} hashes to ${digest}, the descriptor expected ${install.sha256.toLowerCase()}`,
        { providerId, url: install.url, expectedSha256: install.sha256.toLowerCase(), actualSha256: digest },
      );
    }
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
      if (running.controller.signal.aborted) throw new Cancelled();
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
      for (;;) {
        if (running.controller.signal.aborted) throw new Cancelled();
        const { done, value } = await reader.read();
        if (done) break;
        unzip.push(value, false);
        if (failure !== null) throw failure;
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
