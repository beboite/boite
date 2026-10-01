import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import type { ServerUpdatePlan, ServerUpdatePlatform } from './types.ts';

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const contains = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);

/** The private plan is produced by the owner-only RPC, never supplied by a remote caller. */
function readPlan(file: string): ServerUpdatePlan {
  const plan = JSON.parse(readFileSync(file, 'utf8')) as ServerUpdatePlan;
  if (!/^[a-f0-9-]{36}$/.test(plan.id) || typeof plan.installation?.directory !== 'string'
    || !/^[A-Za-z0-9_.@-]+\.service$/.test(plan.installation.service) || !Number.isSafeInteger(plan.originalPid)
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(plan.version) || !/^[a-f0-9]{64}$/.test(plan.archiveHash)) throw new Error('Invalid server update plan');
  const root = plan.installation.directory;
  if (!isAbsolute(root) || realpathSync(root) !== root || lstatSync(root).isSymbolicLink()
    || plan.installation.executable !== join(root, 'boite-core')
    || resolve(file) !== join(dirname(root), `.boite-update-${plan.id}`, 'plan.json')
    || !isAbsolute(plan.dataDir) || realpathSync(plan.dataDir) !== plan.dataDir
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
}

/** Runs in a separate user-service cgroup after the core has closed admission and finished its work. */
export async function applyServerUpdate(file: string, platform: ServerUpdatePlatform, options: ApplyOptions = {}): Promise<void> {
  const plan = readPlan(file);
  const directory = dirname(file);
  const backup = join(dirname(plan.installation.directory), `.boite-backup-${plan.id}`);
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
  let stopped = false;
  let installed = false;
  let previousSaved = false;
  let dataSaved = false;
  let failed = false;
  const result = (error: string | null) => writeFileSync(join(plan.dataDir, 'server-update-result.json'), JSON.stringify({ version: plan.version, error, at: Date.now() }), { mode: 0o600 });
  try {
    const pid = await platform.mainPid(plan.installation.service);
    if (pid !== 0 && pid !== plan.originalPid) throw new Error('The service restarted before the update; its new process was left untouched');
    await platform.control(plan.installation.service, 'stop');
    stopped = true;
    if (await platform.mainPid(plan.installation.service) !== 0) throw new Error('The server service did not stop');
    // Never copy a live SQLite directory. The whole snapshot also keeps account and pairing state.
    mkdirSync(backup, { mode: 0o700 });
    cpSync(plan.dataDir, join(backup, 'data'), { recursive: true, dereference: false, errorOnExist: true, force: false });
    dataSaved = true;
    verifyStage(directory, plan);
    renameSync(root, join(backup, 'installation'));
    previousSaved = true;
    renameSync(join(directory, 'stage'), root);
    installed = true;
    await platform.control(plan.installation.service, 'start');
    const health = options.health ?? (async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return response.ok ? await response.json() as { ok: boolean; version: string; pid: number } : null;
      } catch { return null; }
    });
    const deadline = Date.now() + (options.healthTimeoutMs ?? 30_000);
    let healthy = false;
    while (Date.now() < deadline) {
      const answer = await health(plan.healthUrl);
      if (answer?.ok && answer.version === plan.version && answer.pid === await platform.mainPid(plan.installation.service)) { healthy = true; break; }
      await pause(options.pollMs ?? 250);
    }
    if (!healthy) throw new Error('The updated server did not become healthy within 30 seconds');
    result(null);
  } catch (error) {
    failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    if (stopped) {
      await platform.control(plan.installation.service, 'stop');
      if (installed) renameSync(root, join(directory, 'failed-installation'));
      if (previousSaved) renameSync(join(backup, 'installation'), root);
      if (installed && dataSaved) {
        // Preserve both the failed data and the snapshot if restoration itself fails.
        const restored = `${plan.dataDir}.restore-${plan.id}`;
        cpSync(join(backup, 'data'), restored, { recursive: true, dereference: false, errorOnExist: true, force: false });
        renameSync(plan.dataDir, `${plan.dataDir}.failed-${plan.id}`);
        renameSync(restored, plan.dataDir);
      }
      result(`Server update failed; the previous version was restored. ${reason}`);
      await platform.control(plan.installation.service, 'start');
    } else result(`Server update was not installed. ${reason}`);
    throw error;
  } finally {
    // Failure artifacts and backups remain private, with the complete error in the helper's journal.
    if (!failed) rmSync(directory, { recursive: true, force: true });
  }
}
