/*
 * Who may call what.
 *
 * The owner is the process holding the core token: the shell, the dev client,
 * anything that can read `core.json`. A paired device holds a session token it
 * got through a pairing link, and it is a guest: it reads the threads and their
 * working trees (never writing a file), answers what an agent asks and sends
 * prompts. The one route it changes is the owner's saved subscription
 * gateway, which it may turn on or off and never reconfigure.
 *
 * An agent holds the per-thread token the core put in the environment of a
 * process its thread launched. It is the narrowest of the three: it reaches
 * `AGENT_METHODS` and only ever on its own thread.
 *
 * The device lists live in `packages/contracts/src/access.ts`, where the
 * in-memory client reads them too; the agent list is below. Together they are
 * the whole boundary: read them when asking what a stolen phone, or an agent
 * that went off, is worth. A method that is in neither is the owner's: a new
 * method added tomorrow is refused to both until someone decides otherwise,
 * on purpose.
 * core.logs stays owner-only: diagnostic causes can describe other threads,
 * local paths and account failures even after credential redaction. Agents
 * read the anonymized diagnostics.* view instead, which the owner can turn off.
 * resources.usage permits paired reads of sanitized metrics; process traces,
 * resource settings and tree termination remain owner-only.
 * speech.streamStart/Chunk/Finish permit phone dictation only through the
 * owner's configured engine; sessions and cancellation belong to one connection.
 * threads.archive lets a paired phone mark an idle conversation done under the
 * owner's retention policy. Direct removal and policy changes stay owner-only;
 * restoring an archive cancels its expiry before recoverable cleanup.
 * quotas.list and subscriptionProxy.quotas let a phone draw the same limit bars
 * as the owner without a dashboard embed; a forced refresh reaches the
 * providers and stays the owner's, as do monitoring switches and resets.
 * quotas.alert lets a phone choose when a window it already reads notifies;
 * the alert check reads only the accounts that have an alert, every five
 * minutes, the cadence the core keeps whoever set it.
 * subscriptionProxy.setEnabled lets a phone turn the owner's configured gateway
 * on or off; its kind, URLs and key stay owner-only (subscriptionProxy.configure).
 * push.kinds lets a paired device choose which kinds of notification its own
 * subscription receives; it reaches no other device's destination.
 * secrets.answer and secrets.delete reach a paired device only over an
 * encrypted link (`Connection.encrypted`): loopback, Tailscale, or HTTPS
 * terminated on this machine. Plain HTTP from the LAN is refused with the
 * reason, so a key or its deletion never crosses the network in clear.
 */

import { AGENT_EVENTS, DEVICE_EVENTS, DEVICE_METHODS, type RpcEventName, type RpcMethodName } from '@boite/contracts';
import { refused } from './errors.ts';
// Paired devices may prepare their own drafts and upload their own attachments: these are
// connection-owned subsets of threads.create and turns.start, with identical path and byte checks.
import type { Connection } from './router.ts';

export { AGENT_EVENTS, DEVICE_EVENTS, DEVICE_METHODS };

export function isDeviceMethod(method: RpcMethodName): boolean {
  return DEVICE_METHODS.has(method);
}

/**
 * The one diff a paired device asks for is the Changes panel's: the working
 * tree against HEAD. Any other revision would let it walk the repository's
 * history, which is the owner's to browse.
 */
export function deviceDiffRef(ref: unknown): boolean {
  return ref === undefined || ref === '' || ref === 'HEAD';
}

export function mayReceiveEvent(name: RpcEventName, connection: Connection): boolean {
  if (connection.identity.principal === 'owner') return true;
  return (connection.identity.principal === 'agent' ? AGENT_EVENTS : DEVICE_EVENTS).has(name);
}

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
  if (method === 'git.diff' && !deviceDiffRef((params as { ref?: unknown } | null | undefined)?.ref)) {
    throw refused('git.diff: paired devices compare the working tree with HEAD only', { method, principal: identity.principal });
  }
  if ((method === 'quotas.list' || method === 'subscriptionProxy.quotas') && (params as { refresh?: unknown } | null | undefined)?.refresh === true) {
    throw refused(`${method}: paired devices read the last reading; refresh must be false or absent`, { method, principal: identity.principal });
  }
  if (isDeviceMethod(method)) return;
  throw refused(`${method} is for the owner only`, { method, principal: identity.principal });
}
