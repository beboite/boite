import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { recoveryLink, type ServerUpdatePlan, type ServerUpdatePlatform } from './types.ts';

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/**
 * Data-directory entries the snapshot leaves out. A release migrates the
 * journal and the small state files beside it; these stores it does not
 * rewrite, and they were most of the bytes: on a server with 1,300 threads,
 * checkpoints and browser profiles made the copy 8.9 GB and kept the service
 * down 2 min 25 s per update. A rollback keeps the live ones in place.
 */
export const UNSAVED_DATA = new Set(['checkpoints', 'browser', 'attachments', 'attachment-uploads', 'artifacts', 'logs', 'speech']);

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

/** Drops all but the newest `KEPT_BACKUPS` snapshots; a failure here never fails an installed update. */
function pruneBackups(parent: string): void {
  try {
    const backups = readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\.boite-backup-[a-f0-9-]{36}$/.test(entry.name))
      .map(entry => ({ path: join(parent, entry.name), at: statSync(join(parent, entry.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of backups.slice(KEPT_BACKUPS)) rmSync(old.path, { recursive: true, force: true });
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

export interface ApplyOptions {
  health?: (url: string) => Promise<{ ok: boolean; version: string; pid: number } | null>;
  pollMs?: number;
  healthTimeoutMs?: number;
  /** Free space required beyond the snapshot itself. */
  spareBytes?: number;
}

/** The worker's last word: its result is written and the service is in its final state. */
const FINISHED = 'finished';
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
 * Puts the data snapshot back, keeping the stores it leaves out. Each step
 * checks what the previous one left, so a restore cut short resumes.
 */
function restoreData(plan: ServerUpdatePlan, snapshot: string): void {
  const restored = `${plan.dataDir}.restore-${plan.id}`;
  const failed = `${plan.dataDir}.failed-${plan.id}`;
  if (existsSync(failed) && !existsSync(restored)) return;
  if (existsSync(plan.dataDir)) {
    if (existsSync(restored)) {
      // The stores an interrupted restore had already taken go back first.
      for (const name of UNSAVED_DATA) if (existsSync(join(restored, name)) && !existsSync(join(plan.dataDir, name))) renameSync(join(restored, name), join(plan.dataDir, name));
      rmSync(restored, { recursive: true, force: true });
    }
    // Preserve both the failed data and the snapshot if restoration itself fails.
    cpSync(snapshot, restored, { recursive: true, dereference: false, errorOnExist: true, force: false });
    // The stores left out of the snapshot move across as they are.
    for (const name of UNSAVED_DATA) if (existsSync(join(plan.dataDir, name))) renameSync(join(plan.dataDir, name), join(restored, name));
    renameSync(plan.dataDir, failed);
  }
  renameSync(restored, plan.dataDir);
}

/**
 * Restores the previous installation and data, then starts the service. It
 * reads where the update stood from the disk, not from the worker's memory,
 * so the recovery of a killed worker runs it too and resumes from there.
 */
async function rollBack(plan: ServerUpdatePlan, directory: string, platform: ServerUpdatePlatform, reason: string): Promise<void> {
  const root = plan.installation.directory;
  const service = plan.installation.service;
  const backup = backupOf(plan);
  const previous = join(backup, 'installation');
  const failedInstallation = join(directory, 'failed-installation');
  // The staged directory leaves the operation only to become the installation.
  const installed = !existsSync(join(directory, 'stage'));
  const touched = installed || existsSync(backup);
  // An admitted core exits by itself, and a start sent before it has would be lost.
  // A process the service started on its own is left as it is.
  if (touched || await platform.mainPid(service) === plan.originalPid) await platform.control(service, 'stop');
  if (installed && !existsSync(failedInstallation)) renameSync(root, failedInstallation);
  if (existsSync(previous) && !existsSync(root)) renameSync(previous, root);
  const snapshot = join(backup, 'data');
  if (installed && existsSync(snapshot)) restoreData(plan, snapshot);
  // A copy cut short (a full disk, a kill) frees its space; a complete one stays with the failure.
  if (!existsSync(snapshot)) rmSync(backup, { recursive: true, force: true });
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
    // Checked before the copy: a full disk once stopped the service halfway through it.
    const need = snapshotBytes(plan.dataDir) + (options.spareBytes ?? SPARE_BYTES);
    const disk = statfsSync(dirname(root));
    const free = disk.bavail * disk.bsize;
    if (free < need) throw new Error(`Not enough disk space beside ${root} for the backup: ${Math.ceil(need / 1024 ** 2)} MB needed, ${Math.floor(free / 1024 ** 2)} MB free`);
    await platform.control(plan.installation.service, 'stop');
    if (await platform.mainPid(plan.installation.service) !== 0) throw new Error('The server service did not stop');
    // Never copy a live SQLite directory. The whole snapshot also keeps account and pairing state.
    // It takes the name `data` once complete, so a copy cut short is never mistaken for a snapshot.
    mkdirSync(backup, { mode: 0o700 });
    cpSync(plan.dataDir, join(backup, 'data.partial'), { recursive: true, dereference: false, errorOnExist: true, force: false,
      filter: (source) => dirname(source) !== plan.dataDir || !UNSAVED_DATA.has(source.slice(plan.dataDir.length + 1)) });
    renameSync(join(backup, 'data.partial'), join(backup, 'data'));
    verifyStage(directory, plan);
    renameSync(root, join(backup, 'installation'));
    renameSync(join(directory, 'stage'), root);
    await platform.control(plan.installation.service, 'start');
    if (!await becomesHealthy(plan, platform, options)) throw new Error('The updated server did not become healthy within 30 seconds');
    writeResult(plan, null);
    writeFileSync(join(directory, FINISHED), '', { mode: 0o600 });
    pruneBackups(dirname(root));
  } catch (error) {
    failed = true;
    await rollBack(plan, directory, platform, error instanceof Error ? error.message : String(error));
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
    if (!existsSync(join(directory, 'stage')) && !existsSync(join(directory, 'failed-installation')) && existsSync(root)) {
      // The new version is in place; the worker may only have lacked the time to see it healthy.
      if (await platform.mainPid(plan.installation.service) === 0) await platform.control(plan.installation.service, 'start');
      if (await becomesHealthy(plan, platform, options)) {
        writeResult(plan, null);
        pruneBackups(dirname(root));
        rmSync(directory, { recursive: true, force: true });
        return;
      }
    }
    await rollBack(plan, directory, platform, `The update worker ended before it finished (${workerExit(options.env ?? process.env)})`);
    // The staged bundle and payload serve nothing once the service runs again; the result keeps the reason.
    rmSync(directory, { recursive: true, force: true });
  } finally { rmSync(recoveryLink(file), { force: true }); }
}

/**
 * Leftovers of a worker whose recovery never ran, after a power cut: an
 * unfinished operation, a snapshot cut short and a recovery link. A finished
 * failure stays for diagnosis. The next update runs it before starting its own.
 */
export function clearStaleUpdates(parent: string): void {
  const entries = () => readdirSync(parent, { withFileTypes: true });
  for (const entry of entries()) {
    const path = join(parent, entry.name);
    if (!entry.isDirectory()) continue;
    if (/^\.boite-update-[a-f0-9-]{36}$/.test(entry.name) && !existsSync(join(path, FINISHED))) rmSync(path, { recursive: true, force: true });
    if (/^\.boite-backup-[a-f0-9-]{36}$/.test(entry.name) && !existsSync(join(path, 'data'))) rmSync(path, { recursive: true, force: true });
  }
  for (const entry of entries()) {
    if (/^\.boite-recover-[a-f0-9-]{36}$/.test(entry.name) && !existsSync(join(parent, entry.name.replace('.boite-recover-', '.boite-update-')))) rmSync(join(parent, entry.name), { force: true });
  }
}
