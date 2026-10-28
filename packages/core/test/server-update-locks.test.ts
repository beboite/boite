import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { takeLock } from '../src/data-lock.ts';
import { lockFile } from '../src/platform/index.ts';
import { restoreSnapshot, type RestoreMoves } from '../src/server-update/restore.ts';

test.each([false, true])('rollback closes native handles before directory renames while live PID records keep other cores out (rejected folder exists: %s)', rejectedExists => {
  const root = mkdtempSync(join(tmpdir(), 'boite-restore-locks-'));
  const data = join(root, 'data'), snapshot = join(root, 'snapshot');
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const active = new Set<string>();
  let checked = 0;
  const lockData = (directory: string) => takeLock(join(directory, 'core.lock'), () => 'busy', {}, file => {
    const held = lockFile(file);
    if (!held) return null;
    active.add(file);
    return { ...held, release() { active.delete(file); held.release(); } };
  });
  const moves: RestoreMoves = {
    copy: (source, target) => cpSync(source, target, { recursive: true }),
    rename(source, target) {
      if (source === data || source === `${data}.restore-${id}`) {
        // Windows refuses to rename a directory with open descendants, even when the files share delete access.
        if ([...active].some(file => file.startsWith(`${source}${sep}`))) {
          throw Object.assign(new Error('EPERM: open lock handle blocks directory rename'), { code: 'EPERM' });
        }
        // An in-flight start may have checked for a rollback record before it was published.
        // It must still refuse the unlocked directory. Older cores also honor this live PID record.
        const contender = Bun.spawnSync([process.execPath, '-e', `
          import { lockDataDir } from ${JSON.stringify(join(import.meta.dir, '../src/data-lock.ts'))};
          try { lockDataDir(${JSON.stringify(source)})(); console.log('admitted'); }
          catch (error) { console.log(error.message); }
        `], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
        expect(contender.exitCode).toBe(0);
        expect(contender.stdout.toString()).toContain('another core is already running');
        expect(JSON.parse(readFileSync(join(source, 'core.lock'), 'utf8')).osLock).not.toBe(true);
        checked++;
      }
      renameSync(source, target);
    },
  };
  try {
    mkdirSync(join(data, 'checkpoints'), { recursive: true }); mkdirSync(snapshot);
    writeFileSync(join(data, 'pairing.json'), 'rejected pairing');
    writeFileSync(join(data, 'checkpoints', 'live'), 'kept checkpoint');
    writeFileSync(join(snapshot, 'pairing.json'), 'previous pairing');
    if (rejectedExists) mkdirSync(`${data}.failed-${id}`);
    restoreSnapshot(data, { id, snapshot }, moves, file => takeLock(file, () => 'maintenance busy'), lockData);
    expect(checked).toBe(2);
    expect(active.size).toBe(0);
    expect(readFileSync(join(data, 'pairing.json'), 'utf8')).toBe('previous pairing');
    expect(readFileSync(join(data, 'checkpoints', 'live'), 'utf8')).toBe('kept checkpoint');
    expect(existsSync(join(data, 'core.lock'))).toBe(false);
    lockData(data)();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
