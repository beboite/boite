import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { processPlatform } from './platform/index.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OWNER_MAX_BYTES = 1024;
const OWNER_FILE = 'owner.json';

interface Owner {
  schemaVersion: 1;
  instanceId: string;
  hostname: string;
  platform: string;
  pid: number;
  startedAt: number | null;
}

export interface UploadRecovery { removed: string[]; preserved: number }

function parseOwner(body: string, instanceId: string): Owner | null {
  let owner: unknown;
  try { owner = JSON.parse(body); } catch { return null; }
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
  const value = owner as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'hostname,instanceId,pid,platform,schemaVersion,startedAt') return null;
  if (value.schemaVersion !== 1 || value.instanceId !== instanceId || !UUID.test(instanceId)) return null;
  if (typeof value.hostname !== 'string' || value.hostname.length > 255 || value.hostname !== hostname()) return null;
  if (typeof value.platform !== 'string' || value.platform !== process.platform) return null;
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0x7fffffff) return null;
  if (value.startedAt !== null && (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt) || value.startedAt <= 0 || value.startedAt > Number.MAX_SAFE_INTEGER)) return null;
  return value as unknown as Owner;
}

/** Only a recorded owner proved dead may surrender an old instance's scratch data. */
export class AttachmentUploadInstances {
  readonly id = randomUUID();
  readonly directory: string;
  private readonly root: string;
  private recovery?: Promise<UploadRecovery>;
  private ownership?: Promise<void>;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'attachment-uploads');
    this.directory = join(this.root, this.id);
  }

  recover(): Promise<UploadRecovery> {
    return this.recovery ??= this.sweep().catch(error => { this.recovery = undefined; throw error; });
  }

  own(): Promise<void> {
    return this.ownership ??= this.recordOwner().catch(error => { this.ownership = undefined; throw error; });
  }

  private async recordOwner(): Promise<void> {
    await this.recover();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const pending = join(this.directory, 'owner.pending');
    const owner: Owner = {
      schemaVersion: 1, instanceId: this.id, hostname: hostname(), platform: process.platform,
      pid: process.pid, startedAt: processPlatform.startedAt(process.pid),
    };
    try {
      const handle = await open(pending, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
      finally { await handle.close(); }
      // No body may be submitted until a complete ownership record is visible.
      await rename(pending, join(this.directory, OWNER_FILE));
    } catch (error) {
      try { await rm(pending, { force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'attachment owner recording and cleanup failed'); }
      throw error;
    }
  }

  private async owner(directory: string, instanceId: string): Promise<Owner | null> {
    const path = join(directory, OWNER_FILE);
    try {
      if (!(await lstat(path)).isFile()) return null;
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > OWNER_MAX_BYTES) return null;
        // Read a bounded buffer even if somebody grows the marker after stat.
        const body = Buffer.alloc(OWNER_MAX_BYTES + 1);
        const read = await handle.read(body, 0, body.length, 0);
        if (read.bytesRead > OWNER_MAX_BYTES) return null;
        return parseOwner(body.subarray(0, read.bytesRead).toString('utf8'), instanceId);
      } finally { await handle.close(); }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  }

  private dead(owner: Owner): boolean {
    // Managers in this process are independent. Even a mismatching timestamp
    // must never let one of them remove another current-PID instance.
    if (owner.pid === process.pid) return false;
    try { process.kill(owner.pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    const startedAt = processPlatform.startedAt(owner.pid);
    // A newer occupant proves PID reuse. Unavailable identity or permissions
    // remain conservative, including macOS's unsupported start-time reading.
    return owner.startedAt !== null && startedAt !== null && startedAt > owner.startedAt;
  }

  private async sweep(): Promise<UploadRecovery> {
    const result: UploadRecovery = { removed: [], preserved: 0 };
    try {
      const info = await lstat(this.root);
      if (info.isSymbolicLink()) throw new Error('attachment-uploads: expected a directory, not a symbolic link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }
    const directory = await opendir(this.root);
    for await (const entry of directory) {
      if (!entry.isDirectory() || !UUID.test(entry.name) || entry.name === this.id) { result.preserved += 1; continue; }
      const path = join(this.root, entry.name);
      const owner = await this.owner(path, entry.name);
      if (!owner || !this.dead(owner)) { result.preserved += 1; continue; }
      // Ownership is immutable after publication, but recheck it and the actual
      // directory before removal so concurrent recovery never follows a link.
      const checked = await this.owner(path, entry.name);
      let info;
      try { info = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!checked || !info.isDirectory() || JSON.stringify(checked) !== JSON.stringify(owner) || !this.dead(checked)) { result.preserved += 1; continue; }
      await rm(path, { recursive: true, force: true });
      result.removed.push(entry.name);
    }
    return result;
  }
}
