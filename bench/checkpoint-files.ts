import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestCore } from '../packages/core/test/harness.ts';
import { snapshot, type SnapshotCache } from '../packages/core/src/threads/checkpoint-files.ts';
import { CodeCheckpoints } from '../packages/core/src/threads/code-checkpoints.ts';

// Bounded fixtures; no provider, real project or existing data directory.
// flat: 1000 identical 32 KiB files in one folder. nested: 1000 distinct
// 4 KiB files three folders deep. threads: two threads on the nested folder,
// each with a cold and a warm turn, through the core's own checkpoints, then
// thread 1 again through a new owner, as after a restart.
const harness = await startTestCore();
try {
  const client = await harness.connect();
  const flat = join(harness.dataDir, 'workspace');
  await mkdir(flat);
  const content = Buffer.alloc(32 * 1024, 65);
  for (let i = 0; i < 1000; i++) await writeFile(join(flat, `file-${i}.ts`), content);
  const nested = join(harness.dataDir, 'nested');
  for (let i = 0; i < 1000; i++) {
    const folder = join(nested, `a${i % 10}`, `b${Math.floor(i / 10) % 10}`, `c${Math.floor(i / 100)}`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `file-${i}.ts`), Buffer.alloc(4 * 1024, `file ${i} `));
  }

  const measure = async (root: string, objects: string, cache?: SnapshotCache) => {
    const samples: number[] = [];
    for (let i = 0; i < 4; i++) {
      const start = performance.now();
      await snapshot(harness.core, 'benchmark', root, objects, cache);
      samples.push(Math.round(performance.now() - start));
    }
    return samples;
  };

  // Every stored blob, counted once per inode: hard links share one.
  const stored = async () => {
    const inodes = new Map<string, number>();
    let names = 0;
    const walk = async (folder: string) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) { await walk(path); continue; }
        if (entry.name.endsWith('.json')) continue;
        const info = await lstat(path);
        names += 1;
        inodes.set(`${info.dev}:${info.ino}`, info.size);
      }
    };
    await walk(join(harness.dataDir, 'checkpoints'));
    return { names, blobs: inodes.size, bytes: [...inodes.values()].reduce((sum, size) => sum + size, 0) };
  };

  const project = await client.call('projects.add', { path: nested, name: 'nested' });
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const threads = [];
  for (let i = 0; i < 2; i++) threads.push(await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id }));
  const checkpoints = harness.core.threads.codeCheckpoints;
  const turns: Record<string, number[]> = {};
  for (const [index, thread] of threads.entries()) {
    const summary = harness.core.threads.require(thread.id);
    const samples: number[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const turnId = `trn_bench_${index}_${turn}`;
      let start = performance.now();
      await checkpoints.begin(summary, turnId);
      samples.push(Math.round(performance.now() - start));
      start = performance.now();
      await checkpoints.end(turnId);
      samples.push(Math.round(performance.now() - start));
    }
    turns[`thread${index + 1}Ms`] = samples;
  }
  const restarted = new CodeCheckpoints(harness.core);
  const start = performance.now();
  await restarted.begin(harness.core.threads.require(threads[0]!.id), 'trn_bench_restart');
  turns.restartMs = [Math.round(performance.now() - start)];
  await restarted.end('trn_bench_restart');

  console.log(JSON.stringify({
    flat: { files: 1000, bytes: 1000 * content.length, uncachedMs: await measure(flat, join(harness.dataDir, 'flat-objects')), cachedMs: await measure(flat, join(harness.dataDir, 'flat-objects'), new Map()) },
    nested: { files: 1000, depth: 4, uncachedMs: await measure(nested, join(harness.dataDir, 'nested-objects')), cachedMs: await measure(nested, join(harness.dataDir, 'nested-objects'), new Map()) },
    threads: { ...turns, stored: await stored() },
  }));
  client.close();
} finally { await harness.stop(); }
