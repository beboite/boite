import { readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Core } from './core.ts';

const DAY = 86_400_000;

/** Keep snapshots referenced by any conversation, including forks and undoable deletions. */
export async function pruneArtifactSnapshots(core: Core, now = Date.now()): Promise<void> {
  const directory = join(core.dataDir, 'artifacts');
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const referenced = new Set((core.journal.db.query(`SELECT DISTINCT json_extract(part.value, '$.id') AS id
    FROM messages, json_each(messages.parts) AS part WHERE json_extract(part.value, '$.type') = 'artifact'`)
    .all() as { id: string }[]).map(row => row.id));
  for (const name of entries) {
    if (!/^[a-f0-9-]{36}(\.partial)?$/.test(name) || referenced.has(name)) continue;
    const path = join(directory, name);
    try {
      // The grace period protects an in-flight publication; unlink never follows a symlink.
      if ((await lstat(path)).mtimeMs < now - DAY) await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function scheduleArtifactRetention(core: Core): () => Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const pass = () => {
    pending = pruneArtifactSnapshots(core).catch(error => core.log('error', `artifact retention: ${String(error)}`)).finally(() => {
      if (!stopped) { timer = setTimeout(pass, DAY); timer.unref(); }
    });
  };
  timer = setTimeout(pass, 60_000); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}
