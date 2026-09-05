/**
 * Idle working set of the core against a bare Bun process, on the same machine
 * and in the same second. What the core carries above bare Bun is the number
 * that matters: everything a fresh core loads before a thread ever runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETTLE_MS = 4_500;
const BARE_SLEEP_MS = 9_000;
const CORE_DIR = join(import.meta.dir, '..', 'packages', 'core');
const MB = 1024 * 1024;

function workingSets(pids: number[]): Map<number, number> {
  const list = pids.join(',');
  const script = `Get-Process -Id ${list} | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`;
  const read = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-Command', script],
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const sets = new Map<number, number>();
  for (const line of read.stdout.toString().split('\n')) {
    const [pid, bytes] = line.trim().split(' ');
    if (pid === undefined || bytes === undefined) continue;
    const id = Number(pid);
    const size = Number(bytes);
    if (Number.isFinite(id) && Number.isFinite(size)) sets.set(id, size);
  }
  return sets;
}

function megabytes(bytes: number | undefined): string {
  return bytes === undefined ? 'unread' : `${(bytes / MB).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-idle-'));

  const bare = Bun.spawn({
    cmd: [process.execPath, '-e', `await Bun.sleep(${BARE_SLEEP_MS})`],
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  });
  const core = Bun.spawn({
    cmd: [process.execPath, 'run', 'src/main.ts', '--port', '0'],
    cwd: CORE_DIR,
    env: { ...process.env, BOITE_DATA_DIR: dataDir },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  });

  try {
    await Bun.sleep(SETTLE_MS);
    const sets = workingSets([bare.pid, core.pid]);
    const bareBytes = sets.get(bare.pid);
    const coreBytes = sets.get(core.pid);
    process.stdout.write(`bare bun   ${megabytes(bareBytes)}\n`);
    process.stdout.write(`core idle  ${megabytes(coreBytes)}\n`);
    if (bareBytes !== undefined && coreBytes !== undefined) {
      process.stdout.write(`difference ${((coreBytes - bareBytes) / MB).toFixed(1)} MB\n`);
    }
  } finally {
    bare.kill();
    core.kill();
    await Promise.all([bare.exited, core.exited]);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
