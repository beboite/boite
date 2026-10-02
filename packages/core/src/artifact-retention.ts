import { readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Core } from './core.ts';
import type { ArtifactScanReply } from './artifact-retention-worker.ts';
import { workerEntry } from './worker-entry.ts';

const DAY = 86_400_000;

function scanReferences(path: string, signal?: AbortSignal): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new Worker(workerEntry(import.meta.url, 'artifact-retention-worker'));
    let settled = false;
    const finish = (error?: unknown, ids?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (ids) resolve(new Set(ids)); else reject(error);
    };
    const abort = () => finish(signal?.reason);
    const timeout = setTimeout(() => finish(new Error('artifact reference scan timed out')), 120_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => finish(new Error(event.message));
    worker.onmessage = (event: MessageEvent<ArtifactScanReply>) => {
      if ('error' in event.data) finish(new Error(event.data.error)); else finish(undefined, event.data.ids);
    };
    worker.postMessage(path);
  });
}

/** Keep snapshots referenced by any conversation, including forks and undoable deletions. */
export async function pruneArtifactSnapshots(core: Core, now = Date.now(), signal?: AbortSignal): Promise<void> {
  const changes = () => (core.journal.db.query('SELECT total_changes() AS count').get() as { count: number }).count;
  const revision = changes();
  const directory = join(core.dataDir, 'artifacts');
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (entries.length === 0) return;
  const referenced = await scanReferences(join(core.dataDir, 'journal.db'), signal);
  for (const name of entries) {
    if (!/^[a-f0-9-]{36}(\.partial)?$/.test(name) || referenced.has(name)) continue;
    const path = join(directory, name);
    try {
      const modified = (await lstat(path)).mtimeMs;
      // Any write may have added a fork/reference while the worker was reading.
      // Leave this pass for later rather than delete using an obsolete snapshot.
      if (signal?.aborted || core.journal.isClosed() || changes() !== revision) return;
      // The grace period protects an in-flight publication; unlink never follows a symlink.
      if (modified < now - DAY) await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function scheduleArtifactRetention(core: Core): () => Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const pass = () => {
    pending = pruneArtifactSnapshots(core, Date.now(), abort.signal).catch(error => {
      if (!abort.signal.aborted) core.log('error', `artifact retention: ${String(error)}`);
    }).finally(() => {
      if (!stopped) { timer = setTimeout(pass, DAY); timer.unref(); }
    });
  };
  timer = setTimeout(pass, 60_000); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); abort.abort(); await pending; };
}
