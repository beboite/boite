/** The project todo lists every thread of a project shares. */
import { TODO_STATUSES, TODO_TEXT_MAX, type Thread, type Todo, type TodoGoal } from '@boite/contracts';
import { refusal, todoText } from './shared';
import type { FakeContext, FakeMethods } from './context';
import { applySharedBoard, sharedTodos } from './shared-board';
import { invalidShared, refusedShared, sharedScope } from './shared-state';
import { secureId } from '../secure-id';

/** A `/goal2`'s state as its card shows it, as the core reads it on every send. */
function goalOf(thread: Thread | undefined): TodoGoal | null {
  const goal = thread?.activity?.goal;
  if (!goal?.review) return null;
  return { status: goal.status, reviewing: goal.review.phase === 'reviewing', checklist: goal.checklist ?? null };
}

/** The conversation a card still links: one gone or moved to another project no longer counts, as in the core. */
function liveLink(ctx: FakeContext, todo: Todo): string | null {
  const thread = todo.goalThreadId ? ctx.threads.get(todo.goalThreadId) : undefined;
  return thread && thread.projectId === todo.projectId ? thread.id : null;
}

/** The project's cards, the ones already done last, the core's order, each linked one with its goal. */
function projectTodos(ctx: FakeContext, projectId: string | null): Todo[] {
  if (projectId === null) throw refusal('this agent session has no project');
  const rank = (todo: Todo): number => (todo.status === 'done' ? 1 : 0);
  return structuredClone(
    [...ctx.todos, ...sharedTodos(ctx, projectId)]
      .filter((todo) => todo.projectId === projectId)
      .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
      .map((todo) => {
        if (!todo.goalThreadId) return todo;
        const link = liveLink(ctx, todo);
        if (link === null) return { ...todo, goalThreadId: null };
        const goal = goalOf(ctx.threads.get(link));
        return goal ? { ...todo, goal } : todo;
      })
  );
}

/**
 * A linked conversation's goal moved: its board hears it, and a review that
 * passed after the card last moved leaves the open card claimed, as the core does.
 */
export function followGoal(ctx: FakeContext, thread: Thread): void {
  const linked = ctx.todos.filter((todo) => todo.goalThreadId === thread.id);
  if (!linked.length || thread.projectId === null) return;
  const goal = thread.activity?.goal;
  const verdict = goal?.review?.verdicts.at(-1);
  const passedAt = goal?.status === 'complete' && verdict?.verdict === 'pass' ? verdict.finishedAt : null;
  for (const todo of linked) {
    if (passedAt !== null && todo.status === 'open' && todo.updatedAt < passedAt) {
      todo.status = 'claimed';
      todo.threadId = thread.id;
      todo.updatedAt = ctx.now();
    }
  }
  emitTodos(ctx, thread.projectId);
}

/** An automatic goal's card, as the core's `addGoalCard`: the prompt's first line, linked to its conversation. */
export function addGoalCard(ctx: FakeContext, thread: Thread, prompt: string): void {
  const text = prompt.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, TODO_TEXT_MAX);
  if (thread.projectId === null || thread.incognito || !text) return;
  const at = ctx.now();
  ctx.todos.push({ id: `todo-${++ctx.seq}`, projectId: thread.projectId, text, status: 'open', threadId: thread.id, goalThreadId: thread.id, createdAt: at, updatedAt: at });
  emitTodos(ctx, thread.projectId);
}

/** A removed automatic goal: its open cards go back to To do, linked to nothing. */
export function unlinkGoalCards(ctx: FakeContext, thread: Thread): void {
  const linked = ctx.todos.filter((todo) => todo.goalThreadId === thread.id && todo.status === 'open');
  if (!linked.length || thread.projectId === null) return;
  for (const todo of linked) { todo.goalThreadId = null; todo.updatedAt = ctx.now(); }
  emitTodos(ctx, thread.projectId);
}

/** A list is shared by the project, so the whole of it travels on every change. */
function emitTodos(ctx: FakeContext, projectId: string): void {
  ctx.emit('todos.updated', { projectId, todos: projectTodos(ctx, projectId) });
}

export function todoMethods(ctx: FakeContext) {
  return {
    'todos.list': async (params) => {
      const todos=projectTodos(ctx, ctx.thread(params.threadId).projectId);
      return ctx.bus.principal!=='agent'?todos:todos.filter(todo=>{
        if(!todo.shared)return true;
        try{sharedScope(ctx,{threadId:params.threadId,sharedProjectId:todo.shared.sharedProjectId});return true;}catch{return false;}
      });
    },
    'todos.add': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.projectId === null) throw refusal('this agent session has no project');
      const at = ctx.now();
      const todo: Todo = {
        id: `todo-${++ctx.seq}`,
        projectId: thread.projectId,
        text: todoText(params.text),
        status: 'open',
        threadId: thread.id,
        createdAt: at,
        updatedAt: at
      };
      ctx.todos.push(todo);
      emitTodos(ctx, thread.projectId);
      return structuredClone(todo);
    },
    'todos.update': async (params) => {
      if (params.sharedProjectId) {
        const scope = sharedScope(ctx, {...params, sharedProjectId: params.sharedProjectId});
        const current = sharedTodos(ctx, scope.local.projectId).find(t => t.id === params.todoId && t.shared?.sharedProjectId === params.sharedProjectId);
        if (!current) throw refusedShared('todoId: expected a live shared card');
        if (params.goalThreadId !== undefined && (params.text !== undefined || params.status !== undefined && params.status !== 'open')) throw invalidShared('todos.update: link changes are separate from text or status edits');
        const base = {cardId: params.todoId, requestId: secureId()};
        const command = params.goalThreadId ? {...base, kind: 'claim' as const, expectedRevision: current.shared!.card.revision, worker: {project: scope.local, threadId: params.goalThreadId, address: {coreId: scope.local.ownerCoreId, threadId: params.goalThreadId}}}
          : params.goalThreadId === null ? current.shared!.card.assignment ? {...base, kind: 'release' as const, claimId: current.shared!.card.assignment.claimId} : null
          : {...base, kind: 'update' as const, ...(params.text === undefined ? {} : {text: params.text}), ...(params.status === undefined ? {} : {status: params.status})};
        if (!command) return current;
        const result = await applySharedBoard(ctx, {...params, sharedProjectId: params.sharedProjectId, command});
        if (['conflict','deleted','revoked'].includes(result.outcome) || command.kind === 'claim' && result.outcome === 'queued') throw refusedShared('todoId: shared card claim requires an accepted authority reservation');
        return sharedTodos(ctx, scope.local.projectId).find(t => t.id === params.todoId && t.shared?.sharedProjectId === params.sharedProjectId)!;
      }
      const thread = ctx.thread(params.threadId);
      if (thread.projectId === null) throw refusal('this agent session has no project');
      const todo = ctx.todos.find((one) => one.id === params.todoId && one.projectId === thread.projectId);
      if (!todo) throw ctx.notFound('todo', params.todoId);
      // The status is checked before the text moves, as the core's `updateTodo`
      // builds the whole card before it saves anything.
      if (params.status !== undefined && !TODO_STATUSES.includes(params.status)) {
        throw refusal(`a todo is ${TODO_STATUSES.join(', ')}, not ${String(params.status)}`);
      }
      if (params.goalThreadId && ctx.threads.get(params.goalThreadId)?.projectId !== thread.projectId) {
        throw refusal(`goalThreadId ${params.goalThreadId} is not a conversation of this card's project`);
      }
      const linked = liveLink(ctx, todo);
      if (params.goalThreadId && linked !== null && linked !== params.goalThreadId) {
        throw refusal(`todo ${params.todoId} already works in conversation ${linked}; unlink it with goalThreadId null first`);
      }
      if (params.text !== undefined) todo.text = todoText(params.text);
      if (params.status !== undefined) todo.status = params.status;
      if (params.goalThreadId !== undefined) todo.goalThreadId = params.goalThreadId;
      todo.threadId = thread.id;
      todo.updatedAt = ctx.now();
      emitTodos(ctx, thread.projectId);
      return projectTodos(ctx, thread.projectId).find((one) => one.id === todo.id)!;
    },
    'todos.remove': async (params) => {
      if (params.sharedProjectId) {
        await applySharedBoard(ctx, {...params, sharedProjectId: params.sharedProjectId, command: {kind: 'remove', cardId: params.todoId, requestId: secureId()}});
        return {ok: true as const};
      }
      const thread = ctx.thread(params.threadId);
      if (thread.projectId === null) throw refusal('this agent session has no project');
      const index = ctx.todos.findIndex((one) => one.id === params.todoId && one.projectId === thread.projectId);
      if (index < 0) throw ctx.notFound('todo', params.todoId);
      ctx.todos.splice(index, 1);
      emitTodos(ctx, thread.projectId);
      return { ok: true as const };
    },
  } satisfies Partial<FakeMethods>;
}
