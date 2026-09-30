import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestCore } from '../packages/core/test/harness.ts';
import { snapshot, type SnapshotCache } from '../packages/core/src/threads/checkpoint-files.ts';

// A bounded 32 MiB fixture; no provider, real project or existing data directory.
const harness = await startTestCore();
try {
  const root = join(harness.dataDir, 'workspace');
  const objects = join(harness.dataDir, 'checkpoint-objects');
  await mkdir(root);
  const content = Buffer.alloc(32 * 1024, 65);
  for (let i = 0; i < 1000; i++) await writeFile(join(root, `file-${i}.ts`), content);
  const measure = async (cache?: SnapshotCache) => {
    const samples: number[] = [];
    for (let i = 0; i < 4; i++) {
      const start = performance.now();
      await snapshot(harness.core, 'benchmark', root, objects, cache);
      samples.push(Math.round(performance.now() - start));
    }
    return samples;
  };
  console.log(JSON.stringify({ files: 1000, bytes: 1000 * content.length, uncachedMs: await measure(), cachedMs: await measure(new Map()) }));
} finally { await harness.stop(); }
