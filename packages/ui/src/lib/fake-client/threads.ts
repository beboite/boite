import { dismissMergedPr } from './merged-pr-archive';
import { assertIdleFamily } from './completion';
import { isThreadTerminal, protectedThreadIdsError } from '@boite/contracts';
/** Threads and their messages: create, read, select, archive, and the turn entry points. */
import { DEFAULT_THREAD_DONE_RETENTION_DAYS, DEFAULT_THREAD_DELETION_RETENTION_DAYS, attachmentError, previewReferencesError, MESSAGE_PAGE, MESSAGE_PAGE_MAX, MESSAGE_PAGE_MAX_BYTES, RPC_MAX_FRAME_BYTES, RpcErrorCode, type AgentProfile, type AgentWork, type AgentWhere, type Attachment, type Message, type MessageId, type MoveEnd, type PreviewReference, type RpcParams, type Thread, type Turn } from '@boite/contracts';
import { steerUser } from './user-steering';
import { recoverTurn } from './recovery';
import { RpcFailure } from '../client';
import { checkCwd, checkEffort, checkModel, checkRunnable, defaultModel } from './checks';
import { writeTitle } from './titles';
import { DATA_DIR, fakeWorktree, fakeDraftFolder, refusal, toSummary } from './shared';
import { closeThreadTerminals } from './terminals';
import { announceProject, archiveProject, requireFakeFolder } from './project-archive';
import { modelsOf, checkSpeed, discoverSelection } from './provider-catalog';
import { delegationConfig, stopDelegation } from './delegation';
import type { FakeContext, FakeMethods } from './context';
import { registerFakeWorktree, requireFakeCwd } from './worktrees';
import { boundedMessageWindow, forTransport, projectMessage, resumeAnchor, snapshotOptionsProblem, type TransportOptions } from '@boite/contracts';
import { dropWaitingMove, fakeMoveNote } from './thread-move';
import { cancelFamilySideQuestions, cancelSide, sideQuestionMethods } from './side-questions';

function writeFakeFork(ctx: FakeContext, source: Thread, kept: Message[], placed: ReturnType<typeof fakeWorktree> | null = null) {
  const title = `${source.title} (fork)`;
  const now = ctx.now();
  const id = `t-${++ctx.seq}`;
  const turnIds = new Map<string, string>();
  const messages: Message[] = kept.map((message) => {
    if (!turnIds.has(message.turnId)) turnIds.set(message.turnId, `turn-${++ctx.seq}`);
    return { ...structuredClone(message), id: `m-${++ctx.seq}`, threadId: id, turnId: turnIds.get(message.turnId) ?? message.turnId, state: message.state === 'streaming' ? 'complete' : message.state };
  });
  const turns: Turn[] = source.turns.filter((turn) => turnIds.has(turn.id)).map((turn) => ({
    ...structuredClone(turn),
    id: turnIds.get(turn.id) ?? turn.id,
    threadId: id,
    status: turn.status === 'queued' || turn.status === 'running' ? 'stopped' : turn.status,
    queueHold: null,
    startedAt: turn.startedAt ?? turn.queuedAt,
    finishedAt: turn.finishedAt ?? now,
    usage: null,
  }));
  const thread: Thread = {
    id, projectId: source.projectId, title, titleSource: source.titleSource,
    providerId: source.providerId, accountId: source.accountId, model: source.model, effort: source.effort, speed: source.speed ?? null,
    cwd: placed?.path ?? source.cwd, branch: placed?.branch ?? source.branch, branchNamingPending: placed?.namingPending ?? false, permissionMode: source.permissionMode,
    status: 'idle', unread: false, archived: false, doneAt: null, pinned: false,
    forkOrigin: { threadId: source.id, messageId: kept.at(-1)?.id ?? null, turnId: kept.at(-1)?.turnId ?? null, mode: 'seeded' },
    sessionId: null, sessionGeneration: 1, selectionVersion: 0, load: null, context: null,
    createdAt: now, updatedAt: now, messages, turns, commands: [], messagesBefore: null,
  };
  ctx.threads.set(id, thread);
  ctx.emit('thread.created', structuredClone(toSummary(thread)));
  return structuredClone(toSummary(thread));
}

export function createAgentSession(ctx: FakeContext, agent: AgentProfile, sessionId: string, work: AgentWork): string {
  const mission = work.scope.kind === 'mission' ? ctx.agents.snapshot().missions.find(m => m.id === work.scope.id) : null;
  const project = ctx.projects.find(p => p.id === mission?.projectId);
  const placed = project ? fakeWorktree(project.path, `${agent.name} ${mission?.title ?? ''}`, undefined, ctx.settings.worktreeStorage, project.id) : null;
  if (project && placed) registerFakeWorktree(ctx, project.id, placed);
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
 * Up to `limit` complete messages before `end`, within the serialized byte
 * budget except for one transportable message, with the cursor above them.
 * The core iterates rowids; here it is a slice of the array the fake keeps.
 */
function pageOf(
  messages: Message[],
  end: number,
  limit: number,
  project?: Projection
): { messages: Message[]; before: MessageId | null } {
  let start = end, bytes = 2;
  while (start > 0 && end - start < limit && bytes < MESSAGE_PAGE_MAX_BYTES) {
    const message = messages[start - 1]!;
    const size = sentBytes(message, project);
    const next = bytes + size + (start < end ? 1 : 0);
    if (size >= RPC_MAX_FRAME_BYTES) {
      throw new RpcFailure({ code: RpcErrorCode.Refused,
        message: `message ${message.id} is ${size} serialized UTF-8 bytes; expected a complete message below ${RPC_MAX_FRAME_BYTES} bytes`,
        data: { threadId: message.threadId, messageId: message.id, field: 'messages', bytes: size, max: RPC_MAX_FRAME_BYTES, expected: `a complete message below ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` } });
    }
    if (start < end && next > MESSAGE_PAGE_MAX_BYTES) break;
    bytes = next;
    start -= 1;
  }
  const page = messages.slice(start, end);
  return { messages: page, before: start > 0 ? (page[0]?.id ?? null) : null };
}

/** The core's page from `from` on, at most `limit`, and the cursor below it while more follow. */
function forwardOf(messages: Message[], from: number, limit: number, project: Projection): { messages: Message[]; after: string | null } {
  // Reuse the backward page's byte and single-message rules, iterating from
  // the first newer message instead of from the last older one.
  const candidates = messages.slice(from, from + limit).reverse();
  const page = pageOf(candidates, candidates.length, limit, project).messages.reverse();
  return { messages: page, after: from + page.length < messages.length ? (page.at(-1)?.id ?? null) : null };
}

/** The core's page around a reading position: half a page above `at`, half from it on, once more than a page follows it. */
function aroundOf(messages: Message[], around: string | undefined, limit: number, project: Projection): { messages: Message[]; before: string | null; after: string | null } | null {
  const at = around === undefined ? -1 : messages.findIndex(message => message.id === around);
  if (at < 0 || messages.length - at <= limit) return null;
  const half = Math.max(1, Math.floor(limit / 2));
  const older = pageOf(messages, at, half, project);
  const newer = forwardOf(messages, at, Math.max(1, limit - half), project);
  const candidates = [...older.messages, ...newer.messages];
  const { start, end } = boundedMessageWindow(candidates.map(project), older.messages.length, MESSAGE_PAGE_MAX_BYTES);
  return {
    messages: candidates.slice(start, end),
    before: start > 0 ? candidates[start]!.id : older.before,
    after: end < candidates.length ? candidates[end - 1]!.id : newer.after,
  };
}

type Projection = (message: Message) => Message;

/** The core's rule: page budgets measure a message as the client receives it. */
function projection(options: TransportOptions): Projection {
  const cache = new WeakMap<Message, Message>();
  return message => {
    const held = cache.get(message);
    if (held) return held;
    const sent = projectMessage(message, options);
    cache.set(message, sent);
    return sent;
  };
}

/** As the core counts it: a read with no projection is internal and never measured. */
function sentBytes(message: Message, project: Projection | undefined): number {
  return project ? new TextEncoder().encode(JSON.stringify(project(message))).byteLength : 0;
}

function tailOf(messages: Message[], from: number, limit = MESSAGE_PAGE, project: Projection = message => message): Message[] | null {
  if (messages.length - from > limit) return null;
  let bytes = 2;
  for (let at = from; at < messages.length; at += 1) {
    bytes += sentBytes(messages[at]!, project) + (at > from ? 1 : 0);
    if (bytes > MESSAGE_PAGE_MAX_BYTES) return null;
  }
  return messages.slice(from);
}

/** Opaque fixture proofs. The real core uses native SHA-256 over the same complete message data. */
function snapshotHash(messages: Message[], options: RpcParams<'threads.get'>): string {
  const json = `${!!options.compactTools}:${!!options.compactFiles}:${!!options.compactImages}:${!!options.compactToolParts}:` + JSON.stringify(messages);
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < json.length; i++) {
    a = Math.imul(a ^ json.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ json.charCodeAt(i), 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** The tool call a client names, as `readToolPart` finds it in the core's journal. */
function toolOf(thread: Thread, params: { threadId: string; messageId: string; toolId: string }): Extract<Message['parts'][number], { type: 'tool' }> {
  const message = thread.messages.find(message => message.id === params.messageId);
  if (!message) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `message ${params.messageId} is not a message of thread ${params.threadId}` });
  const part = message.parts.find(part => part.type === 'tool' && part.toolId === params.toolId);
  if (!part || part.type !== 'tool') throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `tool ${params.toolId} is not a tool of message ${params.messageId}` });
  return part;
}

/** The fake has no wire; check the same reply envelope before copying a page. */
function pagingReply<T>(result: T): T {
  const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 0, result })).byteLength;
  if (bytes > RPC_MAX_FRAME_BYTES) throw new RpcFailure({ code: RpcErrorCode.Refused,
    message: `RPC response exceeds ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes; request a smaller result`,
    data: { field: 'response', bytes, max: RPC_MAX_FRAME_BYTES, expected: `a complete RPC response at most ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` } });
  return structuredClone(result);
}

/**
 * What the core's archive does beyond the flag, from `threads.archive` and
 * `projects.remove` alike: the turn stops, nobody answers a card on the
 * thread, its background work goes, and its shells close the way the core
 * closes them.
 */
export async function putAway(ctx: FakeContext, thread: Thread): Promise<void> {
  cancelSide(ctx, thread.id);
  // A waiting move goes with the thread, before its turn ends and would apply it.
  dropWaitingMove(ctx, thread);
  await ctx.stopTurn(thread.id);
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    if (pending.request.threadId !== thread.id) continue;
    ctx.pendingQuestions.delete(questionId);
    pending.resolve(null);
  }
  ctx.heldAnswers.delete(thread.id);
  if ((thread.background?.length ?? 0) > 0) ctx.setBackground(thread, [], 'session-ended');
  closeThreadTerminals(ctx, thread.id);
}

/** Like the resident core, expire stopped families from their deletion date. */
export function purgeDeletedThreads(ctx: FakeContext): void {
  const days = ctx.settings.threadDeletionRetentionDays ?? DEFAULT_THREAD_DELETION_RETENTION_DAYS;
  if (days === 0) return;
  const before = Date.now() - days * 86_400_000;
  let changed = false;
  for (const [id, family] of ctx.deletedThreads) {
    if (family.deletedAt > before) continue;
    ctx.deletedThreads.delete(id);
    for (const thread of family.threads) {
      ctx.mergedPrFixtures.delete(thread.id);
      ctx.mergedPrArchive.delete(thread.id);
      ctx.processes = ctx.processes.filter(p => p.threadId !== thread.id && !isThreadTerminal(thread.id, p.threadId));
      ctx.coordination.delete(thread.id);
      ctx.delegationConfigs.delete(thread.id);
      ctx.delegationAgents.delete(thread.id);
      ctx.delegationLetters.delete(thread.id);
    }
    changed = true;
  }
  if (changed) ctx.emit('thread.deletionsUpdated', {});
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
  const catalogRead = ctx.modelCatalogs.has(provider.id + '::' + account.id);
  const switched = account.id !== thread.accountId;
  let model = thread.model;
  let effort = thread.effort;
  if (switched) {
    model = checkModel(provider, account.id, models, params.model === undefined ? defaultModel(provider) : params.model, catalogRead);
    effort = null;
  }
  if (params.model !== undefined && (params.model !== thread.model || switched)) {
    model = checkModel(provider, account.id, models, params.model, catalogRead);
    effort = null;
  }
  if (params.effort !== undefined) effort = params.effort;
  if (switched || model !== thread.model || effort !== thread.effort) checkEffort(provider, models, model, effort);
}

export async function deleteExpiredDoneThreads(ctx: FakeContext, remove: (id: string) => Promise<unknown>): Promise<void> {
  for (const thread of [...ctx.threads.values()]) {
    const days = ctx.settings.threadDoneRetentionDays ?? DEFAULT_THREAD_DONE_RETENTION_DAYS;
    if (days === 0) return;
    if (!thread.archived || thread.doneAt == null || thread.parentThreadId || thread.agentSessionId
      || thread.doneAt > Date.now() - days * 86_400_000 || ctx.threads.get(thread.id) !== thread) continue;
    try { assertIdleFamily(ctx, thread.id); }
    catch (error) {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.Refused) continue;
      throw error;
    }
    await remove(thread.id);
  }
}

export function threadMethods(ctx: FakeContext) {
  const removing = new Set<string>();
  return {
    ...sideQuestionMethods(ctx, (source, messages) => writeFakeFork(ctx, source, messages)),
    'threads.pullRequest': async (params) => {
      const thread = ctx.threads.get(params.threadId);
      return thread?.branch && thread.branch !== 'HEAD' ? thread.pullRequest ?? null : null;
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
      requireFakeFolder(ctx, project);
      const provider = ctx.providers.find(entry => entry.id === params.providerId);
      if (!provider) throw ctx.notFound('provider', params.providerId);
      const account = ctx.accounts.find((entry) => entry.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      if (account.providerId !== provider.id) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the account belongs to another provider', data: { accountId: account.id, accountProviderId: account.providerId, providerId: provider.id } });
      }
      await discoverSelection(ctx, provider.id, account.id, params.model ?? defaultModel(provider), params.effort ?? null, params.speed ?? null);
      const models = modelsOf(ctx, provider.id, account.id);
      const model = checkModel(provider, account.id, models, params.model ?? defaultModel(provider), ctx.modelCatalogs.has(provider.id + '::' + account.id));
      const effort = checkEffort(provider, models, model, params.effort ?? null);
      checkSpeed(ctx, params.providerId, params.accountId, model, params.speed ?? null);
      if (params.incognito === true) {
        // The core's refusals, by field: the drafts only, and a folder it makes itself.
        if (project.kind !== 'drafts') throw refusal('an incognito conversation starts in the drafts project only', { projectId: project.id, field: 'incognito', expected: 'the drafts project' });
        if (params.worktree !== undefined) throw refusal('incognito and worktree exclude each other: an incognito conversation works in a folder the core makes', { field: 'incognito', expected: 'absent or false with worktree' });
        if (params.cwd) throw refusal('incognito and cwd exclude each other: an incognito conversation works in a folder the core makes', { field: 'cwd', expected: 'absent with incognito' });
      }
      if (params.cwd !== undefined && params.cwd.length > 0 && params.worktree === undefined) checkCwd(project.path, params.cwd);
      const at = ctx.now();
      const title = params.title !== undefined && params.title.length > 0 ? params.title : 'New thread';
      // The core's own placement: a short temporary branch and the
      // worktree in the configured storage. No git here, only the two strings.
      if (params.worktree !== undefined && project.kind === 'drafts') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a draft has no worktree: the drafts folder is not a git repository', data: { projectId: project.id } });
      const placed = params.worktree === undefined ? null : fakeWorktree(project.path, title, params.worktree.branch, ctx.settings.worktreeStorage, project.id);
      if (placed) registerFakeWorktree(ctx, project.id, placed);
      // The core makes a dated folder per draft; the fake only names it.
      const id = `t-${++ctx.seq}`;
      const draftFolder = params.incognito === true ? `${DATA_DIR}/incognito/${id}`
        : project.kind === 'drafts' && !params.cwd
        ? fakeDraftFolder(project.path, title, new Date(at), new Set([...ctx.threads.values()].map((thread) => thread.cwd)))
        : null;
      const thread: Thread = {
        id,
        ...(params.incognito === true ? { incognito: true as const } : {}),
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
        branchNamingPending: placed?.namingPending ?? false,
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
      // As the core: a thread started in a project put away brings the project back.
      if (project.archived === true) archiveProject(ctx, project.id, false);
      return structuredClone(toSummary(thread));
    },
    'threads.get': async (params) => {
      const thread = ctx.thread(params.threadId);
      const problem = snapshotOptionsProblem(params);
      if (problem) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `threads.get.${problem.field}: expected ${problem.expected}`, data: problem });
      const asked = params.limit ?? MESSAGE_PAGE;
      if (!Number.isFinite(asked)) throw refusal('threads.get limit must be a finite number');
      const limit = Math.min(Math.max(1, Math.trunc(asked)), MESSAGE_PAGE_MAX);
      // The core's rule: from the named message on, unless it is unknown or
      // the tail exceeds a page's count or bytes, and then a full page.
      const from = params.after === undefined ? -1 : thread.messages.findIndex((message) => message.id === params.after);
      const project = projection(params);
      const tail = from === -1 ? null : tailOf(thread.messages, from, limit, project);
      const page = tail !== null ? { messages: tail, before: null, after: null }
        : aroundOf(thread.messages, params.around, limit, project) ?? { ...pageOf(thread.messages, thread.messages.length, limit, project), after: null };
      const sent = new Set(page.messages.map(message => message.turnId));
      const turns = thread.turns.filter(turn => turn.status === 'queued' || turn.status === 'running' || sent.has(turn.id));
      const anchor = params.sync ? resumeAnchor({ messages: page.messages, turns }) : null;
      const proof = anchor === null ? undefined : { from: anchor, hash: snapshotHash(page.messages.slice(page.messages.findIndex(message => message.id === anchor)), params) };
      const known = params.sync && params.sync !== true ? params.sync : undefined;
      const unchanged = tail !== null && params.after !== undefined && known?.from === params.after && known.hash === (proof?.from === params.after ? proof.hash : snapshotHash(tail, params));
      const snapshot = { ...thread, turns, messages: unchanged ? [] : page.messages.map(project), messagesBefore: page.before,
        ...(page.after === null ? {} : { messagesAfter: page.after }),
        ...(tail !== null ? { messagesFrom: params.after } : {}), ...(proof ? { messagesSync: proof } : {}), ...(unchanged ? { messagesUnchanged: true as const } : {}) };
      if (!params.open) return pagingReply(snapshot);
      ctx.bus.subscribed.add(thread.id);
      ctx.bus.transport = { compactTools: params.compactTools, compactToolParts: params.compactToolParts };
      if (params.open.previous && params.open.previous !== thread.id) ctx.bus.subscribed.delete(params.open.previous);
      if (params.open.markRead && thread.unread) { thread.unread = false; ctx.touch(thread); }
      snapshot.unread = thread.unread;
      const opened = params.open.requests === false ? {} : {
        permissions: [...ctx.pendingPermissions.values()].map(item => item.request).filter(item => item.threadId === thread.id).sort((a, b) => a.createdAt - b.createdAt),
        questions: [...ctx.pendingQuestions.values()].map(item => item.request).filter(item => item.threadId === thread.id).sort((a, b) => a.createdAt - b.createdAt)
      };
      return pagingReply({ ...snapshot, opened });
    },
    'messages.list': async (params) => {
      const thread = ctx.thread(params.threadId);
      const cursor = params.before ?? params.after;
      if ((params.before === undefined) === (params.after === undefined)) throw refusal('messages.list takes exactly one cursor: before, for older messages, or after, for newer ones');
      const at = thread.messages.findIndex((message) => message.id === cursor);
      if (at < 0) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `message ${cursor} is not a message of thread ${params.threadId}`,
          data: { threadId: params.threadId, ...(params.before === undefined ? { after: cursor } : { before: cursor }) }
        });
      }
      const asked = params.limit ?? MESSAGE_PAGE;
      const limit = Math.min(Math.max(1, Math.trunc(asked)), MESSAGE_PAGE_MAX);
      const project = projection(params);
      const page = params.before === undefined ? { ...forwardOf(thread.messages, at + 1, limit, project), before: null } : pageOf(thread.messages, at, limit, project);
      page.messages = forTransport(page.messages, params);
      const turns = new Set(page.messages.map((message) => message.turnId));
      return pagingReply({ ...page, turns: thread.turns.filter((turn) => turns.has(turn.id)) });
    },
    'messages.toolOutput': async (params) => ({ output: toolOf(ctx.thread(params.threadId), params).output }),
    'messages.toolPart': async (params) => pagingReply({ part: toolOf(ctx.thread(params.threadId), params) }),
    'messages.attachment': async params => {
      const thread = ctx.thread(params.threadId);
      if (!Number.isSafeInteger(params.partIndex) || params.partIndex < 0) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'messages.attachment.partIndex: expected a nonnegative integer', data: { field: 'partIndex', expected: 'a nonnegative integer' } });
      const message = thread.messages.find(message => message.id === params.messageId);
      if (!message) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `message ${params.messageId} is not a message of thread ${params.threadId}`, data: { threadId: params.threadId, messageId: params.messageId } });
      const part = message.parts[params.partIndex];
      if (part?.type !== 'file' && part?.type !== 'image') throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `part ${params.partIndex} is not an attachment of message ${params.messageId}`, data: { messageId: params.messageId, partIndex: params.partIndex } });
      return { data: part.data };
    },
    'threads.update': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
      }
      const nextAccountId = params.accountId ?? thread.accountId;
      const nextProviderId = ctx.accounts.find(a => a.id === nextAccountId)?.providerId ?? thread.providerId;
      const changedModel = (params.model !== undefined && params.model !== thread.model) || nextAccountId !== thread.accountId;
      const provider = ctx.providers.find(p => p.id === nextProviderId);
      const model = params.model === undefined ? nextAccountId !== thread.accountId && provider ? defaultModel(provider) : thread.model : params.model;
      const effort = params.effort === undefined ? changedModel ? null : thread.effort : params.effort;
      const speed = params.speed === undefined ? changedModel ? null : thread.speed ?? null : params.speed;
      const version = thread.selectionVersion ?? 0;
      if (changedModel || effort !== thread.effort || speed !== (thread.speed ?? null)) {
        await discoverSelection(ctx, nextProviderId, nextAccountId, model, effort, speed);
      }
      if (ctx.threads.get(thread.id) !== thread) throw ctx.notFound('thread', thread.id);
      if (version !== (thread.selectionVersion ?? 0)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
      if (changedModel || speed !== (thread.speed ?? null)) checkSpeed(ctx, nextProviderId, nextAccountId, model, speed);
      checkSelection(ctx, thread, params);
      const before = [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0');
      if (params.accountId !== undefined && params.accountId !== thread.accountId) {
        const account = ctx.accounts.find((entry) => entry.id === params.accountId);
        const provider = account && ctx.providers.find((entry) => entry.id === account.providerId);
        if (!account || !provider?.available || account.status === 'unauthenticated') {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the selected account is unavailable' });
        }
        if (thread.background?.length) ctx.setBackground(thread, [], 'session-ended');
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
        thread.titleState = { version: (thread.titleState?.version ?? 0) + 1, needsRefinement: false };
      }
      if (params.model !== undefined && params.model !== thread.model) { thread.model = params.model; thread.effort = null; thread.speed = null; }
      if (params.effort !== undefined) thread.effort = params.effort;
      if (params.speed !== undefined) thread.speed = params.speed;
      if (params.permissionMode !== undefined) {
        thread.permissionMode = params.permissionMode;
        for (const turn of thread.turns) {
          if (turn.status === 'running' && turn.execution) turn.execution.permissionMode = params.permissionMode;
        }
        const decision = params.permissionMode === 'bypassPermissions' || params.permissionMode === 'yolo' ? 'allow'
          : params.permissionMode === 'plan' || params.permissionMode === 'dontAsk' ? 'deny' : null;
        if (decision) for (const [id, pending] of ctx.pendingPermissions) {
          if (pending.request.threadId !== thread.id) continue;
          ctx.pendingPermissions.delete(id);
          pending.resolve(decision);
        }
      }
      if (before !== [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0')) thread.selectionVersion = (thread.selectionVersion ?? 0) + 1;
      return ctx.touch(thread);
    },
    'threads.retitle': async (params) => writeTitle(ctx, ctx.thread(params.threadId)),
    'threads.archive': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (params.archived !== false && params.onlyIfIdle === true) assertIdleFamily(ctx, thread.id);
      if (params.archived === false && removing.has(thread.id)) throw refusal('threadId: this conversation is being deleted', { threadId: thread.id, field: 'threadId', expected: 'a conversation not being deleted' });
      if (params.archived === false) dismissMergedPr(ctx, thread.id);
      const was = thread.archived;
      thread.archived = params.archived ?? true;
      thread.doneAt = thread.archived && params.onlyIfIdle === true ? thread.doneAt ?? Date.now() : null;
      if (thread.archived) {
        delete thread.archiveReason;
        cancelFamilySideQuestions(ctx, thread.id);
        const family = [...ctx.threads.values()].filter(member => member.id === thread.id || member.parentThreadId === thread.id);
        await Promise.all(family.map(member => putAway(ctx, member)));
        // A restore during the stops keeps processes; new child work keeps its own.
        if (ctx.threads.get(thread.id) === thread && thread.archived && !removing.has(thread.id)) {
          for (const member of family) {
            if (ctx.threads.get(member.id) !== member || ctx.inFlight.has(member.id)
              || ['queued', 'running', 'waiting'].includes(member.status)) continue;
            let ended = false;
            for (const record of ctx.processes) {
              if (record.threadId !== member.id || record.exitedAt !== null) continue;
              record.exitedAt = ctx.now();
              record.exitCode = 1;
              ended = true;
              ctx.emitToThread(member.id, 'process.exited', structuredClone(record));
            }
            if (ended) {
              member.load = null;
              if (member !== thread) ctx.touch(member);
            }
          }
        }
      }
      const summary = ctx.touch(thread);
      if (was !== thread.archived && !thread.parentThreadId && thread.projectId !== null) announceProject(ctx, thread.projectId);
      return summary;
    },
    'threads.remove': async ({ threadId }) => {
      const root = ctx.thread(threadId);
      if (root.agentSessionId || root.parentThreadId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'threadId: expected a top-level conversation without agentSessionId', data: { threadId, field: 'threadId', expected: 'a top-level conversation without agentSessionId' } });
      if (removing.has(threadId)) throw refusal('threadId: this conversation is already being deleted', { threadId, field: 'threadId', expected: 'a conversation not being deleted' });
      const family = [...ctx.threads.values()].filter(t => t.id === threadId || t.parentThreadId === threadId);
      const archived = family.map(t => t.archived);
      for (const thread of family) { removing.add(thread.id); thread.archived = true; thread.doneAt = null; }
      try {
        cancelFamilySideQuestions(ctx, threadId);
        ctx.workflows.stopRoot(threadId, 'Conversation deleted');
        for (const thread of family) {
          await putAway(ctx, thread);
          ctx.touch(thread);
        }
        for (const thread of family) {
          ctx.threads.delete(thread.id);
          clearTimeout(ctx.activityTimers.get(thread.id));
          ctx.activityTimers.delete(thread.id);
          ctx.emit('thread.removed', { threadId: thread.id, undoable: !root.incognito });
        }
        // As the core: an incognito conversation is erased, with nothing to restore.
        if (!root.incognito) {
          ctx.deletedThreads.set(threadId, { threads: family, archived, deletedAt: Date.now() });
          ctx.emit('thread.deletionsUpdated', {});
        }
        if (root.projectId !== null) announceProject(ctx, root.projectId);
        return { ok: true };
      } finally {
        for (const thread of family) removing.delete(thread.id);
      }
    },
    'threads.deleted': async () => {
      purgeDeletedThreads(ctx);
      return [...ctx.deletedThreads.values()].reverse().map(family => ({ ...structuredClone(toSummary(family.threads[0]!)), deletedAt: family.deletedAt }));
    },
    'threads.restore': async ({ threadId }) => {
      purgeDeletedThreads(ctx);
      const family = ctx.deletedThreads.get(threadId);
      if (!family) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `threadId: no recoverable deletion for ${threadId}`, data: { threadId } });
      const root = family.threads.find(t => t.id === threadId)!;
      if (root.projectId !== null && !ctx.projects.some(p => p.id === root.projectId)) throw ctx.notFound('project', root.projectId);
      for (const [index, thread] of family.threads.entries()) {
        thread.archived = family.archived[index]!;
        ctx.threads.set(thread.id, thread);
        ctx.emit('thread.created', structuredClone(toSummary(thread)));
      }
      ctx.deletedThreads.delete(threadId);
      ctx.emit('thread.deletionsUpdated', {});
      if (root.projectId !== null) announceProject(ctx, root.projectId);
      return structuredClone(toSummary(root));
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
    'turns.steer': async params => steerUser(ctx, params),
    'threads.focus': async (params) => {
      if (params.threadId !== null && (typeof params.threadId !== 'string' || params.threadId.length === 0)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'threadId must be a nonempty thread id or null', data: { field: 'threadId' } });
      }
      const protectionError = protectedThreadIdsError(params.protectedThreadIds);
      if (protectionError) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: protectionError, data: { field: 'protectedThreadIds', expected: 'at most 256 nonempty thread ids' } });
      if (params.protectAllThreads !== undefined && typeof params.protectAllThreads !== 'boolean') {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'protectAllThreads must be a boolean', data: { field: 'protectAllThreads', expected: 'boolean' } });
      }
      if (params.attentive !== undefined && typeof params.attentive !== 'boolean') {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'attentive must be a boolean', data: { field: 'attentive', expected: 'boolean' } });
      }
      if (params.idleMs !== undefined && (typeof params.idleMs !== 'number' || !Number.isFinite(params.idleMs) || params.idleMs < 0)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'idleMs must be a nonnegative number of milliseconds', data: { field: 'idleMs', expected: 'a finite number >= 0' } });
      }
      if (params.threadId !== null) ctx.thread(params.threadId);
      const reportsProtection = params.protectedThreadIds !== undefined || params.protectAllThreads !== undefined;
      if (!ctx.bus.protectionReported) {
        if (reportsProtection) ctx.bus.protectAllThreads = false;
        else ctx.bus.protectAllThreads = true;
        if (reportsProtection) ctx.bus.protectionReported = true;
      }
      if (params.protectedThreadIds !== undefined) ctx.bus.protectedThreadIds = new Set(params.protectedThreadIds);
      if (params.protectAllThreads !== undefined) ctx.bus.protectAllThreads = params.protectAllThreads;
      ctx.bus.focusedThreadId = params.threadId;
      // No push here: being looked at silences only the real core's Web Push.
      return { ok: true };
    },
    'turns.start': async (params) => {
      if (ctx.thread(params.threadId).agentSessionId) throw refusal('persistent agent sessions accept work through Agents');
      requireFakeCwd(ctx, ctx.thread(params.threadId));
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
        if (!account) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'accountId: the account of this conversation was removed; choose another account in it first', data: { threadId: thread.id, accountId: thread.accountId, field: 'accountId', expected: 'an existing account' } });
        checkRunnable(provider, account);
      }
      const error = attachmentError(params.attachments ?? [], provider);
      if (error) throw new RpcFailure({ code: RpcErrorCode.Refused, ...error });
      const rootId = thread.parentThreadId;
      if (rootId) {
        const config = delegationConfig(ctx, rootId);
        if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
      }
      const messageIndex = thread.messages.length;
      const turn = ctx.startTurn(params.threadId, params.prompt, params.attachments ?? [], rootId ? 'delegation' : undefined, undefined, undefined, params.previewReferences ?? []);
      if (rootId) ctx.delegationTurns.set(rootId, (ctx.delegationTurns.get(rootId) ?? 0) + 1);
      if (key) ctx.turnRequests.set(key, { content, turn, messageId: thread.messages[messageIndex]!.id });
      return turn;
    },
    'threads.compact': async (params) => {
      const thread = ctx.thread(params.threadId);
      requireFakeCwd(ctx, thread);
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed' });
      if (!thread.sessionId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread has no native session to compact' });
      if (ctx.providers.find((p) => p.id === thread.providerId)?.protocol === 'acp' && !thread.commands.some((c) => c.name === 'compact')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this agent has not advertised a compact command' });
      if (ctx.providers.find((p) => p.id === thread.providerId)?.protocol === 'agy') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the Antigravity CLI takes no /compact in print mode' });
      return ctx.startTurn(params.threadId, '[compact]', [], 'compact');
    },
    // The core's `threads/branching.ts`: the same refusals, by field. The fake
    // has no native transcript, so every rewind and fork is the seeded path.
    'threads.rewind': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.agentSessionId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a persistent agent session takes its work through Agents and cannot be rewound', data: { threadId: thread.id, field: 'threadId', expected: 'a conversation thread' } });
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot rewind an archived thread', data: { threadId: thread.id, field: 'threadId', expected: 'a thread that is not archived' } });
      if (['queued', 'running', 'waiting'].includes(thread.status) || ctx.inFlight.has(thread.id)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread has a turn running or queued; stop it before editing a message', data: { threadId: thread.id, reason: 'turn-in-flight', status: thread.status, expected: 'an idle thread' } });
      }
      const at = thread.messages.findIndex((message) => message.id === params.messageId);
      const message = thread.messages[at];
      if (!message) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `message ${params.messageId} is not a message of thread ${thread.id}`, data: { threadId: thread.id, field: 'messageId', messageId: params.messageId, expected: 'a user message of this thread' } });
      if (message.role !== 'user') throw new RpcFailure({ code: RpcErrorCode.Refused, message: `message ${params.messageId} is a ${message.role} message; only a message the user sent can be edited`, data: { threadId: thread.id, field: 'messageId', messageId: params.messageId, role: message.role, expected: 'user' } });
      const removed = thread.messages.splice(at);
      // The notes to the agent went with removed messages: the next one says it
      // again, from where the kept history left the agent to where the thread is now.
      const moved = removed.flatMap((entry) => entry.parts).find((part) => part.type === 'text' && part.moved !== undefined);
      if (moved?.type === 'text' && moved.moved) {
        const origin = moved.moved.from;
        const here: MoveEnd = { projectId: thread.projectId ?? '', name: ctx.projects.find((p) => p.id === thread.projectId)?.name ?? thread.projectId ?? '', cwd: thread.cwd };
        thread.moveNote = origin.cwd === here.cwd ? null : { from: origin, to: here, note: fakeMoveNote(origin, here, thread.branch), at: ctx.now() };
      }
      const gone = new Set(removed.map((entry) => entry.id));
      const kept = new Set(thread.messages.map(entry => entry.turnId));
      thread.turns = thread.turns.filter((turn) => kept.has(turn.id));
      for (const [key, request] of ctx.turnRequests) {
        if (key.startsWith(`${thread.id}:`) && gone.has(request.messageId)) ctx.turnRequests.delete(key);
      }
      thread.sessionId = null;
      thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
      thread.context = null;
      thread.promptCache = null;
      ctx.emitToThread(thread.id, 'message.truncated', { threadId: thread.id, messageId: message.id });
      ctx.touch(thread);
      let prompt = '';
      const attachments: Attachment[] = [];
      const previewReferences: PreviewReference[] = [];
      for (const part of message.parts) {
        if (part.type === 'text') {
          prompt += part.displayText ?? part.text;
          previewReferences.push(...(part.previewReferences ?? []));
        } else if (part.type === 'image') attachments.push({ kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt });
        else if (part.type === 'file') attachments.push({ kind: 'file', mimeType: part.mimeType, data: part.data, name: part.name });
      }
      const page = pageOf(thread.messages, thread.messages.length, MESSAGE_PAGE);
      return pagingReply({ thread: { ...thread, messages: page.messages, messagesBefore: page.before }, prompt, attachments, previewReferences, session: 'seeded' as const, files: { status: 'unchanged' as const, count: 0 } });
    },
    'threads.fork': async (params) => {
      const source = ctx.thread(params.threadId);
      if (source.agentSessionId || source.projectId === null) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a persistent agent session takes its work through Agents and cannot be forked', data: { threadId: source.id, field: 'threadId', expected: 'a conversation thread' } });
      if (source.incognito) throw refusal('an incognito conversation cannot be forked: a copy would outlive it', { threadId: source.id, field: 'threadId', expected: 'a conversation that is not incognito' });
      const at = source.messages.findIndex((message) => message.id === params.messageId);
      const target = source.messages[at];
      if (!target) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `message ${params.messageId} is not a message of thread ${source.id}`, data: { threadId: source.id, field: 'messageId', messageId: params.messageId, expected: 'a message of this thread' } });
      if (target.state === 'streaming') throw new RpcFailure({ code: RpcErrorCode.Refused, message: `message ${params.messageId} is still being written; fork once it is complete`, data: { threadId: source.id, field: 'messageId', messageId: params.messageId, expected: 'a finished message' } });
      const project = ctx.projects.find((p) => p.id === source.projectId);
      if (!project) throw ctx.notFound('project', source.projectId);
      if (params.worktree === true && project.kind === 'drafts') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a draft has no worktree: the drafts folder is not a git repository', data: { projectId: project.id, field: 'worktree', expected: false } });
      const title = `${source.title} (fork)`;
      const placed = params.worktree === true ? fakeWorktree(project.path, title, undefined, ctx.settings.worktreeStorage, project.id) : null;
      if (placed) registerFakeWorktree(ctx, project.id, placed);
      return writeFakeFork(ctx, source, source.messages.slice(0, at + 1), placed);
    },
    'turns.stop': async (params) => {
      const thread = ctx.thread(params.threadId);
      const root = thread.parentThreadId ?? thread.id;
      let childrenStopped = 0;
      if (thread.parentThreadId || (ctx.delegationAgents.get(root)?.length ?? 0) > 0) {
        childrenStopped = await stopDelegation(ctx, root, thread.parentThreadId ? thread.id : undefined);
        ctx.emit('delegation.changed', { threadId: root });
      }
      if (!thread.parentThreadId) ctx.workflows.stopRoot(thread.id, 'Stopped with its thread');
      const stopped = await ctx.stopTurn(params.threadId) || childrenStopped > 0;
      // As the core: Stop on an idle thread ends what it still runs in the background.
      if (!stopped && (thread.background?.length ?? 0) > 0) {
        ctx.setBackground(thread, [], 'session-ended');
        return { stopped: true };
      }
      return { stopped };
    },
    'turns.recover': params => recoverTurn(ctx, params),
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
