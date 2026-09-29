/** Offline team-update load over the real core and RPC, with eight children per team.
 * Run: bun bench/delegation-load.ts [teams=8] [ticks=16]
 * No provider process or paid turn starts. Every journal lives in a fresh temp directory.
 */
import assert from 'node:assert/strict';
import { DEFAULT_DELEGATION_CONFIG } from '../packages/contracts/src/index.ts';
import { startTestCore, echoThread } from '../packages/core/test/harness.ts';
import { withLoad } from '../packages/core/src/threads/records.ts';

const numbers = process.argv.slice(1).filter(value => /^\d+$/.test(value)).map(Number);
const teams = numbers[0] ?? 8;
const ticks = numbers[1] ?? 16;
assert(Number.isInteger(teams) && teams > 0 && teams <= 16);
assert(Number.isInteger(ticks) && ticks > 0 && ticks <= 64);
const h = await startTestCore();
try {
  const client = await h.connect();
  const children: string[] = [];
  const roots: string[] = [];
  for (let team = 0; team < teams; team++) {
    const { threadId } = await echoThread(h, client, `Team ${team}`);
    roots.push(threadId);
    const parent = h.core.threads.require(threadId);
    const profile = { id: 'worker', name: 'Worker', providerId: 'echo', accountId: parent.accountId, model: parent.model!, effort: null };
    h.core.journal.setSetting(`delegation:${threadId}`, { ...DEFAULT_DELEGATION_CONFIG, enabled: true, paused: true, maxAgents: 8, maxConcurrent: 8, profiles: [profile] });
    for (let worker = 0; worker < 8; worker++) {
      const childId = h.core.delegation.createChild(parent, profile, `Worker ${team}/${worker}`, id => {
        h.core.journal.db.query('INSERT INTO delegated_agents VALUES (?, ?, ?, ?, ?, ?)').run(id, threadId, `worker-${worker}`, 'bench', profile.id, 'Inspect the parser');
      });
      children.push(childId);
    }
  }
  await Bun.sleep(0);
  const selected = roots[0]!;
  await client.call('threads.subscribe', { threadId: selected });
  const jobs: Promise<void>[] = [];
  let notifications = 0;
  let snapshots = 0;
  let wireBytes = 0;
  const off = client.on('delegation.changed', ({ threadId }) => {
    if (threadId !== selected) return;
    notifications++;
    jobs.push(client.call('delegation.get', { threadId: selected }).then(view => {
      assert.equal(view.agents.length, 8);
      snapshots++;
      wireBytes += JSON.stringify(view).length;
    }));
  });
  Bun.gc(true);
  const before = process.memoryUsage();
  let peakRss = before.rss;
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let tick = 0; tick < ticks; tick++) {
    for (const id of children) h.core.bus.emit('thread.updated', { ...withLoad(h.core, h.core.threads.require(id)), load: { processes: 8, cpuPercent: tick + 1, memoryBytes: 100_000_000 + tick } });
    await Bun.sleep(0);
    // The reply follows this tick's events on the same socket, so late notices
    // cannot escape measurement when a fast final tick ends before WS delivery.
    await client.call('scheduler.get', {});
    await Promise.all(jobs.splice(0));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const used = process.cpuUsage(cpu);
  const wallMs = performance.now() - started;
  off();
  console.log(JSON.stringify({ teams, children: children.length, ticks, cpuMs: (used.user + used.system) / 1000, wallMs, notifications, snapshots, wireBytes, rssBeforeMiB: before.rss / 1024 ** 2, sampledPeakRssMiB: peakRss / 1024 ** 2, bun: Bun.version, platform: process.platform }));
} finally { await h.stop(); }
