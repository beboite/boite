/**
 * What listing the providers costs: `ProviderRegistry.list()`, `summary('pi')`
 * and `summary('opencode')`, each timed over 500 calls after a warm-up, with a
 * fresh temporary data directory and the machine's own PATH. `LOOPS=1000`
 * changes the count; `ONLY=1` skips the timing lines, for `strace -c`.
 *
 * Run: bun bench/provider-list.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/core/src/providers/loader.ts';

const loops = Number(process.env['LOOPS'] ?? 500);
const dataDir = mkdtempSync(join(tmpdir(), 'boite-provider-list-'));
process.env['BOITE_DATA_DIR'] = dataDir;
try {
  const registry = new ProviderRegistry(dataDir);
  registry.load();
  const time = (label: string, run: () => unknown): void => {
    for (let i = 0; i < 20; i += 1) run();
    const start = Bun.nanoseconds();
    for (let i = 0; i < loops; i += 1) run();
    const us = (Bun.nanoseconds() - start) / 1000 / loops;
    if (process.env['ONLY'] !== '1') console.log(`${label} ${us.toFixed(1)} us`);
  };
  time('list()', () => registry.list());
  time("summary('pi')", () => registry.summary('pi'));
  time("summary('opencode')", () => registry.summary('opencode'));
  registry.close();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
