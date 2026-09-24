/*
 * Who may call what.
 *
 * The owner is the process holding the core token: the shell, the dev client,
 * anything that can read `core.json`. A paired device holds a session token it
 * got through a pairing link, and it is a guest: it reads the threads, answers
 * what an agent asks and sends prompts, and that is all.
 *
 * An agent holds the per-thread token the core put in the environment of a
 * process its thread launched. It is the narrowest of the three: it reaches
 * `AGENT_METHODS` and only ever on its own thread.
 *
 * The two lists below are the whole boundary, so this is the one place to read
 * when asking what a stolen phone, or an agent that went off, is worth. A
 * method that is in neither is the owner's: a new method added tomorrow is
 * refused to both until someone decides otherwise, on purpose.
 */

import type { RpcEventName, RpcMethodName } from '@boite/contracts';
import { refused } from './errors.ts';
import type { Connection } from './router.ts';

/**
 * What a paired device reaches. Read this as the phone's screen: the sidebar,
 * a thread, the composer, the cards an agent raises, and the settings it only
 * displays. Nothing here writes outside a thread, names a path, starts a
 * process of its own or changes what the core trusts.
 */
export const DEVICE_METHODS: ReadonlySet<RpcMethodName> = new Set<RpcMethodName>([
  // Follow and steer an owner-enabled team from the phone, without changing routes or limits.
  'delegation.get', 'delegation.send', 'delegation.stop',
  // Coordination is visible with the conversation; only the owner enables it.
  'collaboration.get',
  'collaboration.directory',
  // Dictation uses the owner's configured engine. Devices cannot change paths or credentials.
  'speech.status',
  'speech.transcribe',
  'speech.cancel',
  // Its own pairing, so a phone can show itself in the device list.
  'sessions.list',
  // Each authenticated pairing manages only its own push destination.
  'push.status',
  'push.subscribe',
  'push.unsubscribe',
  'push.test',
  // The sidebar and the composer's `@`.
  'projects.list',
  'projects.files',
  // What a thread needs to name its agent.
  'providers.list',
  'accounts.list',
  // The threads themselves.
  'threads.list',
  'threads.pullRequest', // Read-only branch metadata shown on the same phone thread cards.
  'threads.create',
  'threads.get',
  // A phone can manage continued prompts in the same thread it can already send to.
  'threads.activity.set',
  'threads.activity.control',
  'messages.list',
  'threads.update',
  'threads.retitle',
  'threads.compact', // A paired device can request the same session maintenance as the desktop.
  'threads.archive',
  'threads.pin',
  'threads.markRead',
  'threads.subscribe',
  'threads.unsubscribe',
  'turns.start',
  'turns.stop',
  // The point of carrying the phone: answering the agent from anywhere.
  'permissions.list',
  'permissions.answer',
  'questions.list',
  'questions.answer',
  // Read-only screens.
  'scheduler.get',
  'usage.get',
  // Sums of the same finished turns per day, provider and model. The thread
  // titles it names are the ones `threads.list` already shows the device.
  'usage.history',
  'settings.get',
  'keybindings.get',
]);

export function isDeviceMethod(method: RpcMethodName): boolean {
  return DEVICE_METHODS.has(method);
}

/** Push events must not bypass the read permissions enforced on RPC calls. */
export const DEVICE_EVENTS: ReadonlySet<RpcEventName> = new Set<RpcEventName>([
  // Team invalidation contains only the subscribed root ID; delegation.get enforces its read scope.
  'delegation.changed',
  'collaboration.changed', 'thread.activity',
  'project.added', 'project.removed',
  'thread.created', 'thread.updated', 'thread.removed', 'thread.commands',
  'turn.started', 'turn.finished',
  'message.started', 'message.delta', 'message.part', 'message.completed',
  'permission.requested', 'permission.resolved', 'question.asked', 'question.answered',
  'scheduler.updated', 'accounts.updated', 'accounts.removed',
  'settings.updated', 'keybindings.updated', 'sessions.updated',
  'providers.updated', 'providers.installProgress', 'providers.probed',
]);

/** The server also checks the thread or project scope of these agent events. */
export const AGENT_EVENTS: ReadonlySet<RpcEventName> = new Set<RpcEventName>([
  'browser.updated', // Progress for the agent's own owner-enabled browser tasks.
  // The server restricts this invalidation to the agent's own subscribed thread.
  'delegation.changed',
  'thread.activity', 'todos.updated', 'collaboration.changed',
]);

export function mayReceiveEvent(name: RpcEventName, connection: Connection): boolean {
  if (connection.identity.principal === 'owner') return true;
  return (connection.identity.principal === 'agent' ? AGENT_EVENTS : DEVICE_EVENTS).has(name);
}

/**
 * What the agent of a thread reaches, and why each one is worth the risk of a
 * token that sits in the environment of a process the user did not write. Read
 * this as the CLI's manual: the agent says where it is, shows the user
 * something, keeps its task list and the project's cards, reads the changes and
 * the files around it. Browser tasks start an owner-enabled plugin in an
 * isolated process group. Delegation can start a child only on owner-approved
 * routes within that thread's team budget. Every call is held to the token's
 * thread; team methods check the relationship before reaching a child. None
 * of these methods changes the owner's trust, routes or permissions.
 */
export const AGENT_METHODS: ReadonlyMap<RpcMethodName, string> = new Map<RpcMethodName, string>([
  ['browser.start', 'bounded browser tasks for its own thread, only after the owner installs a plugin and enables automation'],
  ['browser.list', 'progress and verified completion for its own browser tasks'],
  ['browser.cancel', 'stopping only a browser task that belongs to its thread'],
  ['delegation.get', 'its own team summaries, approved profiles and remaining budget'],
  ['delegation.spawn', 'one direct child on an owner-approved route, within durable team limits'],
  ['delegation.send', 'messages only between this parent and its direct children'],
  ['delegation.stop', 'stop its own children or itself, never unrelated work'],
  ['collaboration.get', 'its own coordination inbox and remaining budget, never other conversations'],
  ['collaboration.directory', 'opted-in contacts in this project and explicitly trusted machines'],
  ['collaboration.send', 'authenticated delivery as this thread to a separately authorized recipient'],
  ['agent.where', 'the thread, its project, its working directory and its branch: what the CLI prints first'],
  ['panel.open', 'showing the user a file, a diff or a page instead of pasting it into the transcript'],
  ['artifacts.publish', 'explicitly sharing a bounded snapshot from its own working directory in its own conversation'],
  ['threads.tasks.set', 'the plan the tasks surface draws, from an agent whose protocol carries no todo tool'],
  ['threads.tasks.get', 'the same plan read back, so a new process continues the list it did not write'],
  ['todos.list', 'the project cards, shared with the other threads of the project'],
  ['todos.add', 'what surfaced during the work and belongs to the project, not to this turn'],
  ['todos.update', 'claiming a card it finished, which is a request for confirmation, never the confirmation'],
  ['git.status', 'what it changed in the working directory, without spawning a git of its own'],
  ['git.diff', 'both sides of one file, for the same reason'],
  ['files.list', 'one directory of the working directory it already runs in'],
  ['files.read', 'one file of it, text inline and anything else through a ticket'],
]);

export function isAgentMethod(method: RpcMethodName): boolean {
  return AGENT_METHODS.has(method);
}

/**
 * Throws unless the connection may call the method, naming the method. The
 * params are read for one thing only: an agent speaks for its own thread, so a
 * call naming another one is refused before the handler sees it.
 */
export function assertAllowed(method: RpcMethodName, connection: Connection, params?: unknown): void {
  const identity = connection.identity;
  if (identity.principal === 'owner') return;
  if (identity.principal === 'agent') {
    if (!isAgentMethod(method)) throw refused(`${method} is not one of the agent's methods`, { method, principal: 'agent' });
    const named = (params as { threadId?: unknown } | null | undefined)?.threadId;
    if (identity.threadId === null || named !== identity.threadId) {
      throw refused(`${method} is for thread ${identity.threadId ?? 'none'}, not thread ${String(named)}`, {
        method,
        threadId: named,
      });
    }
    return;
  }
  if (isDeviceMethod(method)) return;
  throw refused(`${method} is for the owner only`, { method, principal: identity.principal });
}
