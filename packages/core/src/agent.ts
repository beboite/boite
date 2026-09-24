/*
 * The agent's door.
 *
 * A process a thread launches carries three variables and a `boite` shim on
 * its PATH: the agent running in that thread says hello with the token, is the
 * `agent` principal of that one thread, and reaches the handful of methods
 * `AGENT_METHODS` lists. The token is minted on the first spawn of the thread
 * and never leaves memory, so a copy of the journal carries no credential and
 * a core restart closes the door behind the processes it lost.
 */

import { delimiter } from 'node:path';
import { AGENT_ENV, PANEL_SURFACE_KINDS } from '@boite/contracts';
import type { AgentTask, AgentWhere, PanelSurface, RpcParams, ThreadActivity, ThreadId, ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { newToken } from './ids.ts';
import { registerGitMethods } from './git.ts';
import { registerTodoMethods } from './todos.ts';
import { existingInside, registerWorkdirMethods, resolveInside } from './workdir.ts';
import { publishArtifact } from './artifacts.ts';

/** More than a plan, and the tasks surface stops being readable anyway. */
export const TASKS_MAX = 200;
const TASK_STATUSES: readonly AgentTask['status'][] = ['pending', 'in_progress', 'completed'];

/** One token per thread, in memory, minted on demand and forgotten with the thread. */
export class AgentTokens {
  private readonly byThread = new Map<ThreadId, string>();
  private readonly byToken = new Map<string, ThreadId>();

  /** The thread's token, the same one for every process it launches. */
  tokenFor(threadId: ThreadId): string {
    const held = this.byThread.get(threadId);
    if (held !== undefined) return held;
    const token = newToken();
    this.byThread.set(threadId, token);
    this.byToken.set(token, threadId);
    return token;
  }

  /** The thread a token speaks for, or null: a wrong token says nothing about which. */
  authenticate(token: string): ThreadId | null {
    return this.byToken.get(token) ?? null;
  }

  forget(threadId: ThreadId): void {
    const held = this.byThread.get(threadId);
    if (held === undefined) return;
    this.byThread.delete(threadId);
    this.byToken.delete(held);
  }
}

/**
 * The environment of a process a thread launches: which thread it is, where
 * the core answers, the token that opens it, and the directory holding the
 * `boite` shim in front of PATH. Pure, so the merge is tested without spawning
 * anything. PATH is spelled `Path` on Windows, so whichever spelling the base
 * already carries is the one written back, and a base that already starts with
 * the directory is left alone: a driver rebuilding its environment for a warm
 * process must not grow PATH one entry per turn.
 */
export function agentEnvFor(
  base: Record<string, string | undefined>,
  fields: { threadId: ThreadId; coreUrl: string; token: string; cliDir: string | null },
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...base,
    [AGENT_ENV.threadId]: fields.threadId,
    [AGENT_ENV.coreUrl]: fields.coreUrl,
    [AGENT_ENV.token]: fields.token,
  };
  if (fields.cliDir === null) return env;
  const key = platform === 'win32'
    ? Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
    : 'PATH';
  const current = env[key] ?? '';
  if ((current.split(delimiter)[0] ?? '') === fields.cliDir) return env;
  env[key] = current.length === 0 ? fields.cliDir : `${fields.cliDir}${delimiter}${current}`;
  return env;
}

/** Everything a thread's own environment needs, read from the core at spawn time. */
export function agentEnvOf(core: Core, threadId: ThreadId, base: Record<string, string | undefined>): Record<string, string | undefined> {
  return agentEnvFor(base, {
    threadId,
    coreUrl: core.baseUrl(),
    token: core.agents.tokenFor(threadId),
    cliDir: core.cliDir,
  });
}

function whereOf(core: Core, thread: ThreadSummary): AgentWhere {
  const project = thread.projectId === null ? null : core.projects.require(thread.projectId);
  return {
    threadId: thread.id,
    title: thread.title,
    projectId: project?.id ?? null,
    projectPath: project?.path ?? null,
    cwd: thread.cwd,
    branch: thread.branch,
    // A thread only carries a branch when the core placed it in a worktree of
    // its own; a thread working in the project directory has none.
    worktree: thread.branch !== null,
    providerId: thread.providerId,
    model: thread.model ?? '',
  };
}

function checkLine(line: unknown): number | undefined {
  if (line === undefined || line === null) return undefined;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw refused(`panel.open line must be a line number, got ${String(line)}`, { line });
  }
  return line;
}

/**
 * What the panel is asked to show, checked before any client hears about it: a
 * file that exists inside the working directory, a directory that does, a url
 * that is http or https. The path answered is the relative one, so every
 * client resolves it against the same working directory.
 */
export function checkSurface(cwd: string, surface: PanelSurface): PanelSurface {
  const kind = (surface as { kind?: unknown } | null | undefined)?.kind;
  if (typeof kind !== 'string' || !(PANEL_SURFACE_KINDS as readonly string[]).includes(kind)) {
    throw refused(`panel.open does not know the surface ${String(kind)}`, { kind, expected: [...PANEL_SURFACE_KINDS] });
  }
  const asked = surface as Extract<PanelSurface, { path?: unknown; url?: unknown; line?: unknown }>;
  const path = (asked as { path?: unknown }).path;
  if (kind === 'file') {
    if (typeof path !== 'string' || path.length === 0) throw refused('panel.open file needs a path', { kind });
    const found = existingInside(cwd, path, 'file', 'panel.open file path');
    const line = checkLine((asked as { line?: unknown }).line);
    return line === undefined ? { kind, path: found.relative } : { kind, path: found.relative, line };
  }
  if (kind === 'files') {
    if (path === undefined || path === null) return { kind };
    return { kind, path: existingInside(cwd, path as string, 'dir', 'panel.open files path').relative };
  }
  if (kind === 'diff') {
    // A diff names a file that may be gone from the working tree: it has to be
    // inside the working directory, it does not have to still be there.
    if (path === undefined || path === null) return { kind };
    return { kind, path: resolveInside(cwd, path as string, 'panel.open diff path').relative };
  }
  if (kind === 'browser') {
    const url = (asked as { url?: unknown }).url;
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw refused(`panel.open browser needs a url, got ${String(url)}`, { url });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw refused(`panel.open browser takes http or https, not ${parsed.protocol.replace(':', '')}`, { url });
    }
    return { kind, url: parsed.href };
  }
  return { kind: kind as 'trace' | 'tasks' };
}

export function checkTasks(tasks: unknown): AgentTask[] {
  if (!Array.isArray(tasks)) throw refused('threads.tasks.set takes a list of tasks', {});
  if (tasks.length > TASKS_MAX) {
    throw refused(`threads.tasks.set takes at most ${TASKS_MAX} tasks, got ${tasks.length}`, { count: tasks.length });
  }
  return tasks.map((value, index) => {
    const task = value as Partial<AgentTask> | null;
    if (typeof task?.id !== 'string' || task.id.length === 0) throw refused(`task ${index} needs an id`, { index });
    if (typeof task.text !== 'string' || task.text.trim().length === 0) throw refused(`task ${task.id} needs text`, { id: task.id });
    if (!TASK_STATUSES.includes(task.status as AgentTask['status'])) {
      throw refused(`task ${task.id} is ${TASK_STATUSES.join(', ')}, not ${String(task.status)}`, { id: task.id, status: task.status });
    }
    return { id: task.id, text: task.text, status: task.status as AgentTask['status'] };
  });
}

export function setTasks(core: Core, params: RpcParams<'threads.tasks.set'>): ThreadActivity {
  core.threads.require(params.threadId);
  core.activity.tasks(params.threadId, checkTasks(params.tasks));
  return core.activity.get(params.threadId);
}

/**
 * The agent's methods and the ones a client shares with it. Registering them
 * here keeps the door in one file: `access.ts` says who may knock.
 */
export function registerAgentMethods(core: Core): void {
  core.router.register('artifacts.publish', (params) => publishArtifact(core, params));
  core.router.register('agent.where', (params) => whereOf(core, core.threads.require(params.threadId)));
  core.router.register('panel.open', (params) => {
    const thread = core.threads.require(params.threadId);
    const surface = checkSurface(thread.cwd, params.surface);
    core.bus.emit('panel.requested', { threadId: thread.id, surface, at: Date.now() });
    // Nobody is watching this thread: the agent learns its request went nowhere
    // rather than believing the user saw something.
    return { shown: core.subscribers.hasSubscribers(thread.id) };
  });
  core.router.register('threads.tasks.set', (params) => setTasks(core, params));
  core.router.register('threads.tasks.get', (params) => {
    core.threads.require(params.threadId);
    return core.activity.get(params.threadId).tasks;
  });
  registerTodoMethods(core);
  registerGitMethods(core);
  registerWorkdirMethods(core);

  // A thread that is gone or archived keeps no door open: its processes are
  // stopped with it, and a token nobody can use is a token nobody can steal.
  // Forgetting the token only stops the next hello, so a socket an agent
  // already opened goes too: it used to keep claiming cards and opening
  // panels on a thread the user had put away.
  const shut = (threadId: ThreadId): void => {
    core.agents.forget(threadId);
    core.subscribers.closeAgents(threadId);
  };
  core.bus.onAny((name, payload) => {
    if (name === 'thread.removed') shut((payload as { threadId: ThreadId }).threadId);
    if (name === 'thread.updated') {
      const thread = payload as ThreadSummary;
      if (thread.archived) shut(thread.id);
    }
  });
}
