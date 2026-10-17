/**
 * What a bare command name costs a spawn: the PATH walk Bun repeats on every
 * `Bun.spawn({ cmd: ['git', ...] })`, against the remembered lookup procs uses
 * now. Prints the lookup cost per call and the wall time of short `git --version`
 * spawns started by name and by resolved path.
 *
 *   bun bench/spawn-lookup.ts [spawns=300]
 */
import { resolveSpawnCommand } from '../packages/core/src/spawn-command.ts';

const spawns = Number(process.argv[2] ?? 300);
const env = { ...process.env };
const PATH = env['PATH'] ?? '';
const LOOKUPS = 20_000;

function lookupMicros(fn: () => unknown): number {
  for (let i = 0; i < 1000; i++) fn();
  const start = Bun.nanoseconds();
  for (let i = 0; i < LOOKUPS; i++) fn();
  return (Bun.nanoseconds() - start) / LOOKUPS / 1000;
}

async function spawnMs(cmd: () => string): Promise<number> {
  const start = Bun.nanoseconds();
  for (let i = 0; i < spawns; i++) {
    const proc = Bun.spawn({ cmd: [cmd(), '--version'], env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  }
  return (Bun.nanoseconds() - start) / spawns / 1e6;
}

const walk = lookupMicros(() => Bun.which('git', { PATH }));
const remembered = lookupMicros(() => resolveSpawnCommand('git', env));
const byName = await spawnMs(() => 'git');
const byPath = await spawnMs(() => resolveSpawnCommand('git', env));
console.log(JSON.stringify({ pathEntries: PATH.split(':').length, lookupUs: { walk: +walk.toFixed(2), remembered: +remembered.toFixed(2) }, spawnMs: { byName: +byName.toFixed(3), byPath: +byPath.toFixed(3) } }));
