import { stat } from 'node:fs/promises';
import { pullRequestAddress, type AccountId, type ProviderId, type ThreadId } from '@boite/contracts';
import type { Connection } from '../router.ts';
import type { Core } from '../core.ts';
import { promptOrigin } from '../client-preferences.ts';
import { invalidParams, refused } from '../errors.ts';
import { requireAgent } from './agentless.ts';
import type { ProviderProbe } from '../providers/probe.ts';
import { defaultModel, needsModelDiscovery } from './selection.ts';
import { LinkedPullRequests } from '../linked-pull-requests.ts';
import { threadCapabilities } from './capabilities.ts';
import { agentShape } from './agent-shape.ts';
import { steerUser } from './user-steering.ts';
import { startsAutoGoal } from '../composer-activity.ts';
import { readToolOutput, readToolPart } from './records.ts';
import { readMessageAttachment } from './attachment-read.ts';
import { CreationRequests } from './creation-requests.ts';
import { trustLetters } from '../contacts/letter-scopes.ts';

/**
 * A turn in a folder that is gone is refused by that folder. An archived
 * thread keeps its `cwd` when its worktree is removed; restored, its next turn
 * would otherwise start an agent in nothing (the echo driver answered as if all
 * were well). Checked off the event loop, so a share whose host is gone stalls
 * this call only. An archived thread gets its own refusal from `startTurn`.
 */
async function requireCwd(core: Core, threadId: ThreadId): Promise<void> {
  const thread = core.threads.require(threadId);
  if (thread.archived) return;
  // The project's own folder is asked too, beside this turn: gone or put back, every client hears it.
  if (thread.projectId !== null) void core.projects.requireFolder(thread.projectId).catch(() => undefined);
  const present = await stat(thread.cwd).then((found) => found.isDirectory(), () => false);
  if (!present) {
    throw refused(`the folder ${thread.cwd} this thread works in does not exist any more: its worktree was removed or the folder moved`, {
      threadId, cwd: thread.cwd, field: 'cwd', expected: 'an existing folder',
    });
  }
}

/** `12` or `#12`, else null. */
function pullRequestNumber(input: string): number | null {
  const match = /^#?([1-9]\d{0,9})$/.exec(input.trim());
  return match ? Number(match[1]) : null;
}

/**
 * The pull request `boite pr watch` names: a linked one by URL or number, a
 * new URL linked first (which checks it on GitHub), or with nothing named
 * the conversation's only linked one, or its only open one.
 */
async function watchTarget(linked: LinkedPullRequests, threadId: ThreadId, input: string | undefined): Promise<string> {
  const saved = linked.saved(threadId);
  const listed = saved.map(pr => pr.url).join(', ');
  if (input === undefined) {
    const open = saved.filter(pr => pr.state === 'OPEN');
    const only = saved.length === 1 ? saved[0] : open.length === 1 ? open[0] : undefined;
    if (only) return only.url;
    throw refused(saved.length ? `this conversation links several pull requests (${listed}); name the one to watch` : 'this conversation has no linked pull request: run boite pr link <url> first, or name its URL', { field: 'url', expected: 'a pull request URL or number' });
  }
  const number = pullRequestNumber(input);
  if (number !== null) {
    const matches = saved.filter(pr => pr.number === number);
    if (matches.length === 1) return matches[0]!.url;
    throw refused(matches.length ? `several linked pull requests are #${number}; name it by URL` : `no linked pull request is #${number}; name its URL to link and watch it`, { field: 'url', expected: listed || 'a pull request URL' });
  }
  const { url } = pullRequestAddress(input);
  if (!saved.some(pr => pr.url.toLowerCase() === url.toLowerCase())) await linked.link(threadId, url);
  return url;
}

export function registerThreadMethods(core: Core, probe: ProviderProbe): void {
  const creations = new CreationRequests();
  async function discover(providerId: ProviderId, accountId: AccountId, model: string | null, effort: string | null, speed: string | null): Promise<void> {
    const provider = core.providers.require(providerId);
    const account = core.accounts.require(accountId);
    if (account.providerId !== provider.id) throw refused('the account belongs to another provider', { accountId, providerId, accountProviderId: account.providerId });
    if (needsModelDiscovery(provider, accountId, model, effort, speed)) {
      await probe({ providerId, accountId, ...(provider.protocol === 'acp' && model !== null && effort !== null ? { model } : {}) });
    }
  }
  core.router.register('threads.btw', async params => {
    requireAgent(core.threads, params.threadId);
    await requireCwd(core, params.threadId);
    return core.threads.sideQuestions.ask(params.threadId, params.question, params.requestId);
  });
  core.router.register('threads.btw.fork', async params => {
    requireAgent(core.threads, params.threadId);
    await requireCwd(core, params.threadId);
    return core.threads.sideQuestions.fork(params.threadId, params.requestId);
  });
  core.router.register('threads.btw.cancel', params => {
    if (typeof params.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(params.requestId)) throw invalidParams('threads.btw.cancel.requestId: expected 8 to 128 URL-safe characters');
    core.threads.require(params.threadId);
    core.threads.sideQuestions.cancel(params.threadId, params.requestId);
    return { ok: true };
  });
  core.router.register('threads.capabilities', params => threadCapabilities(core, params.threadId));
  core.router.register('threads.agentShape', params => agentShape(core, params.threadId));
  const pullRequests = core.pullRequests;
  const linked = core.linkedPullRequests;
  core.router.register('threads.pullRequestReview', async p => {
    const url = linked.requireLink(p.threadId, p.url), result = await pullRequests.reviews.review(p.threadId, url);
    linked.requireLink(p.threadId, url); return result;
  });
  core.router.register('threads.pullRequestFiles', async p => {
    const url = linked.requireLink(p.threadId, p.url), result = await pullRequests.reviews.files(p.threadId, url, p.page);
    linked.requireLink(p.threadId, url); return result;
  });
  core.router.register('threads.pullRequests', p => linked.list(p.threadId, p.refresh === true));
  core.router.register('threads.linkPullRequest', p => linked.link(p.threadId, p.url));
  core.router.register('threads.unlinkPullRequest', p => linked.unlink(p.threadId, p.url));
  core.router.register('threads.pullRequest', params => pullRequests.read(params.threadId, params.refresh === true));
  core.router.register('threads.watchPullRequest', async p => core.pullRequestWatches.watch(p.threadId, await watchTarget(linked, p.threadId, p.url)));
  core.router.register('threads.unwatchPullRequest', p => {
    if (p.url === undefined) return core.pullRequestWatches.unwatch(p.threadId);
    const number = pullRequestNumber(p.url);
    const watched = core.pullRequestWatches.of(p.threadId);
    const matches = number === null ? [] : watched.filter(watch => watch.number === number);
    if (number !== null && matches.length !== 1) throw refused(matches.length ? `several watched pull requests are #${number}; name it by URL` : `this conversation does not watch #${number}`, { field: 'url', expected: watched.map(watch => watch.url).join(', ') || 'a watched pull request' });
    return core.pullRequestWatches.unwatch(p.threadId, matches[0]?.url ?? p.url);
  });
  core.router.register('threads.compact', async (params) => {
    await requireCwd(core, params.threadId);
    return core.threads.compact(params.threadId, params.expectedSelectionVersion);
  });
  core.router.register('threads.rewind', (params) => core.threads.rewind(params.threadId, params.messageId));
  core.router.register('threads.mergeBack', params => core.threads.branching.mergeBack(params));
  core.router.register('threads.fork', (params) => core.threads.fork(params.threadId, params.messageId, params.worktree === true));
  core.router.register('threads.list', (params) => core.threads.list(params));
  core.router.register('threads.listChanges', (params) => core.threads.listLog.answer(params));
  core.router.register('drafts.prepare', (params, ctx) => core.drafts.prepare(ctx.connection.id, params));
  core.router.register('drafts.release', async (params, ctx) => {
    await core.drafts.release(ctx.connection.id, params.preparationId);
    return { ok: true };
  });
  core.router.register('attachments.upload', (params, ctx) => core.attachmentUploads.upload(ctx.connection.id, params.attachment));
  core.router.register('attachments.release', async (params, ctx) => {
    await core.attachmentUploads.release(ctx.connection.id, params.ids);
    return { ok: true };
  });
  core.router.register('threads.create', async (params, ctx) => {
    const thread = await creations.once(params, async () => {
      // A thread made in a folder that is gone could never run a turn: refused here, by the folder.
      const project = core.projects.require(params.projectId);
      await core.projects.requireFolder(project.id);
      const provider = core.providers.require(params.providerId);
      await discover(provider.id, params.accountId, params.model ?? defaultModel(provider), params.effort ?? null, params.speed ?? null);
      const adopted = await core.drafts.claim(ctx.connection.id, params);
      return adopted ?? (params.worktree === undefined ? core.threads.create(params) : await core.threads.createInWorktree(params));
    }, threadId => core.journal.getThread(threadId));
    if (params.subscribe === true) ctx.connection.subscriptions.add(thread.id);
    return thread;
  });
  // Projection queues missing image previews without delaying the snapshot or its subscription.
  core.router.register('threads.get', (params, ctx) => {
    const thread = core.threads.get(params.threadId, params.after, params);
    if (!params.open) return thread;
    ctx.connection.subscriptions.add(params.threadId);
    // Live tool parts, files and pictures reach this socket the way its pages do.
    ctx.connection.transport = { compactTools: params.compactTools, compactToolParts: params.compactToolParts, compactFiles: params.compactFiles, compactImages: params.compactImages };
    if (params.open.previous && params.open.previous !== params.threadId) ctx.connection.subscriptions.delete(params.open.previous);
    if (params.open.markRead) { core.threads.markRead(params.threadId); thread.unread = false; }
    return { ...thread, opened: params.open.requests === false ? {} : {
      permissions: core.threads.listPermissions(params.threadId), questions: core.threads.listQuestions(params.threadId)
    } };
  });
  core.router.register('messages.list', params => core.threads.messages(params));
  core.router.register('messages.toolOutput', (params) => readToolOutput(core, params));
  core.router.register('messages.toolPart', (params) => readToolPart(core, params));
  core.router.register('messages.attachment', params => readMessageAttachment(core, params));
  core.router.register('threads.update', async (params) => {
    const thread = requireAgent(core.threads, params.threadId);
    const version = thread.selectionVersion ?? 0;
    if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== version) return core.threads.update(params);
    // Its account was removed: nothing to discover, and the store says what still changes.
    if (params.accountId === undefined && core.journal.getAccount(thread.accountId) === null) return core.threads.update(params);
    const account = core.accounts.require(params.accountId ?? thread.accountId);
    const provider = core.providers.require(account.providerId);
    const changedModel = account.id !== thread.accountId || (params.model !== undefined && params.model !== thread.model);
    const model = params.model === undefined ? account.id !== thread.accountId ? defaultModel(provider) : thread.model : params.model;
    const effort = params.effort === undefined ? changedModel ? null : thread.effort : params.effort;
    const speed = params.speed === undefined ? changedModel ? null : thread.speed ?? null : params.speed;
    if (changedModel || effort !== thread.effort || speed !== (thread.speed ?? null)) {
      await discover(provider.id, account.id, model, effort, speed);
    }
    // Discovery can yield to another client's selection; never overwrite that choice with stale metadata.
    return core.threads.update({ ...params, expectedSelectionVersion: params.expectedSelectionVersion ?? version });
  });
  core.router.register('threads.retitle', (params) => core.threads.retitle(params.threadId));
  core.router.register('threads.archive', (params) =>
    core.threads.archive(params.threadId, params.archived !== false, params.onlyIfIdle === true),
  );
  core.router.register('threads.remove', async (params) => {
    await core.threads.remove(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('threads.deleted', () => { core.threads.purgeDeleted(); return core.journal.listDeletedThreads(); });
  core.router.register('threads.restore', params => core.threads.restoreDeleted(params.threadId));
  core.router.register('threads.move', (params) => core.threads.move(params.threadId, params.projectId, params.stopBackground));
  core.router.register('threads.moveCancel', (params) => core.threads.moves.cancel(params.threadId));
  core.router.register('threads.pin',(params) => core.threads.pin(params.threadId, params.pinned !== false));
  core.router.register('threads.markRead', (params) => {
    core.threads.markRead(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('threads.trustContactHistory', (params) => {
    trustLetters(core, params.threadId);
    return { ok: true } as const;
  });
  core.router.register('threads.subscribe', (params, ctx) => {
    core.threads.require(params.threadId);
    ctx.connection.subscriptions.add(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('threads.unsubscribe', (params, ctx) => {
    ctx.connection.subscriptions.delete(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('threads.focus', (params, ctx) => {
    core.threads.focus.set(ctx.connection.id, params.threadId, params.protectedThreadIds, params.protectAllThreads, params.attentive, params.idleMs);
    if (params.threadId !== null) core.threads.autoCompact.shown(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('turns.start', async (params, ctx) => {
    await requireCwd(core, params.threadId);
    const attachments = await core.attachmentUploads.resolve(ctx.connection.id, params.attachments ?? [], params.attachmentIds);
    // A subagent put away as done takes a new prompt, as it takes a letter from its parent.
    const thread = core.threads.require(params.threadId);
    const preferences = core.clients.use(ctx.connection);
    const autoGoal = startsAutoGoal(params.prompt, preferences?.experiments, core.settings.get().autoGoalMinChars) ? params.prompt : undefined;
    const start = () => core.threads.startTurn(params.threadId, { prompt: params.prompt, attachments, previews: params.previewReferences ?? [] }, { kind: 'user', requestId: params.clientRequestId, sentFrom: promptOrigin(ctx.connection, preferences) }, { expectedSelectionVersion: params.expectedSelectionVersion, autoGoal });
    return core.delegation.retirements.revivable(thread) ? core.delegation.retirements.revive(thread, start) : start();
  });
  core.router.register('turns.stop', (params, ctx) => {
    const by = ctx.connection.identity.principal === 'agent' ? `agent of ${ctx.connection.identity.threadId}` : `${ctx.connection.identity.principal} from ${ctx.connection.sentFrom?.client ?? 'a client'}`;
    core.activity.pauseAll(params.threadId);
    // Stop ends what would wake the thread again, its pull request watches included.
    const unwatched = core.pullRequestWatches.endThread(params.threadId);
    const stopped = core.threads.stopTurn(params.threadId) || unwatched > 0;
    // After the stop, so an unknown thread (which throws) logs nothing, and with what it did.
    core.logs.info(`Stop requested by the ${by}: ${stopped ? 'a turn was stopped' : 'nothing was running'}`, { source: 'turns', event: 'turn.stop-asked', threadId: params.threadId, data: { principal: ctx.connection.identity.principal, client: ctx.connection.sentFrom?.client ?? null, stopped } });
    return { stopped };
  });
  core.router.register('turns.recover', async params => {
    if (params.action === 'resume') await requireCwd(core, params.threadId);
    return core.threads.recoverTurn(params);
  });
  core.router.register('turns.cancelRetry', (params) => ({ cancelled: core.threads.cancelRetry(params.threadId) }));
  core.router.register('turns.steer', (params, ctx) => steerUser(core, core.threads, params, promptOrigin(ctx.connection, core.clients.use(ctx.connection))));
  core.router.register('permissions.list', (params) => core.threads.listPermissions(params.threadId));
  core.router.register('permissions.answer', (params) => {
    core.threads.answerPermission({ requestId: params.requestId, decision: params.decision });
    return { ok: true } as const;
  });
  core.router.register('questions.list', (params) => core.threads.listQuestions(params.threadId));
  core.router.register('questions.ask', (params) => core.threads.askAsync(params));
  core.router.register('questions.skip', (params) => {
    core.threads.skipQuestion(params);
    return { ok: true } as const;
  });
  core.router.register('questions.answer', (params) => {
    core.threads.answerQuestion({
      threadId: params.threadId,
      questionId: params.questionId,
      optionIds: params.optionIds,
      ...(params.text === undefined ? {} : { text: params.text }),
      ...(params.attachments === undefined ? {} : { attachments: params.attachments }),
    });
    return { ok: true } as const;
  });
}
