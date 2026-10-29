import type { Principal } from './agent-door.ts';
import type { RpcEventName, RpcMethodName } from './index.ts';

/*
 * The device and agent boundaries, declared once. The core's router enforces
 * them (`packages/core/src/access.ts`) and the in-memory client applies the
 * same sets and the same decision, so a method or event added or removed here
 * changes both at once.
 */

/**
 * What a paired device reaches. Read this as the phone's screen: the sidebar,
 * a thread, the composer, the cards an agent raises, and the settings it only
 * displays. Model discovery may start the configured agent without a prompt.
 * Nothing here changes what the core trusts, with one routing exception: it
 * may turn the owner's saved subscription gateway on or off, never its kind,
 * URLs or key. The only paths a device names are read-only, inside a thread's
 * working tree.
 * Reserved shared-project methods stay owner-only until their handlers and
 * association scope checks are installed; see docs/contacts.md for permissions.
 */
export const DEVICE_METHODS: ReadonlySet<RpcMethodName> = new Set<RpcMethodName>([
  // Paired apps share the owner's composer and its validated, content-addressed attachments.
  'composer.list', 'composer.put', 'composer.asset.put', 'composer.asset.get',
  // A paired phone lists the owner's agents with their state, desk and routines; talking to one is
  // `turns.start` on its thread, which the device already reaches.
  'agents.snapshot',
  // The agent's own thread, created again if it was lost: a thread the phone then opens like any other.
  'agents.open',
  'agents.runtime.get', 'agents.brain.get', // Read the same identity settings and memory shown on its host.
  'agents.event', // A paired script wakes a bot with an outside event, quoted as data; pair one device per service to revoke it alone.
  // Follow and steer an owner-enabled team from the phone, without changing routes or limits.
  // Bounded child results and event-driven waits expose the same family read scope as delegation.get.
  'delegation.get', 'delegation.result', 'delegation.wait', 'delegation.send', 'delegation.stop',
  // Follow a workflow, pause or stop it; resume and retry spend budget and are refused to a phone (checked in workflows.control).
  'workflows.list', 'workflows.get', 'workflows.control', 'workflows.templates.list',
  // Coordination is visible with the conversation; only the owner enables it.
  'collaboration.get',
  // A phone's own rendering errors and failed calls land in the owner's diagnostics, bounded per connection.
  'diagnostics.report',
  'collaboration.directory',
  'contacts.sendHuman', // A paired human sends a contact letter, never an agent impersonation or host approval.
  // Exact associated-project views and connection-owned invalidations; administration remains owner-only.
  'sharedProjects.list', 'sharedProjects.get', 'sharedProjects.threads', 'sharedProjects.search', 'sharedProjects.read', 'sharedProjects.subscribe',
  'sharedBoard.get', 'sharedBoard.apply', 'sharedBoard.start', // Board actions on a paired phone recheck bilateral consent and its canonical local worker.
  'sharedCompute.models', 'sharedCompute.list', 'sharedCompute.get', 'sharedCompute.send', 'sharedCompute.cancel', // Paired humans follow and cancel scoped jobs; admission and host policy stay owner/agent-only.
  'sharedAccess.get', // Sanitized activity of an explicit association; host paths, overrides and reviewer configuration stay owner-only.
  // Dictation uses the owner's configured engine. Devices cannot change paths or credentials.
  'speech.status',
  'speech.transcribe',
  'speech.cancel',
  // Loads the owner's configured model a dictation is about to use: nothing a device could transcribe anyway.
  'speech.warm',
  // The admin policy draws a phone's locked controls as on the desktop; only the machine's policy file changes it.
  'policy.get',
  // Paired phones stream their microphone to the owner's configured local engine.
  'speech.streamStart',
  'speech.streamChunk',
  'speech.streamFinish',
  // Its own pairing, so a phone can show itself in the device list.
  'sessions.list',
  // The machines of the group and a ticket to each: a phone paired with one member reaches the others at its own role, never more.
  'group.get',
  'group.ticket',
  // A device paired the older way hands over its own device key: it gains no role, only one key for every member.
  'group.enrollDevice',
  // Each authenticated pairing manages only its own push destination.
  'push.status',
  'push.subscribe',
  'push.unsubscribe',
  'push.test',
  // Which kinds of notification its own subscription receives: the device's choice, about nothing else.
  'push.kinds',
  // The sidebar and the composer's `@`.
  'projects.list',
  // The logo the list announces: a bounded image already stored in the journal, no path and no disk read.
  'projects.icon',
  'projects.files',
  'brain.commands', // Paired phones draw the same manual skill menu, with no paths or skill bodies.
  // A phone starts a draft like the desktop: the core picks the folder, the device names no path.
  'projects.drafts',
  // Putting a project away only hides it from the sidebar, like archiving a thread; nothing on disk moves.
  'projects.archive',
  // Renaming changes only a listed project's display name; it never moves or writes to its folder.
  'projects.rename',
  // What a thread needs to name its agent.
  'providers.list',
  // Read or refresh the configured account's native catalog, including ACP
  // effort metadata. No prompt, executable, path or credential is supplied.
  'providers.probe',
  'accounts.list',
  // The threads themselves.
  'threads.list',
  'threads.listChanges', // The same list after a reconnect, only the rows changed since: what a phone on a poor link reads.
  'threads.pullRequest', // Read-only branch metadata shown on the same phone thread cards.
  'threads.pullRequests', // Read-only conversation links, including dependency order, on phones.
  'threads.pullRequestReview', 'threads.pullRequestFiles', // Bounded read-only data for PRs the owner already linked.
  // Stopping a pull request watch only ends Boite's own polling: the phone's button beside the watch, never a GitHub write.
  'threads.unwatchPullRequest',
  'browser.remoteFrame', 'browser.remoteInput', // Only the subscribed conversation's agent browser; taps, keys and http(s) addresses, no scripts or host paths.
  'browser.remoteSelection', // The text selected in that same page, password fields excluded: what the frames already show, as text.
  'browser.remoteStatus', // The subscribed conversation's agent tabs (address and title) and whether this machine has a browser.
  // The Device panel on a phone. The core acts only on simulators and emulators its SDK lists, for the subscribed
  // conversation, runs no command a device names and returns no host path: what the phone could ask of the agent.
  'devices.list', 'devices.sessions', 'devices.frame', 'devices.input', 'devices.open', 'devices.close', 'devices.screenshot',
  // The same screen as live video, and the device's clipboard for the copy the person watching makes: what the frames
  // and a long press already show. Only for a device open in the subscribed conversation, with no command or path.
  'devices.stream', 'devices.clipboard',
  // The Window panel on a phone: the subscribed conversation's watched window as JPEG frames once the person presses
  // Show, the windows the agent could list, emptying the panel, and the owner's answer to a capture consent card,
  // which the phone shows like a question. No capture to a file, no input, and the allowed apps stay with the owner.
  'windows.list', 'windows.frame', 'windows.close', 'windows.consent',
  'threads.create',
  // Composing a phone draft uses the same creation authority, with no prompt or arbitrary executable.
  'drafts.prepare', 'drafts.release',
  // Only this phone connection's bounded attachment bytes, with the same validation as Send.
  'attachments.upload', 'attachments.release',
  'threads.get',
  'threads.capabilities', // Read-only controls for the conversation already visible; never prepares or probes a runtime.
  // A phone can manage continued prompts in the same thread it can already send to.
  'threads.activity.set',
  'threads.activity.control',
  // The project board on a phone: the cards are the user's own list, and a card started there is a `/goal2`
  // the phone could already start by hand. `done` and removal stay the user's, which a paired device is.
  'todos.list', 'todos.add', 'todos.update', 'todos.remove',
  'messages.list',
  'messages.toolOutput', // Read only the output of a tool in the conversation the phone can already read.
  'messages.toolPart', // The whole journalled tool call a phone's page deferred, in a conversation it can already read.
  'messages.attachment', // Only journalled bytes in a conversation already readable from the phone.
  'artifacts.read', // Download only snapshots already published in a visible conversation, never host paths.
  // Shows an answer's ```view block: the HTML as a page on an opaque origin that loads and calls nothing. No path, nothing stored.
  'artifacts.viewBlock',
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
  // Deleting from the phone's thread menu, and its undo. Project files stay and
  // the conversation is kept for the owner's retention period; the list of
  // deleted conversations and that period stay on the owner's settings page.
  'threads.remove', 'threads.restore',
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
  // Cancelling a planned retry spends nothing and does less than turns.stop, which a phone already has.
  'turns.cancelRetry',
  // The point of carrying the phone: answering the agent from anywhere.
  'permissions.list',
  'permissions.answer',
  'questions.list',
  'questions.answer',
  'questions.openPage', // The address a pending question of the subscribed conversation carries, rechecked by the core.
  // Paired phones can dismiss the same question cards as the owner's chat.
  'questions.skip',
  // A secret card answered from the phone, with list/delete retained for older clients. The core
  // refuses an answer or legacy deletion over an unencrypted link (core secrets/rpc.ts): the value or
  // the decision must not cross a LAN in clear. The list carries names and dates, never a value.
  'secrets.answer', 'secrets.list', 'secrets.delete',
  'secrets.pending', // Restore open cards independently of history; metadata only, never values.
  // A phone says its own language and experiments, so the agent reads the screen the user reads; nothing the core trusts.
  'client.preferences',
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
  // Machine-wide totals: model names, sizes and loads, no paths beyond drive letters or mount points.
  'resources.machine',
  'scheduler.get',
  'usage.get',
  // Sums of the same finished turns per day, provider and model. The thread
  // titles it names are the ones `threads.list` already shows the device.
  'usage.history',
  // The limit bars of the accounts `accounts.list` already names, and the gateway's.
  // A device reads what the core holds: forcing a refresh, switching monitoring and
  // spending a reset stay the owner's (core access.ts).
  'quotas.list',
  'subscriptionProxy.quotas',
  // When a window the device already reads notifies. It reads no provider itself:
  // the core's alert check keeps its own five-minute cadence (core access.ts).
  'quotas.alert',
  // Switching the gateway the owner configured on or off, from the Limits tab. The kind,
  // URLs and key stay the owner's: a phone only picks between two routes the owner set up.
  'subscriptionProxy.setEnabled',
  'settings.get',
  'keybindings.get',
]);

/** Push events must not bypass the read permissions enforced on RPC calls. */
export const DEVICE_EVENTS: ReadonlySet<RpcEventName> = new Set<RpcEventName>([
  'composer.updated', // Same metadata composer.list exposes, without attachment bytes or subscription routing.
  'sharedProjects.changed', // Direct delivery only to the connection's exact subscribed association and source.
  'threads.pullRequestsChanged', // Links already readable on the subscribed conversation.
  'browser.remoteChanged', // The subscribed conversation's agent tabs, as browser.remoteStatus says.
  'devices.changed', // The subscribed conversation's Device panel sessions, as devices.sessions returns them.
  'windows.changed', // The subscribed conversation's watched window, as windows.list returns it.
  'agents.changed', // Invalidation only; agents.snapshot applies the device read policy.
  // Team invalidation contains only the subscribed root ID; delegation.get enforces its read scope.
  'delegation.changed',
  // Invalidation naming the subscribed root; workflows.list applies the read scope.
  'workflows.changed',
  'collaboration.changed', 'thread.activity',
  'todos.updated', // The whole list todos.list already answers the device.
  'project.added', 'project.removed', 'project.updated',
  'thread.created', 'thread.updated', 'thread.removed', 'thread.commands', 'thread.background', 'thread.btw',
  // The load `thread.updated` already carries to the same sockets, without the rest of the row.
  'thread.load',
  'turn.started', 'turn.finished',
  'turn.toolCompleted',
  'message.started', 'message.delta', 'message.part', 'message.completed', 'message.truncated',
  'permission.requested', 'permission.resolved', 'question.asked', 'question.answered',
  'secret.requested', 'secret.resolved', 'secrets.changed', // Names, reasons and refs, never a value.
  'scheduler.updated', 'accounts.updated', 'accounts.removed',
  'quotas.updated', 'quotas.progress', 'subscriptionProxy.quotasUpdated', // What quotas.list and subscriptionProxy.quotas answer.
  'quotas.alerted', // One window of a row quotas.list already answers the device.
  'settings.updated', 'keybindings.updated', 'sessions.updated',
  'policy.changed', // What policy.get answers the device.
  // Experiment ids of the desktop app, as client.preferences already answers the device.
  'client.desktopExperiments',
  'group.updated', // Invalidation only; group.get applies the device read policy.
  'providers.updated', 'providers.installProgress', 'providers.probed',
]);

/** The server also checks the thread or project scope of these agent events. */
export const AGENT_EVENTS: ReadonlySet<RpcEventName> = new Set<RpcEventName>([
  'sharedProjects.changed', // Direct delivery only to this agent's exact subscribed association and source.
  // The server restricts this invalidation to the agent's own subscribed thread.
  'delegation.changed',
  'thread.activity', 'todos.updated', 'collaboration.changed',
]);

/**
 * What the agent of a thread reaches, and why each one is worth the risk of a
 * token that sits in the environment of a process the user did not write. Read
 * this as the CLI's manual: the agent says where it is, shows the user
 * something, keeps its task list and the project's cards, reads the changes and
 * the files around it. Delegation can start a child only on owner-approved
 * routes configured for that thread. Every call is held to the token's
 * thread; team methods check the relationship before reaching a child. None
 * of these methods changes the owner's trust, routes or permissions.
 */
export const AGENT_METHODS: ReadonlyMap<RpcMethodName, string> = new Map<RpcMethodName, string>([
  ['threads.capabilities', 'read implemented controls of its own conversation without probing or starting a runtime'],
  ['threads.pullRequests', 'read the pull requests attached to its own conversation'],
  ['threads.linkPullRequest', 'attach a verified GitHub PR to its own conversation; does not publish or modify the PR'],
  ['threads.unlinkPullRequest', 'remove a conversation link without changing the GitHub PR'],
  ['threads.watchPullRequest', 'have Boite read one of its own PRs on GitHub and wake its own conversation when it changes; reads only, never writes to GitHub'],
  ['threads.unwatchPullRequest', 'stop its own conversation\'s watches; changes nothing on GitHub'],
  // A persistent agent's own records, from its own thread only (agents/store.ts refuses any other agent's).
  ['agents.snapshot', 'its own identity, routines, desk and status; no other agent, grant or entrustment'],
  ['agents.brain.get', 'its own AGENTS.md and MEMORY.md, which its context block already carries'],
  ['agents.memory.note', 'a dated line at the end of its own MEMORY.md, refused past the size every turn reads'],
  ['agents.routine.save', 'its own routines, the clock its wakes run on; the owner pauses it or caps its daily spend'],
  ['agents.routine.remove', 'removing one of its own routines'],
  ['agents.watch', 'putting a thread of its projects on its own desk, or taking one off; it reads nothing it could not already read through resident.thread'],
  ['delegation.result', 'bounded assistant-text pages from an exact terminal turn of its direct delegated child'],
  ['delegation.wait', 'event-driven completion of its direct children; timeout/disconnect never stops their work'],
  ['delegation.get', 'its own team summaries, approved profiles and usage'],
  ['delegation.spawn', 'one direct child on its own model, a profile, or any installed model unless the owner turned that off'],
  ['delegation.models', 'the installed models and reasoning levels a child may run on, without credentials'],
  ['delegation.send', 'messages only between this parent and its direct children'],
  ['delegation.stop', 'stop its own children or itself, never unrelated work'],
  ['delegation.resume', "continue its own stopped children and lift its team's pause when it set it or a restart did, or after a Stop once the owner wrote again; never the owner's Settings pause"],
  ['workflows.list', 'the runs of its own thread, or of its parent for a step'],
  ['workflows.get', 'one run of its own thread, or of its parent for a step'],
  ['workflows.check', 'validating a plan against its own profiles, without starting anything'],
  ['workflows.start', 'a graph of child threads on its own model or its owner-approved profiles, with concurrency set in its plan'],
  ['workflows.extend', 'more steps on a run it started, under the same checks'],
  ['workflows.control', 'pause, stop, resume or retry runs it started; a pause the owner set lifts only once the owner wrote again, and the Settings pause of the team never'],
  ['workflows.output', 'the structured result of the step this thread is, checked against its declared shape'],
  ['workflows.templates.list', 'the plans kept for its own project'],
  ['workflows.templates.save', 'keeping a new plan for its own project, never replacing a saved one; a template runs only through workflows.start'],
  ['collaboration.get', 'its own coordination inbox, never other conversations'],
  ['sharedProjects.list', 'associations of its own project, with locally configured contact names'],
  ['sharedProjects.get', 'one explicit association of its own project'],
  ['sharedProjects.threads', 'only the two associated endpoints under live grants and coordination settings'],
  ['sharedProjects.search', 'scoped descriptors and chat only where the host grants readThreads'],
  ['sharedProjects.read', 'a canonical thread of one associated endpoint under destination readThreads'],
  ['sharedProjects.subscribe', 'connection-owned invalidations for its own source thread and exact association'],
  ['sharedBoard.get', 'board projection of its own associated project under both current consents'],
  ['sharedBoard.apply', 'durable edits and authority claims; agents cannot confirm or delete cards'],
  ['sharedBoard.start', 'only its own accepted worker claim, with host execution protection and idempotent start'],
  ['sharedCompute.models', 'only routes explicitly offered for its associated project; no account credentials'],
  ['sharedCompute.start', 'host-opted delegation from its authenticated project thread, under host permissions and resources'],
  ['sharedCompute.list', 'only its source jobs in this association'],
  ['sharedCompute.get', 'only its exact source job, with host-attested state and git provenance'],
  ['sharedCompute.send', 'external follow-up to its captured job, never a host-owner instruction'],
  ['sharedCompute.cancel', 'only its captured job; no parent or sibling control'],
  ['sharedAccess.get', 'sanitized activity of its own association, never host overrides, paths or credentials'],
  ['collaboration.directory', 'opted-in contacts in this project and explicitly trusted machines'],
  ['threads.mergeBack', 'returning bounded conclusions only from this authenticated fork to its recorded origin, under existing coordination permissions'],
  ['collaboration.send', 'authenticated delivery as this thread to a separately authorized recipient'],
  ['collaboration.search', 'contacts it may already reach, found by their title, project, branch, model, resources or chat'],
  ['collaboration.read', 'the conversation of a contact it may already reach, text and tool names only; the user wants agents to help with each other'],
  ['collaboration.wait', 'blocks on its own inbox until a reply arrives'],
  ['collaboration.contacts', 'the contacts it may write to and the project names each opened to this core, never their keys or addresses'],
  ['collaboration.ask', 'a request as this thread to a contact, which that contact\'s owner or concierge decides; it opens nothing here'],
  // Resident methods name the persistent agent's own thread like
  // every agent method; agents/projects.ts holds each call to the projects the
  // owner entrusted to that agent's profile. Any other thread is refused.
  ['resident.view', 'the projects the owner entrusted to it, so it knows what it may touch'],
  ['resident.threads', 'the state of the threads in those projects, nothing outside them'],
  ['resident.thread', 'one of those threads with its pending questions, permissions and last answer'],
  ['resident.act', 'marking done, archiving, moving between its projects, stopping or renaming one of those threads, with a line in its timeline saying so; deleting stays the owner\'s'],
  ['resident.answer', 'answering a question one of those threads asked, marked as the agent\'s in that timeline; tool permissions stay the owner\'s'],
  // With `machine`, the four above and resident.send reach a project of another machine of the group the
  // owner entrusted to the bot, over the group's sealed link (agents/group-bots.ts). That machine holds each
  // request to the lease and to its own groupBots setting (agents/group-host.ts); nothing else crosses.
  ['resident.send', 'a message to a thread of a project of another machine of the group entrusted to it, marked there as the bot\'s, never the user\'s, while that machine has groupBots on'],
  ['agent.where', 'the thread, its project, its working directory and its branch: what the CLI prints first'],
  ['agent.projects', 'the names and folders of the projects the owner added, so it can name one to delegation.spawn or agent.move; reading them opens nothing'],
  ['agent.addProject', 'registering an existing folder as a project, which the owner sees appear and can remove; it opens no file access the agent\'s process lacks, and it stays within the communication settings and one agent generation, like agent.spawn'],
  ['agent.spawn', 'a new top-level thread in a project the owner added, on its own model, account and permission mode, within its communication settings and an hourly budget; a thread an agent started cannot start another until the user writes in it'],
  ['agent.move', 'its own thread into a project the owner already registered, applied when its turn ends; never another thread, never a folder the owner did not add'],
  ['panel.open', 'showing the user a file, a diff or a page instead of pasting it into the transcript'],
  ['browser.command', 'the headless browser its own conversation has on this machine, which it could start from its shell anyway; never another conversation\'s tabs'],
  ['devices.list', 'the simulators and emulators its SDK lists on this machine; adb and xcrun are already within its shell\'s reach'],
  ['devices.open', 'booting one of them and showing it in its own conversation\'s Device panel'],
  ['devices.sessions', 'what its own conversation\'s Device panel has open, to wait for a boot'],
  ['devices.screenshot', 'one PNG of a device open in its own conversation'],
  ['devices.input', 'taps, swipes, text and keys on a device open in its own conversation, as adb input would, or through the live stream a viewer keeps up'],
  ['devices.close', 'removing a device from its own panel; powering it off closes it in every conversation, as the emulator\'s own window would'],
  ['windows.list', 'the desktop windows of this machine with their process, size and state; a title only for an app its project allows, since another title can name a document or an account'],
  ['windows.screenshot', 'one PNG of a window of an app its project allows or the owner allows on a card, written inside its own folder, project or temporary folder; excluded apps never, and the capture shows in its timeline'],
  ['windows.clip', 'a contact sheet of a few seconds of such a window, on the same terms as windows.screenshot'],
  ['windows.watch', 'showing such a window in its own conversation\'s Window panel; nothing is captured until the person watching presses Show'],
  ['windows.close', 'emptying its own conversation\'s Window panel'],
  // windows.frame stays with the owner and paired devices: the stream is for the person watching, a screenshot gives
  // the agent the window. windows.consent, windows.allowlist and windows.revoke are the owner's: the agent asks, never answers.
  // devices.stream and devices.clipboard stay with the owner and paired devices: the video is for the person
  // watching, a screenshot already gives the agent the screen, and the device's clipboard can hold what that person copied.
  ['questions.ask','a question card on its own thread that it does not wait on; the answer comes back as a message'],
  ['questions.list', 'read pending question cards on its own thread without creating another card; answers remain the user\'s'],
  // Ask returns a temporary ref; use consumes it once in its requesting turn (secrets/use.ts).
  // List remains metadata-only compatibility for older clients and guides.
  ['secrets.ask', 'a masked card on its own thread asking the user for a key; it gets back a ref, never the value'],
  ['secrets.use', 'consuming a temporary ref of its own running turn: written to an ignored file of its folder, or handed to one command whose output comes back masked'],
  ['secrets.list', 'compatibility metadata for its own thread, always an empty list with no values'],
  ['agent.settings', 'the settings it may ask the user about, with their values and pages; credentials, accounts and browser profiles are not among them'],
  ['settings.request', 'a settings card on its own thread proposing a change or pointing at a page; only the owner applies it, through settings.set'],
  ['agents.settings.read', 'the settings of one of the owner\'s agents a card may propose to change (name, domain, instructions, avatar, status, projects, model, effort, memory pass, subagents, daily budget), so it reads before it proposes; never their brains or conversations'],
  ['agents.settings.request', 'a card on its own thread proposing a change to one agent setting; only the owner applies it, through agents.settings.apply'],
  ['agents.create', 'creating the bot the user asked its thread for, as the Bots page would, without a card: the owner chose to let threads set bots up on their own (2026-10-24)'],
  ['artifacts.publish', 'explicitly sharing a bounded snapshot from its own working directory in its own conversation'],
  ['artifacts.read', 'reading back only a published snapshot belonging to its own conversation'],
  ['artifacts.view', 'showing one HTML page of its own working directory in its own conversation, embedded whole, on an opaque origin that loads and calls nothing'],
  ['artifacts.viewCheck', 'checking its own local HTML with the view sandbox in an isolated browser, returning captures without publishing or opening a panel'],
  ['artifacts.preview', 'showing an HTML artifact and its neighbouring assets inside its own working directory, on an isolated origin'],
  ['artifacts.previewClose', 'closing only an HTML preview belonging to its own conversation'],
  ['threads.tasks.set', 'the plan the tasks surface draws, from an agent whose protocol carries no todo tool'],
  ['threads.tasks.get', 'the same plan read back, so a new process continues the list it did not write'],
  ['todos.list', 'the project cards, shared with the other threads of the project'],
  ['todos.add', 'what surfaced during the work and belongs to the project, not to this turn'],
  ['todos.update', 'claiming a card it finished, which is a request for confirmation, never the confirmation'],
  ['threads.goal.track', "a reviewed goal on its own thread whose objective is the user's last prompt verbatim, when that prompt holds several requests; refused unless the user turned Automatic goals on"],
  ['git.status', 'what it changed in the working directory, without spawning a git of its own'],
  ['git.diff', 'both sides of one file, for the same reason'],
  ['files.list', 'one directory of the working directory it already runs in'],
  ['files.read', 'one file of it, text inline and anything else through a ticket'],
  // Diagnostics reach an agent anonymized, and only while the owner leaves agentLogAccess on (checked in diagnostics.ts).
  ['diagnostics.logs', 'anonymized app records so it can tell whether Boite itself failed; paths, names and addresses are placeholders'],
  ['diagnostics.summary', 'the anonymized environment and grouped recent problems'],
  ['diagnostics.export', 'the anonymized export a developer reads, the same file the owner would send'],
  ['diagnostics.issue', 'a GitHub issue draft about Boite and its prefilled link; only the owner publishes it, so an agent never posts publicly under their login'],
]);

/**
 * The one diff a paired device asks for is the Changes panel's: the working
 * tree against HEAD. Any other revision would let it walk the repository's
 * history, which is the owner's to browse.
 */
export function deviceDiffRef(ref: unknown): boolean {
  return ref === undefined || ref === '' || ref === 'HEAD';
}

/** Who calls: the owner, a paired device, or the agent of the one thread its token names. */
export interface Caller {
  principal: Principal;
  threadId: string | null;
}

export interface AccessRefusal {
  message: string;
  data: { method: RpcMethodName; principal?: Principal; threadId?: unknown };
}

/**
 * Why `caller` may not call `method`, or null when it may. The params are read
 * for little: an agent speaks for its own thread, so a call naming another one
 * is refused, and a device reads only the last quota reading and the working
 * tree's diff. A method in neither list is the owner's.
 */
export function accessRefusal(method: RpcMethodName, caller: Caller, params?: unknown): AccessRefusal | null {
  if (caller.principal === 'owner') return null;
  if (caller.principal === 'agent') {
    if (!AGENT_METHODS.has(method)) return { message: `${method} is not one of the agent's methods`, data: { method, principal: 'agent' } };
    const named = (params as { threadId?: unknown } | null | undefined)?.threadId;
    if (caller.threadId === null || named !== caller.threadId) {
      return { message: `${method} is for thread ${caller.threadId ?? 'none'}, not thread ${String(named)}`, data: { method, threadId: named } };
    }
    return null;
  }
  if (method === 'git.diff' && !deviceDiffRef((params as { ref?: unknown } | null | undefined)?.ref)) {
    return { message: 'git.diff: paired devices compare the working tree with HEAD only', data: { method, principal: caller.principal } };
  }
  if ((method === 'quotas.list' || method === 'subscriptionProxy.quotas') && (params as { refresh?: unknown } | null | undefined)?.refresh === true) {
    return { message: `${method}: paired devices read the last reading; refresh must be false or absent`, data: { method, principal: caller.principal } };
  }
  if (DEVICE_METHODS.has(method)) return null;
  return { message: `${method} is for the owner only`, data: { method, principal: caller.principal } };
}

/** Whether a connection of `principal` hears `name` at all; `agentHearsEvent` narrows an agent's to its thread. */
export function mayHearEvent(name: RpcEventName, principal: Principal): boolean {
  return principal === 'owner' || (principal === 'agent' ? AGENT_EVENTS : DEVICE_EVENTS).has(name);
}

/** Events any socket hears only while it is subscribed to the thread they name. */
export const SUBSCRIBED_EVENTS: ReadonlySet<RpcEventName> = new Set<RpcEventName>(['collaboration.changed', 'delegation.changed', 'workflows.changed']);

/** The thread an event is about, when its payload names one. */
export function eventThreadId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { threadId?: unknown }).threadId;
  return typeof value === 'string' ? value : null;
}

/**
 * Of the events `mayHearEvent` lets an agent hear, those about the thread its
 * token names (`threadId`, null when unbound), and the board of that thread's
 * project, which `projectOf` reads.
 */
export function agentHearsEvent(name: RpcEventName, payload: unknown, threadId: string | null, projectOf: (threadId: string) => string | null): boolean {
  if (!AGENT_EVENTS.has(name)) return false;
  if (name !== 'todos.updated') return eventThreadId(payload) === threadId;
  return threadId !== null && projectOf(threadId) === (payload as { projectId?: unknown }).projectId;
}
