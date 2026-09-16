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
      const changed = pauseActivity(saved, 'Core restarted. Resume to continue.');
      this.states.set(thread.id, saved);
      if (changed) this.save(thread.id);
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
        createdId = createdTaskId(part.output);
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
      const signal = this.goalResult(turn);
      if (signal === 'blocked') { state.goal.status = 'paused'; state.goal.error = 'The agent reported a blocker. Read its answer before resuming.'; this.save(turn.threadId); }
      else if (signal === 'complete') { state.goal.status = 'complete'; this.save(turn.threadId); }
    }
    // Let the scheduler release its running slot and clients submit queued user input first.
    this.schedule(turn.threadId, 250);
  }

  private goalResult(turn: Turn): 'complete' | 'blocked' | null {
    let result: 'complete' | null = null;
    for (const message of this.core.journal.walkTurnMessages(turn.threadId, turn.id)) {
      if (message.role !== 'assistant') continue;
      for (const part of message.parts) {
        if (part.type !== 'text') continue;
        const signal = goalSignal(part.text);
        if (signal === 'blocked') return signal;
        if (signal === 'complete') result = signal;
      }
    }
    return result;
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
      ? `Work toward this goal: ${state.goal!.objective}\nContinue until the objective is achieved. When you have verified completion, end your answer with [BOITE_GOAL_COMPLETE] alone on its own line, outside code blocks. If blocked or waiting for user input, explain what is missing and end with [BOITE_GOAL_BLOCKED] alone on its own line, outside code blocks.`
      : state.loop!.prompt;
    try {
      const turn = this.core.threads.startTurn(threadId, prompt);
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
    if (pauseActivity(state, error)) this.save(threadId);
  }

  private save(threadId: string): void {
    const activity = this.get(threadId);
    this.core.journal.append({ type: 'thread.activity', threadId, version: 1, payload: activity }, () => this.core.journal.setSetting(`activity:${threadId}`, activity));
    this.core.bus.emit('thread.activity', { threadId, activity });
  }

  close(): void { this.closed = true; for (const threadId of this.states.keys()) this.pauseAll(threadId); }
}

export function taskStatus(value: unknown): AgentTask['status'] { return value === 'completed' ? 'completed' : value === 'in_progress' || value === 'inProgress' ? 'in_progress' : 'pending'; }

function createdTaskId(text: string | null): string | null {
  try {
    const output = JSON.parse(text ?? 'null');
    const id = output?.task?.id ?? output?.taskId ?? output?.id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  } catch { /* Older agents return a human-readable confirmation. */ }
  return /Task\s+#?(\d+)\s+created/i.exec(text ?? '')?.[1] ?? null;
}

function pauseActivity(state: ThreadActivity, error: string | null): boolean {
  let changed = false;
  for (const item of [state.goal, state.loop]) {
    if (item?.status !== 'active') continue;
    item.status = 'paused';
    item.error = error;
    changed = true;
  }
  if (state.loop && state.loop.nextRunAt !== null) {
    state.loop.nextRunAt = null;
    changed = true;
  }
  return changed;
}

/** Only a final standalone marker outside fenced or indented code is a signal. */
export function goalSignal(text: string): 'complete' | 'blocked' | null {
  let fence: string | null = null;
  let last = '';
  for (const line of text.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && mark[2]!.trim() === '') fence = null;
      if (line.trim()) last = '';
      continue;
    }
    if (mark) { fence = mark[1]!; last = ''; continue; }
    if (line.trim()) last = line;
  }
  if (/^ {0,3}\[BOITE_GOAL_COMPLETE\][ \t]*$/.test(last)) return 'complete';
  if (/^ {0,3}\[BOITE_GOAL_BLOCKED\][ \t]*$/.test(last)) return 'blocked';
  return null;
}
export function normalizeTasks(items: unknown[]): AgentTask[] {
  return items.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const text = row.content ?? row.step ?? row.text;
    return typeof text === 'string' ? [{ id: String(row.id ?? index), text, status: taskStatus(row.status) }] : [];
  });
}
