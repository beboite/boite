import { stat } from 'node:fs/promises';
import type { AccountId, ProviderId, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, refused } from '../errors.ts';
import type { ProviderProbe } from '../providers/probe.ts';
import { defaultModel, needsModelDiscovery } from './selection.ts';
import { LinkedPullRequests } from '../linked-pull-requests.ts';
import { threadCapabilities } from './capabilities.ts';
import { steerUser } from './user-steering.ts';
import { readToolOutput } from './records.ts';

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

export function registerThreadMethods(core: Core, probe: ProviderProbe): void {
  async function discover(providerId: ProviderId, accountId: AccountId, model: string | null, effort: string | null, speed: string | null): Promise<void> {
    const provider = core.providers.require(providerId);
    const account = core.accounts.require(accountId);
    if (account.providerId !== provider.id) throw refused('the account belongs to another provider', { accountId, providerId, accountProviderId: account.providerId });
    if (needsModelDiscovery(provider, accountId, model, effort, speed)) {
      await probe({ providerId, accountId, ...(provider.protocol === 'acp' && model !== null && effort !== null ? { model } : {}) });
    }
  }
  core.router.register('threads.btw', async params => {
    await requireCwd(core, params.threadId);
    return core.threads.sideQuestions.ask(params.threadId, params.question, params.requestId);
  });
  core.router.register('threads.btw.fork', async params => {
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
  const pullRequests = core.pullRequests;
  const linked = new LinkedPullRequests(core, (threadId, url) => pullRequests.detail(threadId, url));
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
  core.router.register('threads.compact', async (params) => {
    await requireCwd(core, params.threadId);
    return core.threads.compact(params.threadId, params.expectedSelectionVersion);
  });
  core.router.register('threads.rewind', (params) => core.threads.rewind(params.threadId, params.messageId));
  core.router.register('threads.mergeBack', params => core.threads.branching.mergeBack(params));
  core.router.register('threads.fork', (params) => core.threads.fork(params.threadId, params.messageId, params.worktree === true));
  core.router.register('threads.list', (params) => core.threads.list(params));
  core.router.register('threads.create', async (params) => {
    // A thread made in a folder that is gone could never run a turn: refused here, by the folder.
    const project = core.projects.require(params.projectId);
    await core.projects.requireFolder(project.id);
    const provider = core.providers.require(params.providerId);
    await discover(provider.id, params.accountId, params.model ?? defaultModel(provider), params.effort ?? null, params.speed ?? null);
    return params.worktree === undefined ? core.threads.create(params) : core.threads.createInWorktree(params);
  });
  core.router.register('threads.get', (params) => core.threads.get(params.threadId, params.after, params));
  core.router.register('messages.list', (params) => core.threads.messages(params));
  core.router.register('messages.toolOutput', (params) => readToolOutput(core, params));
  core.router.register('threads.update', async (params) => {
    const thread = core.threads.require(params.threadId);
    const version = thread.selectionVersion ?? 0;
    if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== version) return core.threads.update(params);
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
    core.threads.focus.set(ctx.connection.id, params.threadId, params.protectedThreadIds, params.protectAllThreads);
    return { ok: true } as const;
  });
  core.router.register('turns.start', async (params) => {
    await requireCwd(core, params.threadId);
    return core.threads.startTurn(params.threadId, params.prompt, params.attachments ?? [], params.expectedSelectionVersion, undefined, undefined, params.clientRequestId, undefined, params.previewReferences ?? []);
  });
  core.router.register('turns.stop', (params) => {
    core.activity.pauseAll(params.threadId);
    return { stopped: core.threads.stopTurn(params.threadId) };
  });
  core.router.register('turns.recover', async params => {
    if (params.action === 'resume') await requireCwd(core, params.threadId);
    return core.threads.recoverTurn(params);
  });
  core.router.register('turns.steer', params => steerUser(core, core.threads, params));
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
    });
    return { ok: true } as const;
  });
}
