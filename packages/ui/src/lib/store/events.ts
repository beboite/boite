import { TRACE_LIMIT, lastAgentText, requestExcerpt, requestKind, type ProviderInstallState, type RpcEventName, type ThreadId, type TurnId } from '@boite/contracts';
import type { Client, EventHandler } from '../client';
import { noteThisComputer } from '../device';
import { noteQuestionAsked } from '../question-reply.svelte';
import { finishNotifies } from '../notify';
import { upkeepOf } from '../agent-upkeep';
import { resetPullRequestSupport } from '../pull-request';
import { revealRequested } from '../reveal';
import { pointerRequested } from '../pointer-layout';
import { appUpdateRequested } from '../desktop-update.svelte';
import { rightPanel } from '../right-panel.svelte';
import { undo } from '../undo.svelte';
import { lastIndexById, patchFields, patchLoad } from '../thread-rows';
import { strings } from '../strings';
import { needsUser } from '../thread-state';
import { installStatesOf } from './accounts.svelte';
import { observable } from './connection.svelte';
import { reportPreferences } from '../client-preferences.svelte';
import { heardDesktop } from '../experiments';
import { lightPage } from './reading-pages.svelte';
import type { StoreContext } from './context';
import { probeKey } from './models.svelte';
import { sameProcess } from './workbench.svelte';

/**
 * Every event the core pushes, applied to the Store that owns `client`. The
 * handlers are registered in this order, and each one removed by `ctx.off`
 * when the Store detaches.
 */
export function listen(ctx: StoreContext, client: Client): void {
  const s = ctx.store;
  const generation = ctx.clientGeneration;
  const current = () => ctx.currentClient(client, generation);
  const { accounts, models, threads, requests, layout } = ctx;
  const on = <E extends RpcEventName>(event: E, handler: EventHandler<E>): void => {
    ctx.off.push(client.on(event, payload => { if (current()) handler(payload); }));
  };

  if (observable(client)) {
    ctx.off.push(
      client.onState((state) => {
        if (!current()) return;
        if (state !== 'ready') {
          ctx.connection.invalidateReads();
          ctx.draftStartup.reset();
          models.probeRequests.clear();
        }
        s.connection = state;
        ctx.connection.watchLocalCore(client, state);
        if (state === 'ready') {
          resetPullRequestSupport(client);
          models.probeEpoch++;
          models.probeAttempts.clear();
          models.forgetConfirmed();
          models.probeTimes.clear();
          models.effortAttempts.clear();
          s.error = null;
          s.core = client.core;
          ctx.connection.clockOffset = client.clockOffset ?? 0;
          if (ctx.connection.localCore) noteThisComputer(s.core?.hostname);
          undo.discardExpired(s, s.core?.startedAt);
          // `WsClient` writes its principal from the hello answer before it
          // reports `ready`, and this handler runs before `connect()` returns:
          // reading it here is what keeps the owner-only calls out of the very
          // first load, and what refreshes it after a reconnect.
          s.principal = client.principal;
          ctx.serverUpdater.reset();
          if (s.owner && !s.localCore) { void ctx.serverUpdater.freshen(); void ctx.serverUpdater.loadDesktop(); }
          void s.reload();
          // A reconnect also hydrates after a first hello that never reached connect()'s startup path.
          void ctx.connection.syncComposer(client, generation).catch(error => { if (current()) ctx.fail(error); });
          ctx.shared.reconnected();
          ctx.terminals.reconnected(client);
          if (!s.owner) layout.checkPushKinds(client);
        }
      })
    );
  }

  // After the state handler above, so a reconnect has its principal and core first.
  if (observable(client) && client.onClockOffset) ctx.off.push(client.onClockOffset((offset) => { if (current()) ctx.connection.clockOffset = offset; }));
  if (observable(client)) ctx.off.push(reportPreferences(client, current, experiments => heardDesktop(s, experiments, s.core?.coreId ?? null)));
  on('client.desktopExperiments', ({ experiments }) => heardDesktop(s, experiments, s.core?.coreId ?? null));

  on('core.updateChanged', snapshot => ctx.serverUpdater.apply(snapshot));
  on('composer.updated', record => ctx.sync.receive(record));
  on('core.desktopUpdateChanged', ({ status }) => { if (!s.localCore) ctx.serverUpdater.applyDesktop(status); });
  on('ui.appUpdate', ({ version }) => appUpdateRequested(s, version));

  // Rows are patched in place: a load tick on one running thread must not
  // hand the sidebar a new array and re-render every other row.
  // A shell that ended leaves its tab or split, shown or not.
  on('terminal.exited', ({ id }) => ctx.terminals.shellEnded(id));
  on('thread.created', (summary) => threads.upsertThread(summary));
  on('thread.updated', (summary) => {
    if (summary.archived) requests.dropSecretsOf(summary.id);
    const held = threads.rowOf(summary.id);
    const turnedToUser = needsUser(summary) && !(held && needsUser(held));
    threads.upsertThread(summary);
    ctx.delegation.patchThread(summary);
    const open = s.openThread;
    if (open && open.id === summary.id) patchFields(open, summary);
    // Archived from another client: nothing here can show it again.
    else if (summary.archived) threads.forgetThread(summary.id, summary.archiveReason?.type === 'pr-merged');
    if (s.delegationThread?.id === summary.id) patchFields(s.delegationThread, summary);
    // A sub-agent of the open thread now asks: its parent's dock reads what it asks.
    if (turnedToUser && open && summary.parentThreadId === open.id) requests.readChildren(client, open.id, summary.id);
  });
  // A load sample alone: every copy of the row this client holds takes the new load and nothing else.
  on('thread.load', ({ threadId, load }) => {
    const row = threads.rowOf(threadId);
    if (row) patchLoad(row, load);
    // A read in flight would land an older load over this one. It keeps the
    // load alone: the rest of its fresh row is newer than the row held here.
    ctx.threadReads.patch(threadId, { load });
    ctx.delegation.patchLoad(threadId, load);
    if (s.openThread?.id === threadId) patchLoad(s.openThread, load);
    if (s.delegationThread?.id === threadId) patchLoad(s.delegationThread, load);
  });
  // The agent's `/name` list is the whole list each time, and it lives on the
  // open thread only: a summary in the sidebar carries none.
  on('thread.commands', ({ threadId, commands }) => {
    const open = s.openThread;
    if (open && open.id === threadId) open.commands = commands;
    // A page a press loaded is the open thread a moment later (press-preload.ts).
    const preloaded = threads.preloads.thread(threadId);
    if (preloaded) preloaded.commands = commands;
  });
  // What the agent still runs in the background, whole each time, like the commands.
  on('thread.background', ({ threadId, tasks, history }) => {
    const open = s.openThread;
    if (open && open.id === threadId) {
      open.background = tasks;
      if (history) open.backgroundHistory = history;
    }
    const preloaded = threads.preloads.thread(threadId);
    if (preloaded) {
      preloaded.background = tasks;
      if (history) preloaded.backgroundHistory = history;
    }
  });
  on('thread.activity', ({ threadId, activity }) => {
    if (s.openThread?.id === threadId) s.openThread.activity = activity;
    const preloaded = threads.preloads.thread(threadId);
    if (preloaded) preloaded.activity = activity;
  });
  on('sharedProjects.changed', scope => ctx.shared.changed(scope));
  on('collaboration.changed', ({ threadId }) => {
    if (s.openThread?.id === threadId) void s.loadCoordination(threadId, false);
  });
  on('workflows.changed', ({ threadId }) => {
    const open = s.openThread;
    if (open && (threadId === open.id || threadId === open.parentThreadId)) void s.loadWorkflows(open.id);
  });
  on('delegation.changed', ({ threadId }) => {
    const open = s.openThread;
    const view = s.delegation;
    if (open && (threadId === open.id || threadId === open.parentThreadId || threadId === view?.rootThreadId)) {
      void s.loadDelegation(open.id);
    }
  });
  // The agent of a thread asked its panel for something. The layout is per
  // thread, so it is written on that thread's panel even while another one is
  // on screen: opening the thread later shows what was asked for.
  on('panel.requested', ({ threadId, surface }) => {
    if (surface.kind === 'browser' && surface.artifact && s.endpointUrl) {
      // The owning machine may have been reached through a LAN name different from the core's own.
      const url = new URL(surface.url);
      url.hostname = new URL(s.endpointUrl).hostname;
      url.port = String(surface.artifact.port);
      surface = { ...surface, url: url.href };
    }
    rightPanel.for(s.threadKey(threadId)).showSurface(surface);
  });
  // The project's whole list after any change, whoever moved a card.
  on('todos.updated', ({ projectId, todos }) => {
    s.todos = { ...s.todos, [projectId]: todos };
  });
  on('thread.removed', ({ threadId }) => {
    void threads.removed(threadId).catch(error => ctx.fail(error));
  });

  on('turn.toolCompleted', ({ threadId, turnId, boundary }) => {
    if (s.openThread?.id === threadId || s.composerStates[threadId]?.queued.length) ctx.composer.inputBoundaries[threadId] = { turnId, boundary };
  });

  on('turn.started', (turn) => threads.upsertTurn(turn.threadId, turn));
  // A subscription window crossed the alert set on its account.
  on('quotas.alerted', (alert) => layout.notifyLimit(alert));
  on('turn.finished', (turn) => {
    threads.upsertTurn(turn.threadId, turn);
    // A stop is the user's own doing, and a delegated agent's result or a
    // persistent agent's routine work is not news of its own.
    if (!finishNotifies(s.threads, turn, upkeepOf(s))) return;
    // The start of the reply, as the core's push says it. An error's own text
    // is often a stack or a provider's JSON: the thread shows it, not the toast.
    if (turn.status === 'done') layout.notify('finished', turn.threadId, () => lastReply(turn.threadId, turn.id));
    else if (turn.status === 'error') layout.notify('errors', turn.threadId, null);
  });

  /** What the agent last wrote in the turn: from the thread on screen, else a short read of its tail. */
  const lastReply = async (threadId: ThreadId, turnId: TurnId): Promise<string | null> => {
    const held = [...threads.threadSnapshots(threadId)];
    if (held.length) return lastAgentText(held[0]!.messages.filter(message => message.turnId === turnId));
    if (!current()) return null;
    const thread = await client.call('threads.get', { threadId, limit: 4, ...lightPage(ctx) });
    return lastAgentText(thread.messages.filter(message => message.turnId === turnId));
  };

  on('message.started', (message) => {
    threads.invalidateSync(message.threadId);
    // Before the push: the local row and the core's copy never share a frame.
    ctx.composer.landed(message);
    for (const target of threads.threadSnapshots(message.threadId)) {
      const index = lastIndexById(target.messages, message.id);
      if (index >= 0) target.messages[index] = message;
      // A window opened around a reading position stops short of the end: what
      // starts now comes with the pages below it, not after a gap.
      else if ((target.messagesAfter ?? null) === null) target.messages.push(message);
      // A prompt sent meanwhile lands on the last page: the window jumps there.
      else if (message.role === 'user' && target === threads.openThread) void threads.newer.loadLatest();
    }
  });

  on('message.delta', ({ threadId, messageId, partIndex, text }) => {
    threads.invalidateSync(threadId);
    for (const message of threads.messages(threadId, messageId)) {
      const part = message.parts[partIndex];
      // A delta appends to whatever kind of text part sits there: text or thinking.
      if (part && (part.type === 'text' || part.type === 'thinking')) part.text += text;
      // On a tool part it is the input's JSON, still being typed by the model.
      else if (part && part.type === 'tool') part.inputText = (part.inputText ?? '') + text;
      else if (!part) message.parts[partIndex] = { type: 'text', text };
    }
  });

  on('message.part', ({ threadId, messageId, partIndex, part }) => {
    threads.invalidateSync(threadId);
    for (const message of threads.messages(threadId, messageId)) message.parts[partIndex] = part;
  });

  on('message.completed', ({ threadId, messageId, state }) => {
    threads.invalidateSync(threadId);
    for (const message of threads.messages(threadId, messageId)) message.state = state;
  });

  // A rewind, from this client or another: the message and what follows it go.
  on('message.truncated', ({ threadId, messageId }) => threads.truncate(threadId, messageId));

  on('permission.requested', (request) => {
    requests.mergePermissions([request], 'one');
    layout.notify(requestKind(request), request.threadId, requestExcerpt(request) || null);
  });
  on('permission.resolved', ({ requestId, threadId, decision }) => {
    threads.invalidateSync(threadId);
    requests.resolvePermission(requestId);
    if (decision !== 'allow' && decision !== 'deny') return;
    for (const thread of threads.threadSnapshots(threadId)) {
      for (const message of thread.messages) {
        for (const part of message.parts) {
          if (part.type === 'permission' && part.requestId === requestId && part.decision === null) part.decision = decision;
        }
      }
    }
  });

  on('question.asked', (request) => {
    noteQuestionAsked(s, request);
    requests.mergeQuestions([request], 'one');
    layout.notify(requestKind(request), request.threadId, requestExcerpt(request) || null);
  });
  on('question.answered', ({ questionId }) => {
    requests.resolveQuestion(questionId);
  });
  on('secret.requested', request => requests.mergeSecret(request));
  on('secret.resolved', ({ requestId, threadId }) => {
    threads.invalidateSync(threadId);
    requests.resolveSecret(requestId);
  });

  // An agent's shell loop starts and ends dozens of processes a second. Only
  // the trace surface draws them, and it reads `trace.get` whenever it shows,
  // so the rows wait for it; it keeps what that call returns at most.
  on('process.started', (record) => {
    if (s.openThread?.id !== record.threadId || !s.traceWatched) return;
    s.trace = [record, ...s.trace.filter((p) => !sameProcess(p, record))].slice(0, TRACE_LIMIT);
  });
  on('process.exited', (record) => {
    if (s.openThread?.id !== record.threadId || !s.traceWatched) return;
    s.trace = s.trace.map((p) => (sameProcess(p, record) ? record : p));
  });

  on('scheduler.updated', (state) => {
    ctx.metadataRevision.scheduler++;
    s.scheduler = state;
  });
  on('resources.memory', (event) => ctx.workbench.memoryEvent(event));
  on('thread.memory', (event) => {
    for (const thread of threads.threadSnapshots(event.threadId)) {
      thread.memoryEvents = [...(thread.memoryEvents ?? []), event].slice(-100);
    }
  });
  on('account.login', (event) => {
    accounts.loginChanges.set(event.accountId, ++accounts.loginRevision);
    if (event.state === 'done') {
      const { [event.accountId]: _done, ...rest } = s.logins;
      s.logins = rest;
      return;
    }
    s.logins = {
      ...s.logins,
      [event.accountId]: {
        state: event.state,
        output: event.output,
        url: event.url,
        exitCode: event.exitCode
      }
    };
  });
  on('accounts.updated', (account) => {
    ctx.accountReads.change(account.id, account);
    s.accounts = s.accounts.some((a) => a.id === account.id)
      ? s.accounts.map((a) => (a.id === account.id ? account : a))
      : [...s.accounts, account];
    // The core forgets its probe for a changed account; so does the UI, or
    // the picker offers a model the core no longer accepts.
    models.dropProbes(account.id);
  });
  // The five below also reach the client that made the call, so every handler
  // has to survive being applied twice.
  on('accounts.removed', ({ accountId }) => {
    ctx.accountReads.change(accountId, null);
    s.accounts = s.accounts.filter((a) => a.id !== accountId);
    accounts.loginChanges.set(accountId, ++accounts.loginRevision);
    const { [accountId]: _gone, ...rest } = s.logins;
    s.logins = rest;
    models.dropProbes(accountId);
  });
  on('brain.configured', () => { void s.loadBrainCommands(); });
  on('subscriptionProxy.quotasUpdated', quotas => accounts.acceptProxyQuotas(quotas));
  on('settings.updated', (settings) => {
    ctx.metadataRevision.settings++;
    if (JSON.stringify(s.settings?.subscriptionProxy) !== JSON.stringify(settings.subscriptionProxy)) {
      accounts.proxyQuotas = null;
      for (const account of s.accounts) models.dropProbes(account.id);
    }
    s.settings = settings;
    void accounts.readProxyQuotas(client);
    void s.refreshMemory();
  });
  on('policy.changed', (policy) => { ctx.metadataRevision.policy++; s.policy = policy; });
  on('keybindings.updated', (keybindings) => {
    ctx.metadataRevision.keybindings++;
    s.keybindings = keybindings;
  });
  on('sessions.updated', () => {
    if (s.page === 'settings') void s.loadSessions();
  });
  // The machines of the group decide which machines this client connects to: read on every change.
  on('group.updated', () => {
    void s.loadGroup();
  });
  on('providers.installProgress', ({ providerId, ...state }) => {
    s.installStates = { ...s.installStates, [providerId]: state as ProviderInstallState };
  });
  on('providers.updatesChanged', (updates) => {
    s.harnessUpdates = updates;
  });
  on('providers.updated', ({ loaded, rejected }) => {
    ctx.metadataRevision.providers++;
    s.providers = loaded;
    s.rejectedProviders = rejected;
    // A summary that just landed is newer than any progress this client kept.
    s.installStates = installStatesOf(loaded);
    // The core drops its own probes on a reload; holding stale ones would
    // offer a model it now refuses.
    s.probedModels = {};
    models.probeEpoch++;
    models.probeAttempts.clear();
    models.forgetConfirmed();
    models.probeTimes.clear();
    models.effortAttempts.clear();
    models.saveModels();
  });
  on('providers.probed', ({ providerId, accountId, models: probed }) => {
    s.probedModels = { ...s.probedModels, [probeKey(providerId, accountId)]: probed };
    models.probeAttempts.add(probeKey(providerId, accountId));
    models.confirmed.add(probeKey(providerId, accountId));
    models.probeTimes.set(probeKey(providerId, accountId), Date.now());
    models.saveModels();
  });
  on('project.added', (project) => {
    ctx.projectReads.change(project.id, project);
    if (!s.projects.some((p) => p.id === project.id))
      s.projects = [...s.projects, project];
  });
  // Archived or restored anywhere, or its count of archived threads moved.
  on('project.updated', (project) => { ctx.projectReads.change(project.id, project); ctx.projects.upsertProject(project); });
  on('project.removed', ({ projectId }) => {
    ctx.projectReads.change(projectId, null);
    void ctx.projects.dropProject(projectId);
  });
  on('ui.reveal', ({ target }) => revealRequested(s, target));
  // `boite window point`'s box: the shell of this computer draws it.
  on('windows.pointer', (box) => { void pointerRequested(s, box); });
  on('core.log', (entry) => {
    if (entry.level !== 'error') return;
    s.error = entry.threadId
      ? s.threads.find(t => t.id === entry.threadId)?.title ?? strings.app.name
      : entry.message;
    s.errorThreadId = entry.threadId ?? null;
  });
}
