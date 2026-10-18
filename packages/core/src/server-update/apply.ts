import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { recoveryLink, type ServerUpdatePlan, type ServerUpdatePlatform } from './types.ts';
import { recordRestore, restoreSnapshot, UNSAVED_DATA } from './restore.ts';

export { UNSAVED_DATA };

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** Snapshots kept beside the installation; each still holds a whole journal. */
export const KEPT_BACKUPS = 2;

/** Bytes the data snapshot copies: everything but `UNSAVED_DATA`, symlinks not followed. */
function snapshotBytes(dataDir: string): number {
  let total = 0;
  const walk = (path: string): void => {
    const info = lstatSync(path);
    if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    else if (info.isFile()) total += info.size;
  };
  for (const name of readdirSync(dataDir)) if (!UNSAVED_DATA.has(name)) walk(join(dataDir, name));
  return total;
}

/** Room left once the snapshot is written, so the restarted server can still write its journal. */
const SPARE_BYTES = 1024 ** 3;

/** Names the installation a backup belongs to and when it was taken. */
const BACKUP_MARKER = 'backup.json';
const BACKUP_NAME = /^\.boite-backup-[a-f0-9-]{36}$/;

/** The installation a backup was taken for and when, or null for a backup this flow did not mark. */
function backupOwner(path: string): { installation: string; at: number } | null {
  try {
    const owner = JSON.parse(readFileSync(join(path, BACKUP_MARKER), 'utf8')) as { installation?: unknown; at?: unknown };
    return typeof owner.installation === 'string' && Number.isFinite(owner.at) ? { installation: owner.installation, at: owner.at as number } : null;
  } catch { return null; }
}

/**
 * Keeps this update's snapshot and the newest older ones of the same
 * installation, `KEPT_BACKUPS` in all. Another installation can share the
 * folder and the user can keep copies there: a backup whose marker does not
 * name this installation, an unmarked one included, is never touched. Only a
 * backup holding a complete snapshot counts: one whose snapshot a rollback
 * used, or a kill cut short, must not push out a usable older one. A
 * failure here never fails an installed update.
 */
function pruneBackups(plan: ServerUpdatePlan): void {
  const parent = dirname(plan.installation.directory);
  const current = backupOf(plan);
  try {
    const backups = readdirSync(parent, { withFileTypes: true }).flatMap(entry => {
      const path = join(parent, entry.name);
      const owner = entry.isDirectory() && BACKUP_NAME.test(entry.name) && path !== current && existsSync(join(path, 'data')) ? backupOwner(path) : null;
      return owner?.installation === plan.installation.directory ? [{ path, at: owner.at }] : [];
    }).sort((a, b) => b.at - a.at);
    for (const old of backups.slice(KEPT_BACKUPS - 1)) rmSync(old.path, { recursive: true, force: true });
  } catch { /* The next update prunes again. */ }
}
const contains = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);

/** The private plan is produced by the owner-only RPC, never supplied by a remote caller. */
function readPlan(file: string, recovering = false): ServerUpdatePlan {
  const plan = JSON.parse(readFileSync(file, 'utf8')) as ServerUpdatePlan;
  if (!/^[a-f0-9-]{36}$/.test(plan.id) || typeof plan.installation?.directory !== 'string'
    || !/^[A-Za-z0-9_.@-]+\.service$/.test(plan.installation.service) || !Number.isSafeInteger(plan.originalPid)
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(plan.version) || !/^[a-f0-9]{64}$/.test(plan.archiveHash)) throw new Error('Invalid server update plan');
  const root = plan.installation.directory;
  if (!isAbsolute(root) || plan.installation.executable !== join(root, 'boite-core')
    || resolve(file) !== join(dirname(root), `.boite-update-${plan.id}`, 'plan.json')
    // A recovery can find the installation or the data moved aside by the worker it replaces.
    || ((!recovering || existsSync(root)) && (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()))
    || !isAbsolute(plan.dataDir) || ((!recovering || existsSync(plan.dataDir)) && realpathSync(plan.dataDir) !== plan.dataDir)
    || contains(root, plan.dataDir) || contains(plan.dataDir, root)) throw new Error('Update installation and data must be separate absolute directories without symlinks');
  const url = new URL(plan.healthUrl);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/health') throw new Error('Update healthUrl must name the core HTTP health endpoint');
  return plan;
}

function verifyStage(directory: string, plan: ServerUpdatePlan): void {
  const bytes = readFileSync(join(directory, 'payload.zip'));
  if (createHash('sha256').update(bytes).digest('hex') !== plan.archiveHash) throw new Error('Update archive changed after signature verification');
  const entries = unzipSync(bytes);
  const release = JSON.parse(Buffer.from(entries['server-release.json'] ?? []).toString()) as { version?: unknown };
  if (release.version !== plan.version) throw new Error('Staged server version changed');
  for (const [name, original] of Object.entries(entries)) {
    if (name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')
      || (name !== 'boite-core' && name !== 'boite' && name !== 'server-release.json' && !name.startsWith('ui/'))) throw new Error(`Unsafe update file ${name}`);
    const file = join(directory, 'stage', name);
    if (lstatSync(file).isSymbolicLink() || !readFileSync(file).equals(Buffer.from(original))) throw new Error(`Staged update file changed: ${name}`);
  }
  for (const required of ['boite-core', 'boite', 'ui/index.html']) if (!entries[required]?.length) throw new Error(`Staged update is missing ${required}`);
}

/** The disk operations whose cost depends on free space; tests replace them to stand for a full disk. */
export interface UpdateDisk {
  /** Bytes an unprivileged process may still write on the filesystem holding `path`. */
  free(path: string): number;
  copy(source: string, target: string, filter?: (source: string) => boolean): void;
  rename(source: string, target: string): void;
  /** The filesystem holding `path`, compared only with another. */
  device(path: string): number;
}

const realDisk: UpdateDisk = {
  free: (path) => { const disk = statfsSync(path); return disk.bavail * disk.bsize; },
  copy: (source, target, filter) => cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false, filter }),
  rename: renameSync,
  device: (path) => statSync(path).dev,
};

export interface ApplyOptions {
  health?: (url: string) => Promise<{ ok: boolean; version: string; pid: number } | null>;
  pollMs?: number;
  healthTimeoutMs?: number;
  /** Free space required beyond the snapshot itself. */
  spareBytes?: number;
  disk?: Partial<UpdateDisk>;
}

const diskOf = (options: ApplyOptions): UpdateDisk => ({ ...realDisk, ...options.disk });

/** The worker's last word: its result is written and the service is in its final state. */
const FINISHED = 'finished';
/** Written before a rollback touches anything: the new version was rejected and must not be kept. */
const ROLLING_BACK = 'rolling-back';
const backupOf = (plan: ServerUpdatePlan) => join(dirname(plan.installation.directory), `.boite-backup-${plan.id}`);
const writeResult = (plan: ServerUpdatePlan, error: string | null) =>
  writeFileSync(join(plan.dataDir, 'server-update-result.json'), JSON.stringify({ version: plan.version, error, at: Date.now() }), { mode: 0o600 });

/** The service reports the target version from its current main process. */
async function becomesHealthy(plan: ServerUpdatePlan, platform: ServerUpdatePlatform, options: ApplyOptions): Promise<boolean> {
  const health = options.health ?? (async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return response.ok ? await response.json() as { ok: boolean; version: string; pid: number } : null;
    } catch { return null; }
  });
  const deadline = Date.now() + (options.healthTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const answer = await health(plan.healthUrl);
    if (answer?.ok && answer.version === plan.version && answer.pid === await platform.mainPid(plan.installation.service)) return true;
    await pause(options.pollMs ?? 250);
  }
  return false;
}

/**
 * Restores the previous installation and data, then starts the service. It
 * reads where the update stood from the disk, not from the worker's memory,
 * so the recovery of a killed worker runs it too and resumes from there.
 */
async function rollBack(plan: ServerUpdatePlan, directory: string, platform: ServerUpdatePlatform, disk: UpdateDisk, reason: string): Promise<void> {
  const root = plan.installation.directory;
  const service = plan.installation.service;
  const backup = backupOf(plan);
  const previous = join(backup, 'installation');
  const failedInstallation = join(directory, 'failed-installation');
  const restore = { id: plan.id, snapshot: join(backup, 'data') };
  // The staged directory leaves the operation only to become the installation.
  const installed = !existsSync(join(directory, 'stage'));
  const touched = installed || existsSync(backup);
  writeFileSync(join(directory, ROLLING_BACK), '', { mode: 0o600 });
  // An admitted core exits by itself, and a start sent before it has would be lost.
  // A process the service started on its own is left as it is.
  if (touched || await platform.mainPid(service) === plan.originalPid) await platform.control(service, 'stop');
  if (installed && !existsSync(failedInstallation)) renameSync(root, failedInstallation);
  // A new version in place has run on the live data, or will have: the recovery starts one it finds stopped.
  // Its restore is on record before the previous version can boot on that data, so a start at boot finishes it.
  if (installed && existsSync(restore.snapshot)) recordRestore(plan.dataDir, restore, platform.lock);
  if (existsSync(previous) && !existsSync(root)) disk.rename(previous, root);
  if (installed) {
    try {
      // The snapshot moves back rather than being copied: the update checked room for one copy, and a
      // second one once failed the rollback of a disk left with only the spare, with the service stopped.
      restoreSnapshot(plan.dataDir, restore, disk, platform.lock);
    } catch (error) {
      // The previous core would open the data the rejected one migrated, and the restore that follows
      // would discard whatever it accepted: the service stays stopped, and the recovery or the next start retries.
      try {
        writeResult(plan, `Server update failed and the previous data could not be put back yet (${error instanceof Error ? error.message : String(error)}); the server stays stopped until it is. ${reason}`);
      } catch { /* The data directory may be the one that failed to move. */ }
      throw error;
    }
  }
  // A copy cut short (a full disk, a kill) frees its space, and a snapshot that became the data leaves the backup empty;
  // a snapshot never used stays with the failure.
  if (!existsSync(join(backup, 'data'))) rmSync(backup, { recursive: true, force: true });
  writeResult(plan, touched ? `Server update failed; the previous version was restored. ${reason}` : `Server update was not installed. ${reason}`);
  await platform.control(service, 'start');
  writeFileSync(join(directory, FINISHED), '', { mode: 0o600 });
}

/** Runs in a separate user-service cgroup after the core has closed admission and finished its work. */
export async function applyServerUpdate(file: string, platform: ServerUpdatePlatform, options: ApplyOptions = {}): Promise<void> {
  const plan = readPlan(file);
  const directory = dirname(file);
  const backup = backupOf(plan);
  const root = plan.installation.directory;
  const disk = diskOf(options);
  verifyStage(directory, plan);
  writeFileSync(join(directory, 'ready'), '', { mode: 0o600 });
  while (!existsSync(join(directory, 'admitted'))) {
    if (!existsSync(directory) || existsSync(join(directory, 'cancelled')) || await platform.mainPid(plan.installation.service) !== plan.originalPid) {
      rmSync(directory, { recursive: true, force: true });
      return;
    }
    await pause(options.pollMs ?? 200);
  }
  if (readFileSync(join(directory, 'admitted'), 'utf8') !== plan.id || existsSync(join(directory, 'cancelled'))) return;
  let failed = false;
  try {
    const pid = await platform.mainPid(plan.installation.service);
    if (pid !== 0 && pid !== plan.originalPid) throw new Error('The service restarted before the update; its new process was left untouched');
    // Checked before the copy: a full disk once stopped the service halfway through it. A rollback
    // renames the snapshot back, but across filesystems it copies it beside the data directory.
    const need = snapshotBytes(plan.dataDir) + (options.spareBytes ?? SPARE_BYTES);
    const sides = [{ path: dirname(root), shown: root, purpose: 'the backup' }];
    if (disk.device(dirname(root)) !== disk.device(plan.dataDir)) sides.push({ path: plan.dataDir, shown: plan.dataDir, purpose: 'a rollback' });
    for (const side of sides) {
      const free = disk.free(side.path);
      if (free < need) throw new Error(`Not enough disk space beside ${side.shown} for ${side.purpose}: ${Math.ceil(need / 1024 ** 2)} MB needed, ${Math.floor(free / 1024 ** 2)} MB free`);
    }
    await platform.control(plan.installation.service, 'stop');
    if (await platform.mainPid(plan.installation.service) !== 0) throw new Error('The server service did not stop');
    // Never copy a live SQLite directory. The whole snapshot also keeps account and pairing state.
    // It takes the name `data` once complete, so a copy cut short is never mistaken for a snapshot.
    mkdirSync(backup, { mode: 0o700 });
    writeFileSync(join(backup, BACKUP_MARKER), JSON.stringify({ installation: root, at: Date.now() }), { mode: 0o600 });
    disk.copy(plan.dataDir, join(backup, 'data.partial'),
      (source) => dirname(source) !== plan.dataDir || !UNSAVED_DATA.has(source.slice(plan.dataDir.length + 1)));
    renameSync(join(backup, 'data.partial'), join(backup, 'data'));
    verifyStage(directory, plan);
    renameSync(root, join(backup, 'installation'));
    renameSync(join(directory, 'stage'), root);
    await platform.control(plan.installation.service, 'start');
    if (!await becomesHealthy(plan, platform, options)) throw new Error('The updated server did not become healthy within 30 seconds');
    writeResult(plan, null);
    writeFileSync(join(directory, FINISHED), '', { mode: 0o600 });
    pruneBackups(plan);
  } catch (error) {
    failed = true;
    await rollBack(plan, directory, platform, disk, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    // Failure artifacts and backups remain private, with the complete error in the helper's journal.
    if (!failed) rmSync(directory, { recursive: true, force: true });
  }
}

/** systemd's account of how the worker ended, for the result a client shows. */
function workerExit(env: NodeJS.ProcessEnv): string {
  const parts = [env.SERVICE_RESULT, env.EXIT_CODE, env.EXIT_STATUS].filter((part): part is string => !!part && /^[\w-]{1,32}$/.test(part));
  return parts.length ? parts.join(', ') : 'no exit status';
}

/**
 * The worker unit's ExecStopPost. It runs however the worker ended, a kill by
 * the memory controller included, and leaves the service running. A worker
 * that finished, or never had the core stop, leaves it nothing to do.
 */
export async function recoverServerUpdate(file: string, platform: ServerUpdatePlatform, options: ApplyOptions & { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  try {
    const directory = dirname(file);
    if (!existsSync(file) || existsSync(join(directory, FINISHED))) return;
    const plan = readPlan(file, true);
    const admitted = join(directory, 'admitted');
    try {
      // Closes admission atomically: a core that has not admitted yet fails its write and keeps running.
      mkdirSync(admitted, { mode: 0o700 });
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(admitted).isFile() || readFileSync(admitted, 'utf8') !== plan.id) { rmSync(directory, { recursive: true, force: true }); return; }
    const root = plan.installation.directory;
    if (!existsSync(join(directory, 'stage')) && !existsSync(join(directory, ROLLING_BACK)) && existsSync(root)) {
      // The new version is in place; the worker may only have lacked the time to see it healthy.
      if (await platform.mainPid(plan.installation.service) === 0) await platform.control(plan.installation.service, 'start');
      if (await becomesHealthy(plan, platform, options)) {
        writeResult(plan, null);
        pruneBackups(plan);
        rmSync(directory, { recursive: true, force: true });
        return;
      }
    }
    await rollBack(plan, directory, platform, diskOf(options), `The update worker ended before it finished (${workerExit(options.env ?? process.env)})`);
    // The staged bundle and payload serve nothing once the service runs again; the result keeps the reason.
    rmSync(directory, { recursive: true, force: true });
  } finally { rmSync(recoveryLink(file), { force: true }); }
}

/** Written in an operation directory as soon as it exists, before its plan: the installation it updates. */
export const UPDATE_OWNER = 'owner.json';

/** The installation an operation directory names, in its owner record or, from an older release, its plan. */
function operationOwner(path: string): string | null {
  for (const file of [UPDATE_OWNER, 'plan.json']) {
    try {
      const record = JSON.parse(readFileSync(join(path, file), 'utf8')) as { installation?: unknown };
      const installation = typeof record.installation === 'string' ? record.installation : (record.installation as { directory?: unknown } | undefined)?.directory;
      if (typeof installation === 'string') return installation;
    } catch { /* The next record, if any. */ }
  }
  return null;
}

/**
 * Leftovers of a worker of this installation whose recovery never ran, after
 * a power cut: an unfinished operation, a snapshot cut short and a recovery
 * link. A finished failure stays for diagnosis. The next update runs it before
 * starting its own. Another installation can share `parent` and be updating
 * right now: an operation or backup whose record names another installation,
 * or names none, is left alone.
 */
export function clearStaleUpdates(parent: string, installation: string): void {
  const entries = () => readdirSync(parent, { withFileTypes: true });
  const idOf = (name: string, kind: string) => new RegExp(`^\\.boite-${kind}-([a-f0-9-]{36})$`).exec(name)?.[1];
  // An older release's snapshot has no marker; the operation it belongs to names the installation.
  const own = new Set<string>();
  for (const entry of entries()) {
    const id = entry.isDirectory() ? idOf(entry.name, 'update') : undefined;
    if (id && operationOwner(join(parent, entry.name)) === installation) own.add(id);
  }
  for (const entry of entries()) {
    const path = join(parent, entry.name);
    if (!entry.isDirectory()) continue;
    const update = idOf(entry.name, 'update');
    if (update && own.has(update) && !existsSync(join(path, FINISHED))) rmSync(path, { recursive: true, force: true });
    const backup = idOf(entry.name, 'backup');
    if (backup && !existsSync(join(path, 'data')) && (own.has(backup) || backupOwner(path)?.installation === installation)) rmSync(path, { recursive: true, force: true });
  }
  // A link whose operation is gone serves nobody; a live operation of another installation keeps its own.
  for (const entry of entries()) {
    const id = idOf(entry.name, 'recover');
    if (id && !existsSync(join(parent, `.boite-update-${id}`))) rmSync(join(parent, entry.name), { force: true });
  }
}
