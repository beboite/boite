import type {
  AgentTask,
  ArtifactContent,
  MemoryEvent,
  MemoryState,
  MemoryStatus,
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
import { untrack } from 'svelte';
import { strings } from '../strings';
import type { FileAnswer } from '../store.svelte';
import type { StoreContext } from './context';

/** A pid alone is reused by the OS, so a trace row is a pid and its start. */
export function sameProcess(a: ProcessRecord, b: ProcessRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * The workbench: the open thread's trace, its working tree, its files, the
 * project's todos and the machine's resources. A paired device reads the
 * working tree and its files (`DEVICE_METHODS`); everything else here, and
 * every write, is owner-only in `packages/core/src/access.ts`, so it is gated
 * on `store.owner` the way `trace.get` is rather than thrown at a phone.
 *
 * The three `files.*` calls answer a `FileAnswer` rather than raising the
 * app's toast: a refused path or a file that vanished under the editor is
 * about the surface that asked, so it reads in that surface.
 */
export class Workbench {
  memory = $state.raw<MemoryStatus | null>(null);
  memoryState = $state<MemoryState | null>(null);
  memoryStopped = $state(false);
  private memoryRevision = 0;
  private memoryRead = 0;

  resetMemory(): void {
    this.memoryRead++;
    this.memoryRevision++;
    this.memory = null;
    this.memoryState = null;
    this.memoryStopped = false;
  }

  memoryEvent(event: MemoryEvent): void {
    this.memoryRevision++;
    this.memoryState = event.state;
    if (event.state === 'ok') this.memoryStopped = false;
    else if (event.kind === 'killed') this.memoryStopped = true;
  }

  async refreshMemory(): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return;
    const read = ++this.memoryRead;
    const revision = this.memoryRevision;
    try {
      const memory = await client.call('resources.memoryStatus', {});
      if (client !== this.ctx.client || read !== this.memoryRead) return;
      this.memory = memory;
      if (revision === this.memoryRevision) {
        this.memoryState = memory.state;
        if (memory.state === 'ok') this.memoryStopped = false;
      }
    } catch (error) {
      if (client === this.ctx.client && read === this.memoryRead) this.ctx.fail(error);
    }
  }

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
  private traceRead = 0;

  constructor(private readonly ctx: StoreContext) {}

  async refreshTrace(): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const open = s.openThread;
    // Owner-only, like the surface it draws.
    if (!client || !open || !s.owner) return;
    const read = ++this.traceRead;
    const navigation = this.ctx.threads.openGeneration;
    const baseline = untrack(() => [...this.trace]);
    const current = () => read === this.traceRead && this.ctx.currentNavigation(client, navigation) && s.openThread?.id === open.id;
    try {
      const snapshot = await client.call('trace.get', { threadId: open.id });
      if (!current()) return;
      const changed = this.trace.filter(record => baseline.find(previous => sameProcess(previous, record)) !== record);
      this.trace = [...changed, ...snapshot.filter(record => !changed.some(newer => sameProcess(newer, record)))];
    } catch (error) {
      if (current()) this.ctx.fail(error);
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
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return null;
    try {
      const result = await client.call('git.status', { threadId });
      return this.ctx.currentClient(client, clientGeneration) ? result : null;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return null;
    }
  }

  async gitDiff(threadId: ThreadId, path: string, ref?: string): Promise<GitDiff | null> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return null;
    try {
      const result = await client.call('git.diff', { threadId, path, ...(ref === undefined ? {} : { ref }) });
      return this.ctx.currentClient(client, clientGeneration) ? result : null;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return null;
    }
  }

  async listFiles(threadId: ThreadId, path?: string): Promise<FileAnswer<FileEntry[]>> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return { ok: false, error: strings.errors.noEndpoint };
    try {
      const value = await client.call('files.list', { threadId, ...(path === undefined ? {} : { path }) });
      if (!this.ctx.currentClient(client, clientGeneration)) return { ok: false, error: strings.errors.noEndpoint };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.ctx.reason(error) };
    }
  }

  async readFile(threadId: ThreadId, path: string): Promise<FileAnswer<FileContent>> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    const s = this.ctx.store;
    if (!client) return { ok: false, error: strings.errors.noEndpoint };
    try {
      const value = await client.call('files.read', { threadId, path });
      if (!this.ctx.currentClient(client, clientGeneration)) return { ok: false, error: strings.errors.noEndpoint };
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

  async readArtifact(threadId: ThreadId, messageId: string, artifactId: string, renew?: string): Promise<FileAnswer<ArtifactContent>> {
    const client = this.ctx.client;
    if (!client) return { ok: false, error: strings.artifacts.failed };
    try {
      const value = await client.call('artifacts.read', { threadId, messageId, artifactId, ...(renew ? { renew } : {}) });
      const endpoint = this.ctx.store.endpointUrl;
      return { ok: true, value: { ...value, url: value.url.startsWith('/') && endpoint ? new URL(value.url, endpoint).href : value.url } };
    } catch (error) { return { ok: false, error: this.ctx.reason(error) }; }
  }

  /** The editor's save. The bytes that reached the disk, or why they did not. */
  async writeFile(
    threadId: ThreadId,
    path: string,
    text: string
  ): Promise<FileAnswer<{ bytes: number; modifiedAt: number }>> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !this.ctx.store.owner) return { ok: false, error: strings.rightPanel.ownerOnly };
    try {
      const value = await client.call('files.write', { threadId, path, text });
      if (!this.ctx.currentClient(client, clientGeneration)) return { ok: false, error: strings.errors.noEndpoint };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.ctx.reason(error) };
    }
  }

  /** The agent's task list, whole. The answer arrives as `thread.activity` too. */
  async setTasks(threadId: ThreadId, tasks: AgentTask[]): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !s.owner) return;
    try {
      const activity = await client.call('threads.tasks.set', { threadId, tasks });
      if (this.ctx.currentClient(client, clientGeneration) && s.openThread?.id === threadId) s.openThread.activity = activity;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async loadTodos(threadId: ThreadId): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !this.ctx.store.owner) return;
    try {
      const project = this.#projectOf(threadId);
      const todos = await client.call('todos.list', { threadId });
      // The list keys on the project, which an empty answer does not carry.
      if (!this.ctx.currentClient(client, clientGeneration)) return;
      const projectId = todos[0]?.projectId ?? project;
      if (projectId === null) return;
      this.todos = { ...this.todos, [projectId]: todos };
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async addTodo(threadId: ThreadId, text: string): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !this.ctx.store.owner || text.trim().length === 0) return;
    try {
      await client.call('todos.add', { threadId, text: text.trim() });
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async updateTodo(
    threadId: ThreadId,
    todoId: string,
    patch: { status?: Todo['status']; text?: string }
  ): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !this.ctx.store.owner) return;
    try {
      await client.call('todos.update', { threadId, todoId, ...patch });
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async removeTodo(threadId: ThreadId, todoId: string): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !this.ctx.store.owner) return;
    try {
      await client.call('todos.remove', { threadId, todoId });
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async refreshResources(): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !this.ctx.store.owner) return;
    try {
      const [resources] = await Promise.all([client.call('resources.list', {}), this.refreshMemory()]);
      if (this.ctx.currentClient(client, clientGeneration)) this.resources = resources;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async killTree(threadId: ThreadId): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return;
    try {
      await client.call('resources.killTree', { threadId });
      if (this.ctx.currentClient(client, clientGeneration)) await this.ctx.store.refreshResources();
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }
}
