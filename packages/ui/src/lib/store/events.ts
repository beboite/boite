import type { ProviderInstallState, RpcEventName } from '@boite/contracts';
import type { Client, EventHandler } from '../client';
import { finishNotifies } from '../notify';
import { resetPullRequestSupport } from '../pull-request';
import { rightPanel } from '../right-panel.svelte';
import { lastIndexById } from '../thread-rows';
import { installStatesOf } from './accounts.svelte';
import { observable } from './connection.svelte';
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
  const { accounts, models, threads, requests, layout } = ctx;
  const on = <E extends RpcEventName>(event: E, handler: EventHandler<E>): void => {
    ctx.off.push(client.on(event, handler));
  };

  if (observable(client)) {
    ctx.off.push(
      client.onState((state) => {
        s.connection = state;
        ctx.connection.watchLocalCore(client, state);
        if (state === 'ready') {
          resetPullRequestSupport(client);
          models.probeEpoch++;
          models.probeAttempts.clear();
          models.effortAttempts.clear();
          s.error = null;
          s.core = client.core;
          // `WsClient` writes its principal from the hello answer before it
          // reports `ready`, and this handler runs before `connect()` returns:
          // reading it here is what keeps the owner-only calls out of the very
          // first load, and what refreshes it after a reconnect.
          s.principal = client.principal;
          void s.reload();
        }
      })
    );
  }

  // Rows are patched in place: a load tick on one running thread must not
  // hand the sidebar a new array and re-render every other row.
  on('thread.created', (summary) => threads.upsertThread(summary));
  on('thread.updated', (summary) => {
    threads.upsertThread(summary);
    const open = s.openThread;
    if (open && open.id === summary.id) Object.assign(open, summary);
    // Archived from another client: nothing here can show it again.
    else if (summary.archived) threads.forgetThread(summary.id);
    if (s.delegationThread?.id === summary.id) Object.assign(s.delegationThread, summary);
  });
  // The agent's `/name` list is the whole list each time, and it lives on the
  // open thread only: a summary in the sidebar carries none.
  on('thread.commands', ({ threadId, commands }) => {
    const open = s.openThread;
    if (open && open.id === threadId) open.commands = commands;
  });
  // What the agent still runs in the background, whole each time, like the commands.
  on('thread.background', ({ threadId, tasks }) => {
    const open = s.openThread;
    if (open && open.id === threadId) open.background = tasks;
  });
  on('thread.activity', ({ threadId, activity }) => {
    if (s.openThread?.id === threadId) s.openThread.activity = activity;
  });
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
    rightPanel.for(s.threadKey(threadId)).showSurface(surface);
  });
  // The project's whole list after any change, whoever moved a card.
  on('todos.updated', ({ projectId, todos }) => {
    s.todos = { ...s.todos, [projectId]: todos };
  });
  on('thread.removed', ({ threadId }) => {
    s.threads = s.threads.filter((t) => t.id !== threadId);
    requests.dropRequestsOf(threadId);
    // A thread that left Boite takes its panel layout and composer with it.
    threads.forgetThread(threadId);
    if (s.openThread?.id !== threadId) return;
    s.openThread = null;
    // The two steps `archive()` takes when the thread on screen goes: the
    // socket lets it go, and the chat lands on the next thread rather than
    // on the empty card.
    void (async () => {
      await threads.unsubscribe();
      await s.openWhereLeft();
    })();
  });

  on('turn.started', (turn) => threads.upsertTurn(turn.threadId, turn));
  on('turn.finished', (turn) => {
    threads.upsertTurn(turn.threadId, turn);
    // A stop is the user's own doing, and a delegated agent's result or a
    // persistent agent's routine work is not news of its own.
    if (!finishNotifies(s.threads, turn)) return;
    if (turn.status === 'done') layout.notify('done', turn.threadId, null);
    else if (turn.status === 'error') layout.notify('error', turn.threadId, turn.error);
  });

  on('message.started', (message) => {
    for (const target of threads.threadSnapshots(message.threadId)) {
      const index = lastIndexById(target.messages, message.id);
      if (index >= 0) target.messages[index] = message;
      else target.messages.push(message);
    }
  });

  on('message.delta', ({ threadId, messageId, partIndex, text }) => {
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
    for (const message of threads.messages(threadId, messageId)) message.parts[partIndex] = part;
  });

  on('message.completed', ({ threadId, messageId, state }) => {
    for (const message of threads.messages(threadId, messageId)) message.state = state;
  });

  on('permission.requested', (request) => {
    requests.mergePermissions([request], 'one');
    layout.notify('needs-you', request.threadId, null);
  });
  on('permission.resolved', ({ requestId }) => {
    s.pendingPermissions = s.pendingPermissions.filter((p) => p.id !== requestId);
  });

  on('question.asked', (request) => {
    requests.mergeQuestions([request], 'one');
    layout.notify('needs-you', request.threadId, null);
  });
  on('question.answered', ({ questionId }) => {
    s.pendingQuestions = s.pendingQuestions.filter((q) => q.id !== questionId);
  });

  on('process.started', (record) => {
    if (s.openThread?.id !== record.threadId) return;
    s.trace = [record, ...s.trace.filter((p) => !sameProcess(p, record))];
  });
  on('process.exited', (record) => {
    if (s.openThread?.id !== record.threadId) return;
    s.trace = s.trace.map((p) => (sameProcess(p, record) ? record : p));
  });

  on('scheduler.updated', (state) => {
    s.scheduler = state;
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
    s.accounts = s.accounts.filter((a) => a.id !== accountId);
    accounts.loginChanges.set(accountId, ++accounts.loginRevision);
    const { [accountId]: _gone, ...rest } = s.logins;
    s.logins = rest;
    models.dropProbes(accountId);
  });
  on('settings.updated', (settings) => {
    s.settings = settings;
  });
  on('keybindings.updated', (keybindings) => {
    s.keybindings = keybindings;
  });
  on('sessions.updated', () => {
    if (s.page === 'settings') void s.loadSessions();
  });
  on('providers.installProgress', ({ providerId, ...state }) => {
    s.installStates = { ...s.installStates, [providerId]: state as ProviderInstallState };
  });
  on('providers.updatesChanged', (updates) => {
    s.harnessUpdates = updates;
  });
  on('providers.updated', ({ loaded, rejected }) => {
    s.providers = loaded;
    s.rejectedProviders = rejected;
    // A summary that just landed is newer than any progress this client kept.
    s.installStates = installStatesOf(loaded);
    // The core drops its own probes on a reload; holding stale ones would
    // offer a model it now refuses.
    s.probedModels = {};
    models.probeEpoch++;
    models.probeAttempts.clear();
    models.effortAttempts.clear();
    models.saveModels();
  });
  on('providers.probed', ({ providerId, accountId, models: probed }) => {
    s.probedModels = { ...s.probedModels, [probeKey(providerId, accountId)]: probed };
    models.probeAttempts.add(probeKey(providerId, accountId));
    models.saveModels();
  });
  on('project.added', (project) => {
    if (!s.projects.some((p) => p.id === project.id))
      s.projects = [...s.projects, project];
  });
  on('project.removed', ({ projectId }) => {
    void ctx.projects.dropProject(projectId);
  });
  on('core.log', (entry) => {
    if (entry.level === 'error') s.error = entry.message;
  });
}
