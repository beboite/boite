/** Threads and their messages: create, read, select, archive, and the turn entry points. */
import { attachmentError, previewReferencesError, MESSAGE_PAGE, MESSAGE_PAGE_MAX, RpcErrorCode, type AgentProfile, type AgentWork, type AgentWhere, type Message, type MessageId, type RpcParams, type Thread } from '@boite/contracts';
import { RpcFailure } from '../client';
import { checkCwd, checkEffort, checkModel, checkRunnable, defaultModel } from './checks';
import { RETITLE_DELAY_MS } from './providers';
import { DATA_DIR, fakeWorktree, fakeDraftFolder, refusal, toSummary } from './shared';
import { closeTerminal } from './terminals';
import { modelsOf, checkSpeed } from './provider-catalog';
import { delegationConfig, stopDelegation } from './delegation';
import type { FakeContext, FakeMethods } from './context';

export function createAgentSession(ctx: FakeContext, agent: AgentProfile, sessionId: string, work: AgentWork): string {
  const mission = work.scope.kind === 'mission' ? ctx.agents.snapshot().missions.find(m => m.id === work.scope.id) : null;
  const project = ctx.projects.find(p => p.id === mission?.projectId);
  const placed = project ? fakeWorktree(project.path, `${agent.name} ${mission?.title ?? ''}`) : null;
  const now = Date.now();
  const thread: Thread = { id: `t-${++ctx.seq}`, projectId: project?.id ?? null, agentSessionId: sessionId, ...agent.selection,
    title: agent.name, titleSource: 'user', speed: null, cwd: placed?.path ?? `${DATA_DIR}/agent-workspaces/${agent.id}/${work.scope.id}`, branch: placed?.branch ?? null,
    status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null,
    createdAt: now, updatedAt: now, messages: [], messagesBefore: null, turns: [], commands: [] };
  ctx.threads.set(thread.id, thread);
  ctx.emit('thread.created', structuredClone(toSummary(thread)));
  return thread.id;
}

/**
 * The `limit` messages that sit just before `end`, oldest first, with the
 * cursor for what is still behind them. The core reads the same window off
 * rowids; here it is a slice of the array the fake keeps.
 */
function pageOf(
  messages: Message[],
  end: number,
  limit: number
): { messages: Message[]; before: MessageId | null } {
  const start = Math.max(0, end - limit);
  const page = messages.slice(start, end);
  return { messages: page, before: start > 0 ? (page[0]?.id ?? null) : null };
}

/**
 * What the core's archive does beyond the flag, from `threads.archive` and
 * `projects.remove` alike: the turn stops, nobody answers a card on the
 * thread, its background work goes, and its shell closes the way the core
 * closes `terminal:<id>`.
 */
export async function putAway(ctx: FakeContext, thread: Thread): Promise<void> {
  await ctx.stopTurn(thread.id);
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    if (pending.request.threadId !== thread.id) continue;
    ctx.pendingQuestions.delete(questionId);
    pending.resolve(null);
  }
  ctx.heldAnswers.delete(thread.id);
  if ((thread.background?.length ?? 0) > 0) ctx.setBackground(thread, []);
  closeTerminal(ctx, `terminal:${thread.id}`);
}

/**
 * The core's model and effort checks on `threads.update`, run before
 * anything changes: the model when it changes or the account does, and the
 * effort against the model the thread ends on.
 */
function checkSelection(ctx: FakeContext, thread: Thread, params: RpcParams<'threads.update'>): void {
  const account = ctx.accounts.find((entry) => entry.id === (params.accountId ?? thread.accountId));
  const provider = account && ctx.providers.find((entry) => entry.id === account.providerId);
  if (!account || !provider) return;
  const models = modelsOf(ctx, provider.id, account.id);
  const switched = account.id !== thread.accountId;
  let model = thread.model;
  let effort = thread.effort;
  if (switched) {
    model = checkModel(provider, account.id, models, params.model === undefined ? defaultModel(provider) : params.model);
    effort = null;
  }
  if (params.model !== undefined && (params.model !== thread.model || switched)) {
    model = checkModel(provider, account.id, models, params.model);
    effort = null;
  }
  if (params.effort !== undefined) effort = params.effort;
  checkEffort(provider, models, model, effort);
}

export function threadMethods(ctx: FakeContext) {
  return {
    'threads.pullRequest': async (params) => {
      const thread = ctx.threads.get(params.threadId);
      return thread?.pullRequest ?? null;
    },
    'threads.list': async (params) => {
      return [...ctx.threads.values()]
        .filter((t) => (params.projectId ? t.projectId === params.projectId : true))
        .filter((t) => (params.includeArchived ? true : !t.archived))
        .map((t) => structuredClone(toSummary(t)));
    },
    'threads.create': async (params) => {
      const project = ctx.projects.find((p) => p.id === params.projectId);
      if (!project) throw ctx.notFound('project', params.projectId);
      const provider = ctx.providers.find(entry => entry.id === params.providerId);
      if (!provider) throw ctx.notFound('provider', params.providerId);
      const account = ctx.accounts.find((entry) => entry.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      if (account.providerId !== provider.id) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the account belongs to another provider', data: { accountId: account.id, accountProviderId: account.providerId, providerId: provider.id } });
      }
      const models = modelsOf(ctx, provider.id, account.id);
      const model = checkModel(provider, account.id, models, params.model ?? defaultModel(provider));
      const effort = checkEffort(provider, models, model, params.effort ?? null);
      checkSpeed(ctx, params.providerId, params.accountId, model, params.speed ?? null);
      if (params.cwd !== undefined && params.cwd.length > 0 && params.worktree === undefined) checkCwd(project.path, params.cwd);
      const at = ctx.now();
      const title = params.title !== undefined && params.title.length > 0 ? params.title : 'New thread';
      // The core's own placement: a branch named after the title, the
      // worktree beside the repository. No git here, only the two strings.
      if (params.worktree !== undefined && project.kind === 'drafts') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a draft has no worktree: the drafts folder is not a git repository', data: { projectId: project.id } });
      const placed = params.worktree === undefined ? null : fakeWorktree(project.path, title, params.worktree.branch);
      // The core makes a dated folder per draft; the fake only names it.
      const draftFolder = project.kind === 'drafts' && !params.cwd
        ? fakeDraftFolder(project.path, title, new Date(at), new Set([...ctx.threads.values()].map((thread) => thread.cwd)))
        : null;
      const thread: Thread = {
        id: `t-${++ctx.seq}`,
        projectId: params.projectId,
        title,
        titleSource: 'prompt',
        providerId: params.providerId,
        accountId: params.accountId,
        model,
        effort,
        speed: params.speed ?? null,
        cwd: placed?.path ?? draftFolder ?? (params.cwd || project.path),
        branch: placed?.branch ?? null,
        permissionMode: params.permissionMode ?? 'default',
        status: 'idle',
        unread: false,
        archived: false,
        pinned: false,
        sessionId: null,
        load: null,
        context: null,
        createdAt: at,
        updatedAt: at,
        messages: [],
        commands: [],
        messagesBefore: null,
        turns: []
      };
      ctx.threads.set(thread.id, thread);
      ctx.emit('thread.created', structuredClone(toSummary(thread)));
      return structuredClone(toSummary(thread));
    },
    'threads.get': async (params) => {
      const thread = ctx.thread(params.threadId);
      // The core's rule: from the named message on, unless it is unknown or
      // the tail is longer than a page, and then the whole page as before.
      const from = params.after === undefined ? -1 : thread.messages.findIndex((message) => message.id === params.after);
      if (from !== -1 && thread.messages.length - from <= MESSAGE_PAGE) {
        const messages = thread.messages.slice(from);
        // As the core's `listTurnsFor`: the turns of the messages sent, and whatever is still queued or running.
        const sent = new Set(messages.map((message) => message.turnId));
        const turns = thread.turns.filter((turn) => turn.status === 'queued' || turn.status === 'running' || sent.has(turn.id));
        return structuredClone({ ...thread, messages, turns, messagesBefore: null, messagesFrom: params.after });
      }
      const page = pageOf(thread.messages, thread.messages.length, MESSAGE_PAGE);
      return structuredClone({ ...thread, messages: page.messages, messagesBefore: page.before });
    },
    'messages.list': async (params) => {
      const thread = ctx.thread(params.threadId);
      const at = thread.messages.findIndex((message) => message.id === params.before);
      if (at < 0) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `message ${params.before} is not a message of thread ${params.threadId}`,
          data: { threadId: params.threadId, before: params.before }
        });
      }
      const asked = params.limit ?? MESSAGE_PAGE;
      const limit = Math.min(Math.max(1, Math.trunc(asked)), MESSAGE_PAGE_MAX);
      const page = pageOf(thread.messages, at, limit);
      const turns = new Set(page.messages.map((message) => message.turnId));
      return structuredClone({ ...page, turns: thread.turns.filter((turn) => turns.has(turn.id)) });
    },
    'threads.update': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
      }
      const nextAccountId = params.accountId ?? thread.accountId;
      const nextProviderId = ctx.accounts.find(a => a.id === nextAccountId)?.providerId ?? thread.providerId;
      const changedModel = (params.model !== undefined && params.model !== thread.model) || nextAccountId !== thread.accountId;
      checkSpeed(ctx, nextProviderId, nextAccountId, params.model !== undefined ? params.model : thread.model, params.speed !== undefined ? params.speed : changedModel ? null : thread.speed ?? null);
      checkSelection(ctx, thread, params);
      const before = [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0');
      if (params.accountId !== undefined && params.accountId !== thread.accountId) {
        const account = ctx.accounts.find((entry) => entry.id === params.accountId);
        const provider = account && ctx.providers.find((entry) => entry.id === account.providerId);
        if (!account || !provider?.available || account.status === 'unauthenticated') {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the selected account is unavailable' });
        }
        thread.accountId = account.id;
        thread.providerId = account.providerId;
        thread.model = params.model === undefined ? defaultModel(provider) : params.model;
        thread.effort = null; thread.speed = null;
        thread.sessionId = null;
        thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
        thread.context = null;
        thread.commands = [];
        ctx.emit('thread.commands', { threadId: thread.id, commands: [] });
      }
      // As the core: an empty title is no title, and the one there stays.
      if (params.title !== undefined && params.title.length > 0) {
        thread.title = params.title;
        thread.titleSource = 'user';
      }
      if (params.model !== undefined && params.model !== thread.model) { thread.model = params.model; thread.effort = null; thread.speed = null; }
      if (params.effort !== undefined) thread.effort = params.effort;
      if (params.speed !== undefined) thread.speed = params.speed;
      if (params.permissionMode !== undefined) thread.permissionMode = params.permissionMode;
      if (before !== [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0')) thread.selectionVersion = (thread.selectionVersion ?? 0) + 1;
      return ctx.touch(thread);
    },
    'threads.retitle': async (params) => {
      const thread = ctx.thread(params.threadId);
      const first = thread.messages.find((message) => message.role === 'user');
      if (first === undefined) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: 'this thread has no prompt to write a title from',
          data: { threadId: params.threadId }
        });
      }
      if (ctx.retitling.has(thread.id)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a title is already being written for this thread', data: { threadId: thread.id } });
      }
      // The echo agent's rule, at the echo agent's pace: its prefix and the first five words.
      ctx.retitling.add(thread.id);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, RETITLE_DELAY_MS));
      } finally {
        ctx.retitling.delete(thread.id);
      }
      const words = first.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(' ')
        .split(/\s+/)
        .filter((word) => word.length > 0);
      thread.title = `Echo: ${words.slice(0, 5).join(' ')}`;
      thread.titleSource = 'agent';
      return ctx.touch(thread);
    },
    'threads.archive': async (params) => {
      const thread = ctx.thread(params.threadId);
      thread.archived = params.archived ?? true;
      if (thread.archived) await putAway(ctx, thread);
      return ctx.touch(thread);
    },
    'threads.pin': async (params) => {
      const thread = ctx.thread(params.threadId);
      const pinned = params.pinned ?? true;
      if (thread.pinned === pinned) return structuredClone(toSummary(thread));
      thread.pinned = pinned;
      return ctx.touch(thread);
    },
    'threads.markRead': async (params) => {
      const thread = ctx.thread(params.threadId);
      // As the core: a thread already read is not written again, so nothing is announced.
      if (!thread.unread) return { ok: true };
      thread.unread = false;
      ctx.touch(thread);
      return { ok: true };
    },
    'threads.subscribe': async (params) => {
      // The core runs `threads.require` first, so an unknown id is a NotFound.
      ctx.thread(params.threadId);
      ctx.bus.subscribed.add(params.threadId);
      return { ok: true };
    },
    'threads.unsubscribe': async (params) => {
      ctx.bus.subscribed.delete(params.threadId);
      return { ok: true };
    },
    'turns.start': async (params) => {
      if (ctx.thread(params.threadId).agentSessionId) throw refusal('persistent agent sessions accept work through Agents');
      const referenceError = previewReferencesError(params.previewReferences ?? [], params.prompt);
      if (referenceError) throw new RpcFailure({ code: RpcErrorCode.Refused, message: referenceError });
      if (params.attachments !== undefined && (!Array.isArray(params.attachments) || params.attachments.some(a => !a || typeof a !== 'object'))) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'attachments must be an array of attachment objects' });
      const key = params.clientRequestId ? `${params.threadId}:${params.clientRequestId}` : null;
      const content = JSON.stringify([params.prompt, (params.attachments ?? []).map(a => [a.kind, a.mimeType, a.data, a.name]), ...(params.previewReferences?.length ? [params.previewReferences] : [])]);
      if (params.clientRequestId !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(params.clientRequestId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'clientRequestId must contain 8 to 128 URL-safe characters' });
      const previous = key ? ctx.turnRequests.get(key) : undefined;
      if (previous) {
        if (previous.content !== content) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'clientRequestId was already used for different content' });
        return previous.turn;
      }
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (ctx.thread(params.threadId).selectionVersion ?? 0)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
      }
      const thread = ctx.thread(params.threadId);
      const providerId = thread.providerId;
      const provider = ctx.providers.find(p => p.id === providerId);
      if (!provider) throw ctx.notFound('provider', providerId);
      // As the core, in its order: an archived or busy thread first, then whether the agent can run at all.
      if (!thread.archived && !['queued', 'running', 'waiting'].includes(thread.status) && !ctx.inFlight.has(thread.id)) {
        const account = ctx.accounts.find((a) => a.id === thread.accountId);
        if (account) checkRunnable(provider, account);
      }
      const error = attachmentError(params.attachments ?? [], provider);
      if (error) throw new RpcFailure({ code: RpcErrorCode.Refused, ...error });
      const rootId = thread.parentThreadId;
      if (rootId) {
        const config = delegationConfig(ctx, rootId);
        if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
        if ((ctx.delegationTurns.get(rootId) ?? 0) >= config.maxTurns) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation turn budget reached' });
      }
      const turn = ctx.startTurn(params.threadId, params.prompt, params.attachments ?? [], rootId ? 'delegation' : undefined, undefined, undefined, params.previewReferences ?? []);
      if (rootId) ctx.delegationTurns.set(rootId, (ctx.delegationTurns.get(rootId) ?? 0) + 1);
      if (key) ctx.turnRequests.set(key, { content, turn });
      return turn;
    },
    'threads.compact': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed' });
      if (!thread.sessionId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread has no native session to compact' });
      if (ctx.providers.find((p) => p.id === thread.providerId)?.protocol === 'acp' && !thread.commands.some((c) => c.name === 'compact')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this agent has not advertised a compact command' });
      if (ctx.providers.find((p) => p.id === thread.providerId)?.protocol === 'agy') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the Antigravity CLI takes no /compact in print mode' });
      return ctx.startTurn(params.threadId, '[compact]', [], 'compact');
    },
    'turns.stop': async (params) => {
      const thread = ctx.thread(params.threadId);
      const root = thread.parentThreadId ?? thread.id;
      let childrenStopped = 0;
      if (thread.parentThreadId || delegationConfig(ctx, root).enabled || (ctx.delegationAgents.get(root)?.length ?? 0) > 0) {
        childrenStopped = await stopDelegation(ctx, root, thread.parentThreadId ? thread.id : undefined);
        ctx.emit('delegation.changed', { threadId: root });
      }
      const stopped = await ctx.stopTurn(params.threadId) || childrenStopped > 0;
      // As the core: Stop on an idle thread ends what it still runs in the background.
      if (!stopped && (thread.background?.length ?? 0) > 0) {
        ctx.setBackground(thread, []);
        return { stopped: true };
      }
      return { stopped };
    },
    'agent.where': async (params) => {
      const thread = ctx.thread(params.threadId);
      const project = ctx.projects.find((one) => one.id === thread.projectId);
      if (!project && thread.projectId !== null) throw ctx.notFound('project', thread.projectId);
      const where: AgentWhere = {
        threadId: thread.id,
        title: thread.title,
        projectId: project?.id ?? null,
        projectPath: project?.path ?? null,
        cwd: thread.cwd,
        branch: thread.branch,
        // A thread of its own worktree does not sit in the project directory.
        worktree: thread.branch !== null,
        providerId: thread.providerId,
        // A thread on no model of its own runs the provider's default.
        model: thread.model ?? 'default'
      };
      return where;
    },
  } satisfies Partial<FakeMethods>;
}
