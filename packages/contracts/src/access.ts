import type { RpcEventName, RpcMethodName } from './index.ts';

/*
 * The device boundary, declared once. The core's router enforces it
 * (`packages/core/src/access.ts`) and the in-memory client applies the same
 * sets, so a method or event added or removed here changes both at once.
 */

/**
 * What a paired device reaches. Read this as the phone's screen: the sidebar,
 * a thread, the composer, the cards an agent raises, and the settings it only
 * displays. Nothing here writes outside a thread, names a path, starts a
 * process of its own or changes what the core trusts.
 */
export const DEVICE_METHODS: ReadonlySet<RpcMethodName> = new Set<RpcMethodName>([
  // A paired phone follows persistent work, talks to agents and answers its owner's decisions.
  'agents.snapshot', 'agents.message.send', 'agents.decision.answer', 'agents.work.control',
  'agents.history', // Older records of the kinds agents.snapshot already shows the device.
  'agents.runtime.get', 'agents.brain.get', // Read the same identity settings and memory shown on its host.
  // Follow and steer an owner-enabled team from the phone, without changing routes or limits.
  'delegation.get', 'delegation.send', 'delegation.stop',
  // Follow a workflow, pause or stop it; resume and retry spend budget and stay the owner's (checked in workflows.control).
  'workflows.list', 'workflows.get', 'workflows.control', 'workflows.templates.list',
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
  // A phone starts a draft like the desktop: the core picks the folder, the device names no path.
  'projects.drafts',
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

/** Push events must not bypass the read permissions enforced on RPC calls. */
export const DEVICE_EVENTS: ReadonlySet<RpcEventName> = new Set<RpcEventName>([
  'agents.changed', // Invalidation only; agents.snapshot applies the device read policy.
  // Team invalidation contains only the subscribed root ID; delegation.get enforces its read scope.
  'delegation.changed',
  // Invalidation naming the subscribed root; workflows.list applies the read scope.
  'workflows.changed',
  'collaboration.changed', 'thread.activity',
  'project.added', 'project.removed',
  'thread.created', 'thread.updated', 'thread.removed', 'thread.commands', 'thread.background',
  'turn.started', 'turn.finished',
  'message.started', 'message.delta', 'message.part', 'message.completed',
  'permission.requested', 'permission.resolved', 'question.asked', 'question.answered',
  'scheduler.updated', 'accounts.updated', 'accounts.removed',
  'settings.updated', 'keybindings.updated', 'sessions.updated',
  'providers.updated', 'providers.installProgress', 'providers.probed',
]);

/** The server also checks the thread or project scope of these agent events. */
export const AGENT_EVENTS: ReadonlySet<RpcEventName> = new Set<RpcEventName>([
  // The server restricts this invalidation to the agent's own subscribed thread.
  'delegation.changed',
  'thread.activity', 'todos.updated', 'collaboration.changed',
]);
