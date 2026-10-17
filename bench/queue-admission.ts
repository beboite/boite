/**
 * Scheduler admission over held turns, on a temporary core: `teams` enabled
 * teams share `held` children, each with one queued echo turn held by an
 * account login hold, then 20 `scheduler.retry()` pumps are timed. Every
 * finished turn anywhere repumps the queue the same way.
 * Run: bun run bench/queue-admission.ts [held=1024] [teams=16]
 * No provider process starts: the hold keeps every turn queued.
 */
import assert from 'node:assert/strict';
import { DEFAULT_DELEGATION_CONFIG } from '../packages/contracts/src/index.ts';
import { echoThread, holdAccountTurns, startTestCore } from '../packages/core/test/harness.ts';

const arg = (at: number, fallback: number): number => Number(process.argv[2 + at] ?? fallback);
const held = arg(0, 1024), teams = arg(1, 16);
assert(Number.isInteger(held) && held > 0 && Number.isInteger(teams) && teams > 0 && held % teams === 0);
const h = await startTestCore();
try {
  const client = await h.connect();
  const children: string[] = [];
  for (let team = 0; team < teams; team++) {
    const { threadId } = await echoThread(h, client, `Team ${team}`);
    const parent = h.core.threads.require(threadId);
    const profile = { id: 'worker', name: 'Worker', providerId: 'echo', accountId: parent.accountId, model: parent.model!, effort: null };
    h.core.journal.setSetting(`delegation:${threadId}`, { ...DEFAULT_DELEGATION_CONFIG, enabled: true, paused: false, profiles: [profile] });
    for (let worker = 0; worker < held / teams; worker++) {
      children.push(h.core.delegation.createChild(parent, profile, `Worker ${team}/${worker}`, id => {
        h.core.journal.db.query('INSERT INTO delegated_agents VALUES (?, ?, ?, ?, ?, ?)').run(id, threadId, `worker-${worker}`, 'bench', profile.id, 'Inspect the parser');
      }));
    }
  }
  holdAccountTurns(h);
  for (const id of children) h.core.threads.startTurn(id, '[sleep:60000]');
  await Bun.sleep(0);
  assert.equal(h.core.scheduler.state().queued.length, held);
  for (let warm = 0; warm < 3; warm++) h.core.scheduler.retry();
  Bun.gc(true);
  const samples: number[] = [];
  for (let pump = 0; pump < 20; pump++) {
    const start = performance.now();
    h.core.scheduler.retry();
    samples.push(performance.now() - start);
  }
  assert.equal(h.core.scheduler.state().queued.length, held);
  const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  console.log(JSON.stringify({ held, teams, pumps: samples.length, medianMs: Number(median.toFixed(3)), maxMs: Number(Math.max(...samples).toFixed(3)), bun: Bun.version }));
} finally { await h.stop(); }
