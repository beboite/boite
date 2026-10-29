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
import { publishArtifact, readArtifact } from './artifacts.ts';
import { checkView, publishView, viewBlock } from './views.ts';

/** More than a plan, and the tasks surface stops being readable anyway. */
export const TASKS_MAX = 200;
const TASK_STATUSES: readonly AgentTask['status'][] = ['pending', 'in_progress', 'completed'];

/** One token per thread, in memory, minted on demand and forgotten with the thread. */
export class AgentTokens {
  private readonly byThread = new Map<ThreadId, string>();
  private readonly byToken = new Map<string, ThreadId>();
  /** Threads whose token opens nothing: the core reads their answer and gives them no method (a memory pass). */
  private readonly sealed = new Set<ThreadId>();

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
    const threadId = this.byToken.get(token);
    return threadId === undefined || this.sealed.has(threadId) ? null : threadId;
  }

  /** From now on the thread's token, minted or not, authenticates nothing. */
  seal(threadId: ThreadId): void {
    this.sealed.add(threadId);
  }

  /**
   * The thread's token opens nothing from now on. Its seal goes only with the
   * thread itself (`removed`): an archived memory pass restored later stays sealed.
   */
  forget(threadId: ThreadId, removed = false): void {
    const held = this.byThread.get(threadId);
    if (removed) this.sealed.delete(threadId);
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
  if (kind === 'workflow') {
    const runId = (asked as { runId?: unknown }).runId;
    if (runId === undefined || runId === null) return { kind };
    if (typeof runId !== 'string' || !/^wfr_[A-Za-z0-9_-]{1,64}$/.test(runId)) throw refused(`panel.open workflow runId: expected a run id from boite workflow list, got ${String(runId)}`, { runId });
    return { kind, runId };
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
  core.router.register('browser.remoteFrame', (params, { connection }) => core.browser.remoteFrame(params, connection));
  core.router.register('browser.remoteInput', (params, { connection }) => core.browser.remoteInput(params, connection));
  core.router.register('browser.remoteSelection', (params, { connection }) => core.browser.remoteSelection(params, connection));
  core.router.register('devices.list', (params, { connection }) => core.devices.list(params, connection));
  core.router.register('devices.sessions', (params, { connection }) => core.devices.sessions(params, connection));
  core.router.register('devices.open', (params, { connection }) => core.devices.open(params, connection));
  core.router.register('devices.frame', (params, { connection }) => core.devices.frame(params, connection));
  core.router.register('devices.input', (params, { connection }) => core.devices.input(params, connection));
  core.router.register('devices.stream', (params, { connection }) => core.devices.stream(params, connection));
  core.router.register('devices.clipboard', (params, { connection }) => core.devices.clipboard(params, connection));
  core.router.register('devices.screenshot', (params, { connection }) => core.devices.screenshot(params, connection));
  core.router.register('devices.close', (params, { connection }) => core.devices.close(params, connection));
  core.router.register('windows.list', (params, { connection }) => core.windows.list(params, connection));
  core.router.register('windows.screenshot', (params, { connection }) => core.windows.screenshot(params, connection));
  core.router.register('windows.clip', (params, { connection }) => core.windows.clip(params, connection));
  core.router.register('windows.watch', (params, { connection }) => core.windows.watch(params, connection));
  core.router.register('windows.frame', (params, { connection }) => core.windows.frame(params, connection));
  core.router.register('windows.close', (params, { connection }) => core.windows.close(params, connection));
  core.router.register('windows.consent', (params, { connection }) => core.windows.consent(params, connection));
  core.router.register('windows.allowlist', params => core.windows.allowlist(params));
  core.router.register('windows.revoke', params => core.windows.revoke(params));
  core.router.register('browser.remoteWatch', (params, { connection }) => core.browser.remoteWatch(params, connection));
  core.router.register('browser.remoteStatus', (params, { connection }) => core.browser.remoteStatus(params, connection));
  core.router.register('browser.command', params => core.browser.command(params));
  core.router.register('browser.importCookies', params => core.browser.importCookies(params));
  core.router.register('browser.hostAttach', (_params, { connection }) => core.browser.hostAttach(connection));
  core.router.register('browser.hostDetach', (_params, { connection }) => core.browser.hostDetach(connection));
  core.router.register('browser.hostReply', (params, { connection }) => core.browser.hostReply(params, connection));
  core.router.register('artifacts.publish', (params) => publishArtifact(core, params));
  core.router.register('artifacts.read', (params) => readArtifact(core, params));
  core.router.register('artifacts.view', (params) => publishView(core, params));
  core.router.register('artifacts.viewCheck', (params) => checkView(core, params));
  core.router.register('artifacts.viewBlock', (params) => viewBlock(core, params));
  core.router.register('artifacts.preview', ({ threadId, path }) => {
    const preview = core.artifactPreviews.open(threadId, path);
    core.bus.emit('panel.requested', { threadId, surface: { kind: 'browser', url: preview.url, artifact: { path: preview.path, port: preview.port } }, at: Date.now() });
    return { url: preview.url, shown: core.subscribers.hasSubscribers(threadId) };
  });
  core.router.register('artifacts.previewClose', ({ threadId, path }) => {
    core.artifactPreviews.close(threadId, path);
    return { ok: true };
  });
  core.router.register('agent.where', (params) => whereOf(core, core.threads.require(params.threadId)));
  // The access check already held the call to the token's own thread.
  core.router.register('agent.move', (params) => core.threads.moves.request(params.threadId, params.project));
  core.router.register('agent.spawn', (params) => core.threads.spawns.spawn(params));
  core.router.register('agent.addProject', (params) => core.threads.spawns.addProject(params));
  core.router.register('agent.projects', (params) => {
    const own = core.threads.require(params.threadId).projectId;
    return core.projects.list().filter((project) => project.archived !== true).map((project) => ({
      id: project.id, name: project.name, path: project.path, repository: project.repository === true, drafts: project.kind === 'drafts', current: project.id === own,
    }));
  });
  core.router.register('panel.open', async (params) => {
    const thread = core.threads.require(params.threadId);
    const surface = checkSurface(thread.cwd, params.surface);
    // One browser per conversation: a page opens as a new tab of the browser
    // its agent drives, and every client brings that tab forward on its own.
    if (surface.kind === 'browser') await core.browser.command({ threadId: thread.id, action: { kind: 'open', url: surface.url } });
    else core.bus.emit('panel.requested', { threadId: thread.id, surface, at: Date.now() });
    // Nobody is watching this thread: the agent learns its request went nowhere
    // rather than believing the user saw something.
    return { shown: core.subscribers.hasSubscribers(thread.id) };
  });
  // The page a pending question carries, for whoever answers it: a paired phone
  // names a question, never a surface, and only in the conversation it watches.
  // Opening it again brings back the tab it opened, wherever its sign-in led it.
  const pageTabs = new Map<string, string>();
  core.router.register('questions.openPage', async (params, { connection }) => {
    const thread = core.threads.require(params.threadId);
    if (connection.identity.principal !== 'owner' && (thread.archived || !connection.subscriptions.has(thread.id))) throw refused('subscribe to the active conversation before opening its page');
    const url = core.threads.listQuestions(thread.id).find((question) => question.id === params.questionId)?.open?.url;
    if (url === undefined) throw refused(`questions.openPage: ${params.questionId} is not a pending question with a page`, { questionId: params.questionId });
    const surface = checkSurface(thread.cwd, { kind: 'browser', url });
    if (surface.kind !== 'browser') return { ok: true } as const;
    const key = `${thread.id}:${params.questionId}`, opened = pageTabs.get(key);
    if (opened !== undefined && core.browser.status({ threadId: thread.id }).tabs.some((tab) => tab.tabId === opened)) {
      await core.browser.command({ threadId: thread.id, tabId: opened, action: { kind: 'activate' } });
      return { ok: true } as const;
    }
    const reply = await core.browser.command({ threadId: thread.id, action: { kind: 'open', url: surface.url } });
    if (reply.tabId !== undefined) {
      pageTabs.set(key, reply.tabId);
      if (pageTabs.size > 500) pageTabs.delete(pageTabs.keys().next().value!);
    }
    return { ok: true } as const;
  });
  core.router.register('threads.tasks.set', (params) => setTasks(core, params));
  core.router.register('threads.tasks.get', (params) => {
    core.threads.require(params.threadId);
    return core.activity.get(params.threadId).tasks;
  });
  registerTodoMethods(core);
  registerGitMethods(core);
  registerWorkdirMethods(core);

  // A manual archive stops its processes. Automatic merged-PR Done lets the
  // current prompt keep using Boite until it finishes, then closes its door.
  // Forgetting the token only stops the next hello, so a socket an agent
  // already opened goes too: it used to keep claiming cards and opening
  // panels on a thread the user had put away.
  const shut = (threadId: ThreadId, removed = false): void => {
    core.browser.release(threadId);
    core.devices.release(threadId);
    core.windows.release(threadId);
    core.agents.forget(threadId, removed);
    core.subscribers.closeAgents(threadId);
  };
  // Committed events only: a rolled-back archive or removal keeps the thread's windows, agent and sockets.
  core.bus.onCommitted((name, payload) => {
    if (name === 'thread.removed') shut((payload as { threadId: ThreadId }).threadId, true);
    if (name === 'thread.updated') {
      const thread = payload as ThreadSummary;
      if (thread.archived && !(thread.archiveReason?.type === 'pr-merged' && (thread.status === 'running' || thread.status === 'waiting'))) shut(thread.id);
    }
  });
}
