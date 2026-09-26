import type {
  AgentTask,
  FileContent,
  FileEntry,
  GitDiff,
  GitStatus,
  ProcessRecord,
  ProjectId,
  ThreadId,
  ThreadResources,
  Todo
} from '@boite/contracts';
import { strings } from '../strings';
import type { FileAnswer } from '../store.svelte';
import type { StoreContext } from './context';

/** A pid alone is reused by the OS, so a trace row is a pid and its start. */
export function sameProcess(a: ProcessRecord, b: ProcessRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * The workbench: the open thread's trace, its working tree, its files, the
 * project's todos and the machine's resources. Every one of these is
 * owner-only in `packages/core/src/access.ts`, so each is gated on
 * `store.owner` the way `trace.get` is rather than thrown at a phone.
 *
 * The three `files.*` calls answer a `FileAnswer` rather than raising the
 * app's toast: a refused path or a file that vanished under the editor is
 * about the surface that asked, so it reads in that surface.
 */
export class Workbench {
  resources = $state<ThreadResources[]>([]);
  trace = $state<ProcessRecord[]>([]);
  /**
   * The todo cards of each project, keyed by project id: the list is the
   * project's, so every thread of it shows the same one.
   */
  todos = $state<Record<ProjectId, Todo[]>>({});
  /** The thread `trace` belongs to, and whether the trace surface is on screen to read it. */
  tracedThreadId: ThreadId | null = null;
  traceWatched = false;

  constructor(private readonly ctx: StoreContext) {}

  async refreshTrace(): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const open = s.openThread;
    // Owner-only, like the surface it draws.
    if (!client || !open || !s.owner) return;
    try {
      this.trace = await client.call('trace.get', { threadId: open.id });
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  /** The project of a thread, open or not: what keys the todo list. */
  #projectOf(threadId: ThreadId): ProjectId | null {
    const s = this.ctx.store;
    if (s.openThread?.id === threadId) return s.openThread.projectId;
    return s.threads.find((thread) => thread.id === threadId)?.projectId ?? null;
  }

  async gitStatus(threadId: ThreadId): Promise<GitStatus | null> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return null;
    try {
      return await client.call('git.status', { threadId });
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  async gitDiff(threadId: ThreadId, path: string, ref?: string): Promise<GitDiff | null> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return null;
    try {
      return await client.call('git.diff', { threadId, path, ...(ref === undefined ? {} : { ref }) });
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  async listFiles(threadId: ThreadId, path?: string): Promise<FileAnswer<FileEntry[]>> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return { ok: false, error: strings.rightPanel.ownerOnly };
    try {
      const value = await client.call('files.list', { threadId, ...(path === undefined ? {} : { path }) });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.ctx.reason(error) };
    }
  }

  async readFile(threadId: ThreadId, path: string): Promise<FileAnswer<FileContent>> {
    const client = this.ctx.client;
    const s = this.ctx.store;
    if (!client || !s.owner) return { ok: false, error: strings.rightPanel.ownerOnly };
    try {
      const value = await client.call('files.read', { threadId, path });
      // The core answers a path on its own HTTP server: the origin is the one
      // this client reached it by, which a core cannot know from where it runs.
      if (value.kind !== 'text' && value.url.startsWith('/') && s.endpointUrl !== null) {
        return { ok: true, value: { ...value, url: new URL(value.url, s.endpointUrl).href } };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.ctx.reason(error) };
    }
  }

  /** The editor's save. The bytes that reached the disk, or why they did not. */
  async writeFile(
    threadId: ThreadId,
    path: string,
    text: string
  ): Promise<FileAnswer<{ bytes: number; modifiedAt: number }>> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return { ok: false, error: strings.rightPanel.ownerOnly };
    try {
      const value = await client.call('files.write', { threadId, path, text });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.ctx.reason(error) };
    }
  }

  /** The agent's task list, whole. The answer arrives as `thread.activity` too. */
  async setTasks(threadId: ThreadId, tasks: AgentTask[]): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || !s.owner) return;
    try {
      const activity = await client.call('threads.tasks.set', { threadId, tasks });
      if (s.openThread?.id === threadId) s.openThread.activity = activity;
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async loadTodos(threadId: ThreadId): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return;
    try {
      const todos = await client.call('todos.list', { threadId });
      // The list keys on the project, which an empty answer does not carry.
      const projectId = todos[0]?.projectId ?? this.#projectOf(threadId);
      if (projectId === null) return;
      this.todos = { ...this.todos, [projectId]: todos };
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async addTodo(threadId: ThreadId, text: string): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner || text.trim().length === 0) return;
    try {
      await client.call('todos.add', { threadId, text: text.trim() });
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async updateTodo(
    threadId: ThreadId,
    todoId: string,
    patch: { status?: Todo['status']; text?: string }
  ): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return;
    try {
      await client.call('todos.update', { threadId, todoId, ...patch });
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async removeTodo(threadId: ThreadId, todoId: string): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return;
    try {
      await client.call('todos.remove', { threadId, todoId });
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async refreshResources(): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      this.resources = await client.call('resources.list', {});
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async killTree(threadId: ThreadId): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('resources.killTree', { threadId });
      await this.ctx.store.refreshResources();
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
