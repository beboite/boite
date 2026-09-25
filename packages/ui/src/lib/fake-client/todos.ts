/** The project todo lists every thread of a project shares. */
import { TODO_STATUSES, type Todo } from '@boite/contracts';
import { refusal, todoText } from './shared';
import type { FakeContext, FakeMethods } from './context';

/** The project's cards, the ones already done last, the core's order. */
function projectTodos(ctx: FakeContext, projectId: string | null): Todo[] {
  if (projectId === null) throw refusal('this agent session has no project');
  const rank = (todo: Todo): number => (todo.status === 'done' ? 1 : 0);
  return structuredClone(
    ctx.todos
      .filter((todo) => todo.projectId === projectId)
      .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  );
}

/** A list is shared by the project, so the whole of it travels on every change. */
function emitTodos(ctx: FakeContext, projectId: string): void {
  ctx.emit('todos.updated', { projectId, todos: projectTodos(ctx, projectId) });
}

export function todoMethods(ctx: FakeContext) {
  return {
    'todos.list': async (params) => {
      return projectTodos(ctx, ctx.thread(params.threadId).projectId);
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
      const thread = ctx.thread(params.threadId);
      if (thread.projectId === null) throw refusal('this agent session has no project');
      const todo = ctx.todos.find((one) => one.id === params.todoId && one.projectId === thread.projectId);
      if (!todo) throw ctx.notFound('todo', params.todoId);
      // The status is checked before the text moves, as the core's `updateTodo`
      // builds the whole card before it saves anything.
      if (params.status !== undefined && !TODO_STATUSES.includes(params.status)) {
        throw refusal(`a todo is ${TODO_STATUSES.join(', ')}, not ${String(params.status)}`);
      }
      if (params.text !== undefined) todo.text = todoText(params.text);
      if (params.status !== undefined) todo.status = params.status;
      todo.threadId = thread.id;
      todo.updatedAt = ctx.now();
      emitTodos(ctx, thread.projectId);
      return structuredClone(todo);
    },
    'todos.remove': async (params) => {
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
