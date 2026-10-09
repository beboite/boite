/**
 * What the companion's HUD is looked at on, with `?fake=1&hud=1`: a Douane
 * configured as the subscription proxy, so its quotas come, and three threads
 * at work whose turns started minutes ago rather than on the seed's fixed date,
 * one of them running a tool.
 */
import type { Thread } from '@boite/contracts';
import type { FakeContext } from './context';

const MINUTE = 60_000;

/** Moves a seeded thread's turns so its request started `ago` milliseconds before now. */
function startedAgo(thread: Thread | undefined, ago: number, now: number): void {
  if (!thread) return;
  const shift = now - ago - Math.min(...thread.turns.map((turn) => turn.queuedAt));
  for (const turn of thread.turns) {
    turn.queuedAt += shift;
    if (turn.startedAt !== null) turn.startedAt += shift;
    if (turn.finishedAt !== null) turn.finishedAt += shift;
  }
}

export function seedHudDemo(ctx: FakeContext): void {
  const now = Date.now();
  ctx.settings.subscriptionProxy = {
    enabled: true,
    kind: 'douane',
    baseUrl: 'http://douane.lan:8787/v1',
    dashboardUrl: 'http://douane.lan:8787/admin/#quotas'
  };
  startedAgo(ctx.threads.get('t-scheduler'), 41 * MINUTE + 7_000, now);
  startedAgo(ctx.threads.get('t-bench'), 6 * MINUTE + 30_000, now);

  const model = ctx.threads.get('t-scheduler');
  if (!model) return;
  const started = now - 2 * MINUTE - 14_000;
  const turnId = 'turn-hud-1';
  const thread: Thread = {
    ...structuredClone(model),
    id: 't-hud-tests',
    projectId: 'p-notes',
    title: 'Run the test suite after the merge',
    cwd: 'C:\\src\\notes',
    branch: null,
    status: 'running',
    sessionId: 'sess-hud-tests',
    load: null,
    context: null,
    createdAt: started - 1_000,
    updatedAt: started,
    turns: [{ id: turnId, threadId: 't-hud-tests', status: 'running', queuedAt: started - 500, startedAt: started, finishedAt: null, usage: null, error: null }],
    messages: [{
      id: 'm-hud-1',
      threadId: 't-hud-tests',
      turnId,
      role: 'user',
      parts: [{ type: 'text', text: 'Run the whole suite and tell me what broke.' }],
      state: 'complete',
      createdAt: started - 500
    }],
    progress: { turnId, phase: 'tool', detail: 'bun run test', at: now - 5_000, providerAt: now - 5_000 }
  };
  ctx.threads.set(thread.id, thread);
  ctx.scheduler.running.push({ turnId, threadId: thread.id, startedAt: started });
}
