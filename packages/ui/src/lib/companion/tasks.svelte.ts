/*
 * The threads the companion launches for `[[task: …]]` lines. Asking before
 * acting, each waits on a card until the user launches or cancels it; acting
 * without asking, it goes at once. A launched thread gets a card that opens it
 * in the main window, and its end comes as any thread's does (`notes.svelte.ts`).
 */
import type { Project, ThreadSummary } from '@boite/contracts';
import type { Client } from '../client';
import { titleFrom } from '../format';
import { readModelDefaults } from '../model-defaults';
import { readPrefs } from '../prefs';
import { fill, strings } from '../strings';
import type { TaskDirective } from './directives';
import type { CompanionControl } from './prefs';
import { newThreadChoice, resolveProject, taskProjects } from './tasks';

/** A task waiting for the user's word. */
export interface PendingTask {
  id: string;
  projectId: string;
  project: string;
  prompt: string;
  worktree: boolean;
}

/** A thread the companion launched. */
export interface LaunchedTask {
  threadId: string;
  project: string;
  title: string;
}

export interface TasksHost {
  client(): Client | null;
  control(): CompanionControl;
  /** A thread the companion made, for the list the page follows. */
  created(thread: ThreadSummary): void;
  /** A line of the companion's own in the bubble: a project it does not know, a launch that failed. */
  say(text: string): void;
}

/** The project names a reply offers when it names none Boite knows. */
const KNOWN_MAX = 5;
/** Launched cards kept at once: the oldest goes first. */
const LAUNCHED_MAX = 3;

/** What the bubble says of a project name it does not know. */
export function unknownLine(name: string, near: string[], projects: Project[]): string {
  const known = taskProjects(projects).map((project) => project.name);
  if (known.length === 0) return strings.companion.task.noProject;
  const unknown = fill(strings.companion.task.unknown, { name });
  if (near.length > 0) return `${unknown} ${fill(strings.companion.task.near, { names: near.join(', ') })}`;
  return `${unknown} ${fill(strings.companion.task.known, { names: known.slice(0, KNOWN_MAX).join(', ') })}`;
}

export class Tasks {
  pending = $state.raw<PendingTask[]>([]);
  launched = $state.raw<LaunchedTask[]>([]);
  /** The pending task being launched, its buttons off meanwhile. */
  launching = $state<string | null>(null);
  private sequence = 0;

  constructor(private readonly host: TasksHost) {}

  /** The tasks a reply asks for: each project named is found, then the task waits or goes. */
  async request(tasks: TaskDirective[]): Promise<void> {
    const client = this.host.client();
    if (tasks.length === 0 || !client) return;
    let projects: Project[];
    try {
      projects = await client.call('projects.list', {});
    } catch (error) {
      return this.host.say(fill(strings.companion.task.failed, { reason: reasonOf(error) }));
    }
    const lines: string[] = [];
    for (const task of tasks) {
      const resolved = resolveProject(task.project, projects);
      if ('near' in resolved) {
        lines.push(unknownLine(task.project, resolved.near, projects));
        continue;
      }
      const { project } = resolved;
      const entry: PendingTask = {
        id: `task-${++this.sequence}`,
        projectId: project.id,
        project: project.name,
        prompt: task.prompt,
        worktree: project.repository === true && project.worktreeDefault === true
      };
      if (this.host.control() === 'ask') this.pending = [...this.pending, entry];
      else {
        const problem = await this.launch(entry);
        if (problem) lines.push(problem);
      }
    }
    if (lines.length > 0) this.host.say(lines.join('\n'));
  }

  /** The user launches a waiting task. */
  async confirm(id: string): Promise<void> {
    const entry = this.pending.find((task) => task.id === id);
    if (!entry || this.launching) return;
    this.launching = id;
    try {
      const problem = await this.launch(entry);
      this.pending = this.pending.filter((task) => task.id !== id);
      if (problem) this.host.say(problem);
    } finally {
      this.launching = null;
    }
  }

  cancel(id: string): void {
    if (this.launching === id) return;
    this.pending = this.pending.filter((task) => task.id !== id);
  }

  dismiss(threadId: string): void {
    this.launched = this.launched.filter((task) => task.threadId !== threadId);
  }

  /** Threads that finished: their notice takes over from the card. */
  finished(threadIds: string[]): void {
    if (this.launched.some((task) => threadIds.includes(task.threadId))) this.launched = this.launched.filter((task) => !threadIds.includes(task.threadId));
  }

  /**
   * A new thread in the project on what the main window opens a new prompt
   * on, then the instruction as its first turn. A string says why it did not go.
   */
  private async launch(entry: PendingTask): Promise<string | null> {
    const client = this.host.client();
    if (!client) return strings.companion.unreachable;
    try {
      const [providers, accounts, settings] = await Promise.all([
        client.call('providers.list', {}),
        client.call('accounts.list', {}),
        client.call('settings.get', {}).catch(() => null)
      ]);
      const choice = newThreadChoice(providers.loaded, accounts, settings, readPrefs(), readModelDefaults());
      if (!choice) return strings.companion.task.noAgent;
      const title = titleFrom(entry.prompt);
      const thread = await client.call('threads.create', {
        projectId: entry.projectId,
        providerId: choice.providerId,
        accountId: choice.accountId,
        permissionMode: choice.permissionMode,
        effort: choice.effort,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.speed ? { speed: choice.speed } : {}),
        ...(title ? { title } : {}),
        ...(entry.worktree ? { worktree: {} } : {})
      });
      this.host.created(thread);
      await client.call('turns.start', { threadId: thread.id, prompt: entry.prompt });
      this.launched = [...this.launched, { threadId: thread.id, project: entry.project, title: thread.title || title }].slice(-LAUNCHED_MAX);
      return null;
    } catch (error) {
      return fill(strings.companion.task.failed, { reason: reasonOf(error) });
    }
  }
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
