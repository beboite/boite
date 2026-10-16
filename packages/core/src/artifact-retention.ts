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

/** How soon a pass that a journal write interrupted tries again, and how many times in a row before waiting a day. */
const ARTIFACT_RETRY_MS = 15 * 60_000;
const ARTIFACT_RETRIES = 8;
/** Scans per pass: a write during the first one gets one rescan before the pass gives up. */
const ARTIFACT_SCANS = 2;

/**
 * Keep snapshots referenced by any conversation, including forks and undoable
 * deletions. Resolves false when journal writes kept interrupting the scan
 * and some candidates are left for a later pass.
 */
export async function pruneArtifactSnapshots(core: Core, now = Date.now(), signal?: AbortSignal): Promise<boolean> {
  const changes = () => (core.journal.db.query('SELECT total_changes() AS count').get() as { count: number }).count;
  const directory = join(core.dataDir, 'artifacts');
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  // The grace period protects an in-flight publication. Checking it first
  // spares the whole-journal scan on the days nothing is old enough to go.
  let candidates: { path: string; id: string }[] = [];
  for (const name of entries) {
    // A view's gzipped copy (`VIEW_GZIP_SUFFIX`) lives and goes with its snapshot; a `.partial` is never referenced.
    const snapshot = /^([a-f0-9-]{36})(\.partial|\.gz)?$/.exec(name);
    if (snapshot === null) continue;
    const path = join(directory, name);
    if (await olderThanDay(path, now)) candidates.push({ path, id: snapshot[2] === '.gz' ? snapshot[1]! : name });
  }
  for (let scan = 0; scan < ARTIFACT_SCANS && candidates.length > 0; scan += 1) {
    const revision = changes();
    const referenced = await scanReferences(join(core.dataDir, 'journal.db'), signal);
    const left: typeof candidates = [];
    for (const candidate of candidates) {
      if (referenced.has(candidate.id)) continue;
      if (signal?.aborted || core.journal.isClosed()) return true;
      // Any write may have added a fork/reference while the worker was reading:
      // never delete using an obsolete scan. What is left waits for a fresh one.
      if (left.length > 0 || changes() !== revision) { left.push(candidate); continue; }
      try {
        // unlink never follows a symlink.
        if (await olderThanDay(candidate.path, now)) await unlink(candidate.path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    candidates = left;
  }
  return candidates.length === 0;
}

async function olderThanDay(path: string, now: number): Promise<boolean> {
  try { return (await lstat(path)).mtimeMs < now - DAY; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function scheduleArtifactRetention(core: Core): () => Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let retries = 0;
  const pass = () => {
    let next = DAY;
    pending = pruneArtifactSnapshots(core, Date.now(), abort.signal).then(done => {
      // A busy journal interrupted the pass: try again soon, a few times, before waiting a day.
      retries = done || retries >= ARTIFACT_RETRIES ? 0 : retries + 1;
      if (retries > 0) next = ARTIFACT_RETRY_MS;
    }, error => {
      if (!abort.signal.aborted) core.log('error', `artifact retention: ${String(error)}`);
    }).finally(() => {
      if (!stopped) { timer = setTimeout(pass, next); timer.unref(); }
    });
  };
  timer = setTimeout(pass, 60_000); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); abort.abort(); await pending; };
}
