import type { AgentTask, MessagePart, RpcParams, ThreadActivity, Turn } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';

const empty = (): ThreadActivity => ({ goal: null, loop: null, tasks: [] });

/** Activity survives reconnects; a restarted core requires an explicit resume. */
export class ActivityStore {
  private readonly states = new Map<string, ThreadActivity>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ownTurns = new Map<string, { kind: 'goal' | 'loop'; generation: number }>();
  private readonly generations = new Map<string, number>();
  private closed = false;

  constructor(private readonly core: Core) {
    for (const thread of core.journal.listThreads()) {
      const saved = core.journal.getSetting(`activity:${thread.id}`) as ThreadActivity | undefined;
      if (!saved) continue;
      for (const kind of ['goal', 'loop'] as const) {
        const item = saved[kind];
        if (item?.status === 'active') { item.status = 'paused'; item.error = 'Core restarted. Resume to continue.'; }
      }
      if (saved.loop) saved.loop.nextRunAt = null;
      this.states.set(thread.id, saved);
      this.save(thread.id);
    }
    core.bus.onAny((name, payload) => {
      if (this.closed) return;
      if (name === 'turn.finished') this.finished(payload as Turn);
      if (name === 'message.part') {
        const event = payload as { threadId: string; part: MessagePart };
        this.observeTool(event.threadId, event.part);
      }
      if (name === 'thread.updated') {
        const thread = payload as { id: string; archived: boolean };
        if (thread.archived) this.pauseAll(thread.id);
      }
      if (name === 'thread.removed') {
        const { threadId } = payload as { threadId: string };
        this.clearTimer(threadId);
        this.states.delete(threadId);
        core.journal.setSetting(`activity:${threadId}`, null);
      }
    });
  }

  get(threadId: string): ThreadActivity { return structuredClone(this.states.get(threadId) ?? empty()); }

  set(params: RpcParams<'threads.activity.set'>): ThreadActivity {
    const thread = this.core.journal.getThread(params.threadId);
    if (!thread || thread.archived) throw refused('activity requires an existing, unarchived thread');
    const state = this.get(params.threadId);
    if (params.goal !== undefined) {
      if (params.goal !== null && (typeof params.goal.objective !== 'string' || !params.goal.objective.trim())) throw invalidParams('goal.objective must be non-empty text');
      state.goal = params.goal === null ? null : { objective: params.goal.objective.trim(), status: 'active', iterations: 0, error: null };
    }
    if (params.loop !== undefined) {
      if (params.loop !== null && (typeof params.loop.prompt !== 'string' || !params.loop.prompt.trim() || !Number.isInteger(params.loop.intervalMs) || params.loop.intervalMs < 1000 || params.loop.intervalMs > 86_400_000)) throw invalidParams('loop.prompt must be non-empty; loop.intervalMs must be an integer from 1000 to 86400000');
      state.loop = params.loop === null ? null : { prompt: params.loop.prompt.trim(), intervalMs: params.loop.intervalMs, status: 'active', iterations: 0, nextRunAt: Date.now(), error: null };
    }
    if (params.goal !== undefined) this.generations.set(params.threadId, (this.generations.get(params.threadId) ?? 0) + 1);
    this.states.set(params.threadId, state);
    this.save(params.threadId);
    this.schedule(params.threadId, 0);
    return this.get(params.threadId);
  }

  control(params: RpcParams<'threads.activity.control'>): ThreadActivity {
    if (!['goal', 'loop'].includes(params.kind) || !['pause', 'resume', 'remove', 'complete'].includes(params.action)) throw invalidParams('activity kind or action is invalid');
    const thread = this.core.journal.getThread(params.threadId);
    if (!thread) throw refused('activity requires an existing thread');
    if (params.action === 'resume' && thread.archived) throw refused('cannot resume activity on an archived thread');
    const state = this.get(params.threadId);
    const item = state[params.kind];
    if (!item) throw refused(`this thread has no ${params.kind}`);
    if (params.action === 'complete' && params.kind !== 'goal') throw invalidParams('only a goal can be completed');
    if (params.action === 'remove') state[params.kind] = null;
    else if (params.action === 'complete' && state.goal) state.goal.status = 'complete';
    else { item.status = params.action === 'resume' ? 'active' : 'paused'; item.error = null; }
    if (state.loop && state.loop.status !== 'active') state.loop.nextRunAt = null;
    if (params.kind === 'loop' && params.action === 'resume' && state.loop) state.loop.nextRunAt = Date.now();
    this.states.set(params.threadId, state);
    this.save(params.threadId);
    this.schedule(params.threadId, 0);
    return this.get(params.threadId);
  }

  tasks(threadId: string, tasks: AgentTask[]): void {
    const state = this.get(threadId);
    state.tasks = tasks;
    this.states.set(threadId, state);
    this.save(threadId);
  }

  private observeTool(threadId: string, part: MessagePart): void {
    if (part.type !== 'tool' || part.status !== 'done' || !part.input || typeof part.input !== 'object') return;
    const input = part.input as Record<string, unknown>;
    if (/^(?:TodoWrite|write_todos|update_plan|functions[.]update_plan)$/i.test(part.name)) {
      const items = input.todos ?? input.plan;
      if (Array.isArray(items)) this.tasks(threadId, normalizeTasks(items));
    }
    if (/^(?:TaskCreate|TaskUpdate)$/i.test(part.name)) {
      const state = this.get(threadId);
      let createdId: string | null = null;
      if (part.name.toLowerCase() === 'taskcreate') {
        try {
          const output = JSON.parse(part.output ?? 'null');
          const id = output?.task?.id ?? output?.taskId ?? output?.id;
          if (typeof id === 'string' || typeof id === 'number') createdId = String(id);
        } catch { /* Some Claude versions return a human-readable result. */ }
        createdId ??= /Task\s+#?(\d+)\s+created/i.exec(part.output ?? '')?.[1] ?? null;
        if (!createdId) return;
      }
      const id = String(input.taskId ?? createdId);
      const old = state.tasks.find((task) => task.id === id);
      const text = typeof input.subject === 'string' ? input.subject : old?.text;
      if (!text) return;
      const task = { id, text, status: taskStatus(input.status ?? old?.status) };
      state.tasks = [...state.tasks.filter((entry) => entry.id !== id), task];
      this.tasks(threadId, state.tasks);
    }
  }

  private finished(turn: Turn): void {
    const owned = this.ownTurns.get(turn.id);
    this.ownTurns.delete(turn.id);
    if (turn.status !== 'done') { this.pauseAll(turn.threadId, turn.error ?? 'Turn stopped. Resume to continue.'); return; }
    const state = this.states.get(turn.threadId);
    if (!state) return;
    if (owned?.kind === 'goal' && owned.generation === (this.generations.get(turn.threadId) ?? 0) && state.goal?.status === 'active') {
      const messages = this.core.threads.get(turn.threadId).messages;
      const completed = messages.some((message) => message.turnId === turn.id && message.role === 'assistant' && message.parts.some((part) => part.type === 'text' && /^\s*\[BOITE_GOAL_COMPLETE\]\s*$/m.test(part.text)));
      const blocked = messages.some((message) => message.turnId === turn.id && message.role === 'assistant' && message.parts.some((part) => part.type === 'text' && /^\s*\[BOITE_GOAL_BLOCKED\]\s*$/m.test(part.text)));
      if (blocked) { state.goal.status = 'paused'; state.goal.error = 'The agent reported a blocker. Read its answer before resuming.'; this.save(turn.threadId); }
      else if (completed) { state.goal.status = 'complete'; this.save(turn.threadId); }
    }
    // Let the scheduler release its running slot and clients submit queued user input first.
    this.schedule(turn.threadId, 250);
  }

  private run(threadId: string): void {
    if (this.closed) return;
    const thread = this.core.journal.getThread(threadId);
    const state = this.states.get(threadId);
    if (!thread || !state || thread.archived) return;
    if (['running', 'queued', 'waiting'].includes(thread.status)) return;
    const kind = state.loop?.status === 'active' && (state.loop.nextRunAt ?? 0) <= Date.now() ? 'loop' : state.goal?.status === 'active' ? 'goal' : null;
    if (!kind) {
      if (state.loop?.status === 'active') this.schedule(threadId, Math.max(0, (state.loop.nextRunAt ?? Date.now()) - Date.now()));
      return;
    }
    const prompt = kind === 'goal'
      ? `Work toward this goal: ${state.goal!.objective}\nContinue until the objective is achieved. When you have verified completion, write [BOITE_GOAL_COMPLETE] alone on its own line. If blocked or waiting for user input, explain what is missing and write [BOITE_GOAL_BLOCKED] alone on its own line.`
      : state.loop!.prompt;
    try {
      const turn = this.core.threads.startTurn(threadId, prompt, [], undefined, undefined, kind === 'goal' ? `/goal ${state.goal!.objective}` : `/loop ${state.loop!.intervalMs / 1000}s ${state.loop!.prompt}`);
      this.ownTurns.set(turn.id, { kind, generation: this.generations.get(threadId) ?? 0 });
      // Drivers may synchronously report tasks while startTurn runs.
      const current = this.states.get(threadId)!;
      current[kind]!.iterations++;
      if (kind === 'loop') current.loop!.nextRunAt = Date.now() + current.loop!.intervalMs;
      this.save(threadId);
    } catch (error) { this.pauseAll(threadId, error instanceof Error ? error.message : String(error)); }
  }

  private schedule(threadId: string, delay: number): void {
    this.clearTimer(threadId);
    if (this.closed) return;
    const state = this.states.get(threadId);
    if (state?.goal?.status !== 'active' && state?.loop?.status !== 'active') return;
    this.timers.set(threadId, setTimeout(() => { this.timers.delete(threadId); this.run(threadId); }, delay));
  }

  private clearTimer(threadId: string): void { const timer = this.timers.get(threadId); if (timer) clearTimeout(timer); this.timers.delete(threadId); }

  pauseAll(threadId: string, error: string | null = null): void {
    const state = this.states.get(threadId);
    if (!state) return;
    this.clearTimer(threadId);
    for (const kind of ['goal', 'loop'] as const) { const item = state[kind]; if (item?.status === 'active') { item.status = 'paused'; item.error = error; } }
    if (state.loop) state.loop.nextRunAt = null;
    this.save(threadId);
  }

  private save(threadId: string): void {
    const activity = this.get(threadId);
    this.core.journal.append({ type: 'thread.activity', threadId, version: 1, payload: activity }, () => this.core.journal.setSetting(`activity:${threadId}`, activity));
    this.core.bus.emit('thread.activity', { threadId, activity });
  }

  close(): void { this.closed = true; for (const threadId of this.states.keys()) this.pauseAll(threadId); }
}

export function taskStatus(value: unknown): AgentTask['status'] { return value === 'completed' ? 'completed' : value === 'in_progress' || value === 'inProgress' ? 'in_progress' : 'pending'; }
export function normalizeTasks(items: unknown[]): AgentTask[] {
  return items.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const text = row.content ?? row.step ?? row.text;
    return typeof text === 'string' ? [{ id: String(row.id ?? index), text, status: taskStatus(row.status) }] : [];
  });
}
