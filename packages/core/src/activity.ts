import type { AgentTask, MessagePart, RpcParams, ThreadActivity, Turn } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import { activityResult } from './activity-prompt.ts';

const empty = (): ThreadActivity => ({ goal: null, loop: null, tasks: [] });

/** Activity survives reconnects; a restarted core requires an explicit resume. */
export class ActivityStore {
  private readonly states = new Map<string, ThreadActivity>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ownTurns = new Map<string, { kind: 'goal' | 'loop'; generation: number; iteration: number }>();
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
      for (const run of saved.loop?.history ?? []) {
        if (run.status === 'running') { run.status = 'error'; run.summary = 'Core restarted before this iteration finished.'; run.finishedAt = Date.now(); }
      }
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
      if (params.loop !== null) validateLoop(params.loop);
      state.loop = params.loop === null ? null : { prompt: params.loop.prompt.trim(), intervalMs: params.loop.intervalMs, maxIterations: params.loop.maxIterations ?? null, status: 'active', iterations: 0, nextRunAt: Date.now(), error: null, history: [] };
    }
    for (const kind of ['goal', 'loop'] as const) if (params[kind] !== undefined) {
      const key = `${params.threadId}:${kind}`;
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
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
    if (params.action === 'resume' && params.kind === 'loop' && state.loop?.maxIterations && state.loop.iterations >= state.loop.maxIterations) throw refused('this loop has finished all its iterations; start a new loop');
    if (params.action === 'complete' && params.kind !== 'goal') throw invalidParams('only a goal can be completed');
    if (params.action === 'remove') state[params.kind] = null;
    else if (params.action === 'complete' && state.goal) state.goal.status = 'complete';
    else { item.status = params.action === 'resume' ? 'active' : 'paused'; item.error = null; if (params.kind === 'goal' && state.goal) state.goal.dismissed = false; }
    if (state.loop && state.loop.status !== 'active') state.loop.nextRunAt = null;
    if (params.kind === 'loop' && params.action === 'resume' && state.loop) state.loop.nextRunAt = Date.now();
    this.states.set(params.threadId, state);
    this.save(params.threadId);
    this.schedule(params.threadId, 0);
    return this.get(params.threadId);
  }

  tasks(threadId: string, tasks: AgentTask[]): void {
    const state = this.get(threadId);
    if (tasks.some(task => task.status !== 'completed' || !state.tasks.some(old => old.id === task.id && old.text === task.text))) state.tasksDismissed = false;
    state.tasks = tasks;
    this.states.set(threadId, state);
    this.save(threadId);
  }

  /** A new user request retires the finished overlay without deleting its history. */
  userPrompt(threadId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    let changed = false;
    if (state.tasks.length && state.tasks.every(task => task.status === 'completed') && !state.tasksDismissed) { state.tasksDismissed = true; changed = true; }
    if (state.goal?.status === 'complete' && !state.goal.dismissed) { state.goal.dismissed = true; changed = true; }
    if (changed) this.save(threadId);
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
    const state = this.states.get(turn.threadId);
    const current = owned && owned.generation === (this.generations.get(`${turn.threadId}:${owned.kind}`) ?? 0);
    if (current && owned.kind === 'loop' && state?.loop) {
      const run = state.loop.history?.find(run => run.turnId === turn.id);
      if (run) {
        run.status = turn.status === 'done' ? 'done' : turn.status === 'stopped' ? 'stopped' : 'error';
        run.finishedAt = turn.finishedAt ?? Date.now();
        run.summary = activityResult(this.core.journal.listMessages(turn.threadId).filter(message => message.turnId === turn.id && message.role === 'assistant').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n')).slice(0, 4000) || turn.error || '';
      }
      if (turn.status === 'done' && state.loop.maxIterations && state.loop.iterations >= state.loop.maxIterations) { state.loop.status = 'complete'; state.loop.nextRunAt = null; }
      else if (state.loop.status === 'active') state.loop.nextRunAt = Date.now() + state.loop.intervalMs;
      this.save(turn.threadId);
    }
    if (turn.status !== 'done' && (!owned || current)) { this.pauseAll(turn.threadId, turn.error ?? 'Turn stopped. Resume to continue.'); return; }
    if (!state) return;
    if (owned?.kind === 'goal' && current && state.goal?.status === 'active') {
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
    const prompt = `/${kind} ${kind === 'goal' ? state.goal!.objective : state.loop!.prompt}`;
    const iteration = state[kind]!.iterations + 1;
    try {
      const turn = this.core.threads.startTurn(threadId, prompt, [], undefined, undefined, { kind, iteration });
      this.ownTurns.set(turn.id, { kind, generation: this.generations.get(`${threadId}:${kind}`) ?? 0, iteration });
      // Drivers may synchronously report tasks while startTurn runs.
      const current = this.states.get(threadId)!;
      current[kind]!.iterations++;
      if (kind === 'loop') {
        current.loop!.nextRunAt = null;
        current.loop!.history = [...(current.loop!.history ?? []), { iteration, turnId: turn.id, status: 'running' as const, summary: '', startedAt: Date.now(), finishedAt: null }].slice(-50);
      }
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

export function validateLoop(loop: NonNullable<RpcParams<'threads.activity.set'>['loop']>): void {
  if (typeof loop.prompt !== 'string' || !loop.prompt.trim()) throw invalidParams('loop.prompt must be non-empty text');
  if (loop.maxIterations != null && (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1 || loop.maxIterations > 1000)) throw invalidParams('loop.maxIterations must be an integer from 1 to 1000');
  if (!Number.isInteger(loop.intervalMs) || loop.intervalMs > 86_400_000 || (loop.intervalMs !== 0 && loop.intervalMs < 1000) || (loop.intervalMs === 0 && !loop.maxIterations)) throw invalidParams('loop.intervalMs must be from 1000 to 86400000, or 0 with maxIterations');
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
