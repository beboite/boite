import type { RpcEventName, RpcMethodName } from './index.ts';

/*
 * The device boundary, declared once. The core's router enforces it
 * (`packages/core/src/access.ts`) and the in-memory client applies the same
 * sets, so a method or event added or removed here changes both at once.
 */

/**
 * What a paired device reaches. Read this as the phone's screen: the sidebar,
 * a thread, the composer, the cards an agent raises, and the settings it only
 * displays. Model discovery may start the configured agent without a prompt.
 * Nothing here changes what the core trusts; the only paths a device names are
 * read-only, inside a thread's working tree.
 */
export const DEVICE_METHODS: ReadonlySet<RpcMethodName> = new Set<RpcMethodName>([
  // A paired phone follows persistent work, talks to agents and answers its owner's decisions.
  'agents.snapshot', 'agents.message.send', 'agents.decision.answer', 'agents.work.control',
  'agents.history', // Older records of the kinds agents.snapshot already shows the device.
  'agents.runtime.get', 'agents.brain.get', // Read the same identity settings and memory shown on its host.
  // Follow and steer an owner-enabled team from the phone, without changing routes or limits.
  // Bounded child results and event-driven waits expose the same family read scope as delegation.get.
  'delegation.get', 'delegation.result', 'delegation.wait', 'delegation.send', 'delegation.stop',
  // Follow a workflow, pause or stop it; resume and retry spend budget and stay the owner's (checked in workflows.control).
  'workflows.list', 'workflows.get', 'workflows.control', 'workflows.templates.list',
  // Coordination is visible with the conversation; only the owner enables it.
  'collaboration.get',
  'collaboration.directory',
  // Dictation uses the owner's configured engine. Devices cannot change paths or credentials.
  'speech.status',
  'speech.transcribe',
  'speech.cancel',
  // Loads the owner's configured model a dictation is about to use: nothing a device could transcribe anyway.
  'speech.warm',
  // Paired phones stream their microphone to the owner's configured local engine.
  'speech.streamStart',
  'speech.streamChunk',
  'speech.streamFinish',
  // Its own pairing, so a phone can show itself in the device list.
  'sessions.list',
  // Each authenticated pairing manages only its own push destination.
  'push.status',
  'push.subscribe',
  'push.unsubscribe',
  'push.test',
  // The sidebar and the composer's `@`.
  'projects.list',
  // The logo the list announces: a bounded image already stored in the journal, no path and no disk read.
  'projects.icon',
  'projects.files',
  // A phone starts a draft like the desktop: the core picks the folder, the device names no path.
  'projects.drafts',
  // Putting a project away only hides it from the sidebar, like archiving a thread; nothing on disk moves.
  'projects.archive',
  // What a thread needs to name its agent.
  'providers.list',
  // Read or refresh the configured account's native catalog, including ACP
  // effort metadata. No prompt, executable, path or credential is supplied.
  'providers.probe',
  'accounts.list',
  // The threads themselves.
  'threads.list',
  'threads.pullRequest', // Read-only branch metadata shown on the same phone thread cards.
  'threads.pullRequests', // Read-only conversation links, including dependency order, on phones.
  'threads.pullRequestReview', 'threads.pullRequestFiles', // Bounded read-only data for PRs the owner already linked.
  'browser.remoteFrame', 'browser.remoteInput', // Only the subscribed conversation's owner-enabled shared page; no scripts or host paths.
  'browser.remoteStatus', // Only whether the subscribed conversation has an owner-shared browser tab; no address or content.
  'threads.create',
  'threads.get',
  'threads.capabilities', // Read-only controls for the conversation already visible; never prepares or probes a runtime.
  // A phone can manage continued prompts in the same thread it can already send to.
  'threads.activity.set',
  'threads.activity.control',
  'messages.list',
  'messages.toolOutput', // Read only the output of a tool in the conversation the phone can already read.
  'messages.attachment', // Only journalled bytes in a conversation already readable from the phone.
  'artifacts.read', // Download only snapshots already published in a visible conversation, never host paths.
  'threads.update',
  'threads.retitle',
  'threads.compact', // A paired device can request the same session maintenance as the desktop.
  'threads.btw.cancel', // Dismissal cancels only the named temporary request.
  'threads.btw', // A phone asks the same temporary side questions as the owner's composer.
  'threads.btw.fork', // Paired devices can turn their temporary answer into a conversation.
  // Editing a sent prompt and branching a conversation are the composer's own
  // moves. A fork in a worktree writes no more than `threads.create` with one,
  // which a device already reaches, and names no path either.
  'threads.rewind',
  'threads.fork',
  'threads.mergeBack', // A paired owner can return bounded conclusions to the recorded fork source.
  'threads.archive',
  // Moving a thread from the sidebar or its menu. The device names a project it
  // already lists, never a path: the core picks the folder or makes the
  // worktree, as it does for `threads.create` and `threads.fork`.
  'threads.move',
  // Taking back a move the device may ask for: it only forgets what waits in
  // memory for the turn's end, and changes nothing on disk.
  'threads.moveCancel',
  'threads.pin',
  'threads.markRead',
  'threads.subscribe',
  'threads.unsubscribe',
  // A paired phone may prepare the conversation it is viewing, with the same
  // account and permissions as its next prompt, without starting a turn.
  'threads.focus',
  'turns.start',
  // Paired phones can send the same user follow-ups as the owner's composer.
  'turns.steer',
  'turns.stop',
  // A paired phone can resume or discard the same retained prompt as the owner.
  'turns.recover',
  // The point of carrying the phone: answering the agent from anywhere.
  'permissions.list',
  'permissions.answer',
  'questions.list',
  'questions.answer',
  // Paired phones can dismiss the same question cards as the owner's chat.
  'questions.skip',
  // Read-only Changes and Files panels on the phone: the thread's own changes and files.
  // The core runs git itself (no device command), refuses a diff against anything but
  // HEAD (core access.ts), and holds every path to a thread whose real working directory
  // is in its project or the core's worktrees (core workdir.ts). `files.write` stays the owner's.
  'git.status', // The changed paths and their counts, what the Changes list draws.
  'git.diff', // Both sides of one changed file against HEAD.
  'files.list', // One directory of the thread's working tree, for the Files tree.
  'files.read', // One file of it: text inline, anything else through a short-lived ticket.
  // Read-only screens.
  // Sanitized per-thread usage has no command lines, executable paths or account identifiers.
  'resources.usage',
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
  'threads.pullRequestsChanged', // Links already readable on the subscribed conversation.
  'browser.remoteChanged', // Whether the subscribed conversation's shared browser tab exists, as browser.remoteStatus says.
  'agents.changed', // Invalidation only; agents.snapshot applies the device read policy.
  // Team invalidation contains only the subscribed root ID; delegation.get enforces its read scope.
  'delegation.changed',
  // Invalidation naming the subscribed root; workflows.list applies the read scope.
  'workflows.changed',
  'collaboration.changed', 'thread.activity',
  'project.added', 'project.removed', 'project.updated',
  'thread.created', 'thread.updated', 'thread.removed', 'thread.commands', 'thread.background', 'thread.btw',
  'turn.started', 'turn.finished',
  'turn.toolCompleted',
  'message.started', 'message.delta', 'message.part', 'message.completed', 'message.truncated',
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
