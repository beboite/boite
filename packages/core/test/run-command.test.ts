import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import type { Core } from '../src/core.ts';
import { runCli } from '../src/tailscale.ts';

/*
 * A command that starts a helper and exits: the helper inherits both pipes and
 * keeps them open. Stopping the command's own pid, the only thing a raw
 * `proc.kill()` reaches, leaves the helper and a collector waiting forever.
 */
let harness: TestCore;
const strays: number[] = [];

beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => {
  for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await harness.stop();
});

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test.skipIf(process.platform === 'win32')('a stop reaches what a process started after the process itself exited', async () => {
  const spawned = harness.core.procs.spawn('stop-after-exit', 'sh', ['-c', 'sleep 30 & echo $!']);
  const { value } = await spawned.proc.stdout.getReader().read();
  const helper = Number(new TextDecoder().decode(value).trim());
  strays.push(helper);
  await spawned.exited;
  // The registry let go of the exited process: its scope stops nothing now.
  expect(harness.core.procs.liveCount('stop-after-exit')).toBe(0);
  expect(running(helper)).toBe(true);
  await spawned.stop();
  await waitFor(() => !running(helper), 5000);
}, 15000);

test.skipIf(process.platform === 'win32')('a command whose helper holds its pipes ends at its deadline, with the helper stopped and the scope\'s other command left running', async () => {
  const marker = join(harness.dataDir, 'helper.pid');
  const sibling = harness.core.procs.spawn('system:tailscale', 'sleep', ['30'], { agentRoot: false });
  strays.push(sibling.proc.pid);
  const started = Date.now();
  const run = await runCli(harness.core as unknown as Core, ['sh'], ['-c', `sleep 30 & echo $! > ${marker}; echo partial`], 300);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(run).toMatchObject({ code: 0, stdout: 'partial\n', timedOut: true });
  expect(existsSync(marker)).toBe(true);
  const helper = Number(readFileSync(marker, 'utf8').trim());
  strays.push(helper);
  await waitFor(() => !running(helper), 5000);
  expect(running(sibling.proc.pid)).toBe(true);
  await sibling.stop();
}, 15000);
