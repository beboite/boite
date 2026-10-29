import type { Thread } from '@boite/contracts';
import type { FakeContext } from './context.ts';
import { toSummary } from './shared.ts';

/** What a working agent's progress names, turn by turn. */
const PROGRESS = ['bun run test', null, 'Read packages/ui/src/App.svelte', 'rg "loops" packages', null, 'cargo check'];

/**
 * `?fake=1&working=<n>` seeds n more threads whose turn is running, what a
 * machine with many agents at work shows in the sidebar, and samples their
 * load once a second like the core's `LOAD_INTERVAL_MS` while something works,
 * and sends each row once a second with its progress, as the core's
 * `threads/progress.ts` does while a provider keeps talking.
 * The UI's cost of a busy machine is measured on it (`bench/ui-at-rest.ts`).
 * Returns the way to stop the sampler.
 */
export function seedWorking(ctx: FakeContext, count: number): () => void {
  const now = Date.now();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `t-working-${index + 1}`;
    // Started a few seconds to an hour ago, so the rows count different times.
    const startedAt = now - (index * 211_000 + 7_000) % 3_600_000;
    const turnId = `turn-working-${index + 1}`;
    const thread: Thread = {
      id, projectId: index % 3 === 2 ? 'p-notes' : 'p-boite', title: `Working agent ${index + 1}`,
      cwd: 'C:\\src\\boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null,
      permissionMode: 'default', archived: false, pinned: false, branch: null, titleSource: 'prompt',
      messagesBefore: null, commands: [], status: 'running', unread: false, sessionId: `sess-working-${index + 1}`,
      load: { processes: 2, cpuPercent: 3, memoryBytes: 300 * 1024 * 1024 }, context: null,
      createdAt: startedAt, updatedAt: startedAt,
      turns: [{ id: turnId, threadId: id, status: 'running', queuedAt: startedAt, startedAt, finishedAt: null, usage: null, error: null }],
      messages: [
        { id: `m-working-${index + 1}-1`, threadId: id, turnId, role: 'user', parts: [{ type: 'text', text: 'Keep going on the task.' }], state: 'complete', createdAt: startedAt },
        { id: `m-working-${index + 1}-2`, threadId: id, turnId, role: 'assistant', parts: [{ type: 'text', text: 'Working on it.' }], state: 'streaming', createdAt: startedAt },
      ],
    };
    ctx.threads.set(id, thread);
    ids.push(id);
  }
  if (ids.length === 0) return () => undefined;
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    for (const [index, id] of ids.entries()) {
      const thread = ctx.threads.get(id);
      if (!thread || thread.status !== 'running') continue;
      // A share that moves by more than the core's epsilon, so every sample is pushed.
      thread.load = { processes: 2, cpuPercent: 3 + ((tick + index) % 5) * 2, memoryBytes: (300 + ((tick + index) % 7) * 4) * 1024 * 1024 };
      ctx.emit('thread.load', { threadId: id, load: structuredClone(thread.load) });
      const at = Date.now();
      const detail = PROGRESS[(tick + index) % PROGRESS.length] ?? null;
      ctx.emit('thread.updated', { ...toSummary(thread), progress: { turnId: thread.turns[0]!.id, phase: detail === null ? 'thinking' : 'tool', detail, at, since: at, providerAt: at } });
    }
  }, 1000);
  return () => clearInterval(timer);
}

/**
 * `idle: n` seeds n threads at rest, what the sidebar of a machine used for
 * months holds: the list a reconnect would read again whole.
 */
export function seedIdle(ctx: FakeContext, count: number): void {
  const at = Date.now() - 86_400_000;
  for (let index = 0; index < count; index += 1) {
    const id = `t-idle-${index + 1}`;
    ctx.threads.set(id, {
      id, projectId: index % 3 === 2 ? 'p-notes' : 'p-boite', title: `Finished task ${index + 1}, kept in the sidebar`,
      cwd: 'C:\\src\\boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null,
      permissionMode: 'default', archived: false, pinned: false, branch: `boite/task-${index + 1}`, titleSource: 'prompt',
      messagesBefore: null, commands: [], status: 'idle', unread: false, sessionId: `sess-idle-${index + 1}`,
      load: null, context: null, createdAt: at + index, updatedAt: at + index, turns: [], messages: [],
    });
  }
}
