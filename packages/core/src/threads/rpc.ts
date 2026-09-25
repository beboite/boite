import type { Core } from '../core.ts';
import { PullRequests } from '../pull-requests.ts';

export function registerThreadMethods(core: Core): void {
  const pullRequests = new PullRequests(core);
  core.router.register('threads.pullRequest', params => pullRequests.read(params.threadId, params.refresh === true));
  core.router.register('threads.compact', (params) => core.threads.compact(params.threadId, params.expectedSelectionVersion));
  core.router.register('threads.list', (params) => core.threads.list(params));
  core.router.register('threads.create', (params) =>
    params.worktree === undefined ? core.threads.create(params) : core.threads.createInWorktree(params),
  );
  core.router.register('threads.get', (params) => core.threads.get(params.threadId, params.after));
  core.router.register('messages.list', (params) => core.threads.messages(params));
  core.router.register('threads.update', (params) => core.threads.update(params));
  core.router.register('threads.retitle', (params) => core.threads.retitle(params.threadId));
  core.router.register('threads.archive', (params) =>
    core.threads.archive(params.threadId, params.archived !== false),
  );
  core.router.register('threads.pin', (params) => core.threads.pin(params.threadId, params.pinned !== false));
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
  core.router.register('turns.start', (params) =>
    core.threads.startTurn(params.threadId, params.prompt, params.attachments ?? [], params.expectedSelectionVersion, undefined, undefined, params.clientRequestId, undefined, params.previewReferences ?? []),
  );
  core.router.register('turns.stop', (params) => {
    core.activity.pauseAll(params.threadId);
    return { stopped: core.threads.stopTurn(params.threadId) };
  });
  core.router.register('permissions.list', (params) => core.threads.listPermissions(params.threadId));
  core.router.register('permissions.answer', (params) => {
    core.threads.answerPermission({ requestId: params.requestId, decision: params.decision });
    return { ok: true } as const;
  });
  core.router.register('questions.list', (params) => core.threads.listQuestions(params.threadId));
  core.router.register('questions.ask', (params) => core.threads.askAsync(params));
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
