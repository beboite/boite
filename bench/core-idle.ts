/** Full offline core idle CPU/RSS on a fresh data directory, with no provider process.
 * Run: bun bench/core-idle.ts [seconds=10] [--scope]
 * Waits 4.5 s for startup, then samples each second without forcing GC.
 * --scope keeps one sleeping process registered under a scope with no thread,
 * as a terminal tab does, so the load tick has something live to sample.
 */
import assert from 'node:assert/strict';
import { startTestCore } from '../packages/core/test/harness.ts';

const argument = process.argv.slice(1).find(value => /^\d+$/.test(value));
const seconds = Number(argument ?? 10);
assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 90);
const scoped = process.argv.includes('--scope');
const h = await startTestCore();
// Captured at spawn: only this process is stopped at the end.
const live = scoped ? h.core.procs.spawn('terminal:bench', process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { agentRoot: false }) : null;
try {
  await Bun.sleep(4_500);
  const cpu = process.cpuUsage();
  const started = performance.now();
  let peakRss = 0;
  const samples: number[] = [];
  for (let second = 0; second < seconds; second++) {
    await Bun.sleep(1_000);
    const rss = process.memoryUsage().rss;
    samples.push(rss);
    peakRss = Math.max(peakRss, rss);
  }
  const used = process.cpuUsage(cpu);
  const wallMs = performance.now() - started;
  const cpuMs = (used.user + used.system) / 1000;
  console.log(JSON.stringify({ scenario: 'core-idle', seconds, wallMs, cpuMs, oneCoreCpuPercent: 100 * cpuMs / wallMs,
    medianRssMiB: samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]! / 1024 ** 2,
    sampledPeakRssMiB: peakRss / 1024 ** 2, providerProcesses: 0, liveScopes: live === null ? 0 : 1, platform: process.platform, bun: Bun.version }));
} finally {
  live?.proc.kill('SIGKILL');
  await live?.exited;
  await h.stop();
}
