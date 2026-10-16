/**
 * What a trivial RPC costs on loopback when each call waits for the one before,
 * as a UI chain does (open, then page, then attachment).
 * Run: bun bench/rpc-serial.ts [--calls 300] [--method settings.get]
 *
 * Starts a core in a temporary data directory, warms the socket with 20 calls,
 * then times `--calls` sequential round trips and prints the median and p95 of
 * one call and the total, in milliseconds.
 */
import { startTestCore } from '../packages/core/test/harness';

const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1]!;
};
const calls = Number(option('calls', '300'));
const method = option('method', 'settings.get') as 'settings.get';
if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('expected --calls >= 1');

const harness = await startTestCore();
try {
  const client = await harness.connect();
  for (let index = 0; index < 20; index++) await client.call(method, {});
  const times: number[] = [];
  const started = performance.now();
  for (let index = 0; index < calls; index++) {
    const at = performance.now();
    await client.call(method, {});
    times.push(performance.now() - at);
  }
  const total = performance.now() - started;
  times.sort((a, b) => a - b);
  const median = times.length % 2 ? times[(times.length - 1) / 2]! : (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2;
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]!;
  console.log(JSON.stringify({ method, calls, medianMs: Number(median.toFixed(3)), p95Ms: Number(p95.toFixed(3)), totalMs: Number(total.toFixed(1)) }));
  client.close();
} finally {
  await harness.stop();
}
