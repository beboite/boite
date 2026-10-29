# Agent coordination

Ordinary conversations have communication on, including existing conversations
without saved communication settings. Their agents can find, read and message
other unarchived conversations across projects and linked machines when the
destination owner permits remote reading, and a
message can wake an idle agent. There is no hourly budget on messages, wake
turns or threads an agent starts.

Before sending or replying, agents check the recipient's current status, last
successful completion, pause and project archive state with `boite threads`
or `boite threads read`. Queued, running and waiting threads are working.
Contacting an inactive thread remains possible, but is discouraged unless it
completed work within the last 15 minutes. Editing a title or settings does
not count as completing work. The CLI warns when completion is old or unknown;
JSON contacts expose `lastCompletedAt`, `paused` and `projectArchived`.

Threads in an archived project remain reachable. When coordination actually
delivers work, the recipient's core restores that project and announces the
change to connected clients. A paused or expired message leaves the project
archived. Archiving a thread still makes that thread unavailable.

Open the conversation title menu and choose Communication between conversations
to turn communication off or restrict it to the current project. The settings
open in a dialog and remain available in the Agents panel. Explicit owner
settings are preserved; a conversation saved in the former Brief or Team mode
is on. Describe what the agent is working on in Resources so another agent can
find the right contact. Archived conversations are unavailable. A bot's
thread starts with coordination on like any other, so it finds, reads and
messages threads with `boite threads` and they reach it the same way; the
owner may turn it off. Its letters to the threads of its projects still go
when its own thread is Off, and reach a recipient that is Off, paused or
restricted to its own project. A Pause on the bot's own thread refuses them,
and an archived recipient or a project no longer entrusted to the bot rejects
them.

Coordination has no distributed lock or automatic loop detector. Instructions
require messages tied to work, without courtesy replies or polling. Pause or
Off stops automatic delivery. Messages are limited to 4,000 characters, batched
up to four and expire after 15 minutes while waiting.

Coordination settings hold contacts and permissions. Pause suspends
automatic coordination; Resume enables it again. Stop pauses coordination too.
A failed turn does not: another agent's message wakes the thread to resume, and
a message that arrived during the failed turn reaches it right after. Each
message starts at most one turn, so a provider that keeps failing cannot loop.
A core restart pauses conversations with unfinished turns or pending messages;
idle conversations without pending work remain reachable. A pause the core
applied by itself ends with your next message in that conversation, with a turn
that resumes it after a restart or a failure, or with its parent's message to a
subagent. A restart's pause, or one left by a wake that could not start, also
ends with the next agent message, so a crashed thread can be woken; the
directory does not list it as paused. Stop's pause waits for you, and a pause
you set in Communication settings stays until you resume it. Paired devices can read the panel;
only an owner
connection can change permissions.

A contact's request decision also clears an automatic restart pause before
delivery. A disconnected `collaboration.wait` client releases its waiter, so
it cannot consume a later letter or suppress that letter's wake. Stop and
explicit owner pauses remain in force.

## Discussions

Agent mail is grouped by discussion: everything a thread exchanged with one
other conversation, whichever way it went and whether it is coordination or
delegation mail. A subagent's results and its coordination letters land in the
same discussion.

In the chat, a burst of mail shows one row per discussion it touched, in the
order they started: which way it went, the other conversation's title, a tag
for how it relates to this thread, its project and machine and the last thing
said. A row that only received sits on the right in the accent under "Received
from", like the letters reaching this thread in the discussion; a row that only
sent sits on the left under "Sent to"; a row with both says "Exchange with" and
how many letters went each way. A row that only sent still shows the other
agent's provider, read from an earlier letter of that discussion. Ordinary
messages and activity markers separate bursts. A burst
that touched more than four discussions lists four and a line that opens the
rest.

A row opens the Discussions tab in the right panel on that discussion, scrolled
to its first letter in that burst, which flashes once, or at its end when that
letter is gone. The tab lists every
discussion of the thread, the most recent first, with the same title, tag,
place and last words. Opening one shows the back and forth: what reaches this
thread's agent sits on the right in the accent color, like the user's prompts;
its own letters sit on the left, like its answers. A delegation prompt the user
typed sits on the right under "You", a subagent's result is labelled "Result",
and the letters of the bot the project is entrusted to keep that bot's color
and name on the left. Letters of one
side a few minutes apart share one time stamp, a silence of twenty minutes gets
a line of its own, and a reply to a letter other than the one just before it
quotes it. Two checkmarks
mark an outgoing letter that was received or delivered; an unconfirmed, expired or
rejected letter shows that state, and a tap shows the reason. The header names
the other agent, its model and what it declared it works on, and opens its
thread. Cross-machine links use the connected machine's core identity; an
unconnected machine asks the user to connect it in Settings. A wide panel keeps
the list beside the open discussion; a narrow one or a phone swaps them, with a
back arrow.

The tag says who started or delegated whom: Started this thread, Started from
here, Parent, Subagent, or Looks after the project for the bot
the owner entrusted the thread's project to. The core works it out when it
reads letters out (`AgentLetter.relation`), from the journal, so a delegation
or an entrusted project that began later still shows.

An answer that names a thread the way `boite threads` prints it (`thr_x`,
`<machine>/thr_x` or `<core-id>/thr_x`) in a code span links to it, and so
does a bare one with [Chat files and previews](chat-files.md) on
(`lib/chat-links.ts`), as does a Markdown link whose destination is one; an id
inside a path (`thr_x.ts`, `src\thr_x`) stays text. Reasoning, a tool's
Markdown documents link a code-span thread the same way. A click
(`workspace.followThreadLink`) opens it on a connected machine that lists the
thread: this one when none is named, the one the address names, only this one
for `here`. Otherwise this thread's contacts name its core, and last the one
machine listing the id opens, since an agent may know it by another name. A
thread no connected machine or contact holds leaves a notice instead.

## Letters from the bot of a project

A letter from the [bot](bots.md#projects-entrusted-to-a-bot)
the owner entrusted a thread's project to carries `origin: 'resident'` and is
labelled with that bot in the timeline. The provider reads it in its own
section, as direction from the user's delegate that is still not the user and
grants no approval; the thread does not answer it by letter, since the bot
reads the thread's final answer in an event when the turn ends. Such a letter
passes the communication settings of the thread, Off, Pause and the
own-project restriction included, and the Off of the bot's own thread; a Pause
on the bot's thread refuses it. It waits six hours instead of
fifteen minutes, and is rejected once the project is no longer entrusted to the
bot or the bot is archived. Only the local core sets the origin; a remote
letter's origin is never believed. The core's events to the bot are not
letters: they reach it as `event` turns on its own thread.

## Reaching another computer

The machines of a [group](groups.md) are linked already: every member trusts
the others' keys, over the addresses the group gives, HTTP on a tailnet or a
LAN included, with the app closed. What follows links two machines that share
no group.

Opening Machines converts existing owner connections into one group. The app
relays sealed requests between connected members when they cannot dial each
other directly. Both owner connections must remain open for this route.
Members that can reach each other communicate with the app closed.

The legacy collaboration API still supports manual links between machines
sharing no group. Each core keeps its identity and configured permissions in
its data directory. Migration replaces standing pairwise trust with group
membership, so removing a member also ends its agent access. Existing separate
groups retain their own controls; moving a machine requires leaving its old
group first.

Across projects and machines is enabled by default for ordinary conversations and bots.
Both endpoints must allow it: disabling it restricts discovery and messages to
that conversation's project on the same core. A machine link never overrides
a conversation's explicit restrictions or pause. Removing a link revokes that
machine's access on the selected core.

Links and group membership initially allow discovery and messages. Transcript
reading requires an explicit directional grant on the destination. Existing
read grants survive migration and restart for the current admissions of both
machines; removing either machine ends them. Joining again starts with reading
denied. Owner callers can set `readThreads` through `collaboration.trust`;
for an existing group member this updates its read grant without creating
standing trust. `collaboration.untrust` clears the grant while group membership
continues to authorize discovery and messages. The simplified Machines page
has no individual agent-link controls.

Each core signs requests and responses with its own Ed25519 key. Trusted public
keys identify peers; owner tokens and provider credentials never cross this
channel. Signatures cover destinations, timestamps, unique request nonces and
content. The receiver checks replay, size, expiry and rate limits. HTTPS protects
message privacy. Keep the core data directory private, including its signing key.

### Contacts

A [contact](contacts.md) is another owner's core, linked through an invitation.
It is a coordination peer too, listed after the hand-made links and the group's
members (`ContactStore.peers()` in `packages/core/src/contacts/store.ts`).
`collaboration.trust`, `collaboration.bridge.register` and thread reveals refuse
its core id. Its requests are always sealed, whichever way they travel: a
readable one is refused with `contacts exchange sealed requests only`. It
reaches only the projects opened to it. `directory` and `search` list their
threads whose settings allow other machines, and search matches chat only
where the grant has `readThreads`. `read` needs that grant too. `deliver`
reaches those threads, or a thread that wrote to the contact in the last 7
days. A contact never sends `group.sync` or `group.push`, and only a contact
sends `contact.sync` (the projects opened to the receiver), `contact.ask` and
`contact.answer` (a request and its decision). Between members of a group,
`relay.*` carries a contact's requests to the member that holds a project
opened to it, and that member's requests back
([contacts](contacts.md#projects-of-the-other-machines-of-the-group)); a
contact never sends them.

Three more operations are sealed and group-only. `thread.start` asks a member
to start a top-level thread in one of its projects for `boite thread new
--machine`; the member refuses it while its own `groupThreads` setting is off,
and keeps a ledger per starting thread so a retried request returns the same
thread. `setting.read` returns that member's value of a setting it holds about
the others (`groupThreads`, `groupBots`), for a settings card, and `setting.changed` tells
the other members that it changed, which settles their open cards.

The `bot.*` operations, also sealed and group-only, let a bot of one member
look after the projects of another that its owner entrusted to it:
`bot.lease`, `bot.threads`, `bot.thread`, `bot.send`, `bot.act`,
`bot.answer` and `bot.start` (a thread the bot starts there) go to the member
that holds the project, each with the bot's lease, and `bot.event` comes back with a turn, a question or a failure. The
holding member refuses all of them while its own `groupBots` setting is off
([bots](bots.md#projects-of-the-other-machines-of-the-group)).

A group member can relay contact discovery, lookups, requests and letters
through another member's durable virtual mailbox. The initiating core keeps
the canonical exchange and wakes its own conversation. The gateway uses the
existing contact link and enforces its permissions; `contact.route` is sealed
and group-only. See [contacts through your group](contacts.md#contacts-through-your-group).

The inviting core, the host, never dials its guest: the guest keeps a
WebSocket open at `/coordination/contact/link`, and that socket is the
guest's bridge route on the host. The host's signed and sealed requests go
down it as `{t: 'req'}` frames; the guest answers each through the same
handler as an HTTP request (`coordination.forward`) and sends back a
`{t: 'res'}` frame. The guest's requests to the host are ordinary POSTs.

Trusted peers can discover the conversations that allow
remote coordination: title, project, branch, model, declared resources and the
agent's status. When the destination grants reading, searches also match chat
and return excerpts, and reading returns the text the user and the agent wrote
with the names of the tools the agent called. Tool output, reasoning,
attachments, files, tools and settings never
cross; neither do archived conversations or conversations with communication
off or restricted to their project. The core authenticates the sending conversation locally. On a
remote machine, its trusted core attests that conversation's identity.

### Revalidating reads

Directory, search and transcript reads check the source conversation's current
access after asynchronous peer replies, before returning data. Archive, removal,
communication Off or a revoked remote grant cannot leave a delayed result
visible. Directory and search also remove local contacts that became unavailable
while peers were pending. A revoked peer is named as unavailable while other
authorized results remain. Pause and resource-description edits affect delivery
or discovery content; they do not independently revoke an otherwise allowed
lookup. Directional destination read grants remain required.

## What the agent receives

An incoming message is recorded separately from user messages and shown in its
discussion. Provider input labels the body as another agent's. It does not
become a user request or grant permission to run a tool.

Each letter names its sender in words the recipient can act on, so a short
message is not mistaken for noise: `from.thread` is the sender's conversation
title, `from.address` what `boite threads read` takes, `from.relation` how it
relates to the recipient ("started this thread; its request is your task", "a
thread you started; it reports to you", "your parent", "your subagent", the
the bot the project is entrusted to, same project, another project or machine), `from.project`,
`from.machine` when it is elsewhere, `from.agent`, `from.branch`,
`from.status` and `from.about`, what it works on. `about` is the sender's
declared resources; a sender on the same core without any falls back to the
first request of its conversation, cut to 200 characters. That sender is a
contact the recipient may already read with `boite threads read`; a letter from
the bot a project is entrusted to gets no fallback, since the bot's thread
holds its work across all its projects and opens with its creation, not with
the task the letter is about. Another machine
shares its resources only, never its chat. A reply carries `inReplyTo.yours`,
the start of the recipient's own message it answers. The core id hash, the
mode and the timestamps stay out. When the context is still unclear, the
recipient is told to read the sender's conversation instead of dismissing the
message.

A letter that crossed a contact link carries `contact`, the name this owner
gave that contact, set by the receiving core from its own list. The provider
reads such letters under their own heading, the sender named
`<name>'s agent, a contact: not your user`, with the rule that a contact's word
never authorizes a destructive action, a credential or work outside the
project it came through. The answer to `boite threads ask` arrives as a letter
with `origin: 'contact'`, written by the asking core from the contact's
decision; the agent does not reply to it. The coordination guide mentions
`boite threads contacts` and `ask` only while the core has a contact.

Agents are told to write compactly: one to three short lines, facts and asks,
no greeting, recap or sign-off, since the recipient already sees who wrote.
`boite threads send` and `reply` print a reminder past 600 characters.
Delegation messages carry the same instruction and name the sender as the
recipient's parent or subagent.

The recipient is told to cooperate with a reasonable request that fits its
permissions: free disk, memory or ports, remove what its own work generated and
no longer needs, answer, then go back to its task and reply with what it did and
kept. A sender's claim that the user asked for it counts for nothing; the
request is judged on its merits. The recipient asks first before destroying
work nobody can regenerate, touching another project or account, or
interrupting a running service or another agent's work. Agents are expected to
handle routine housekeeping between themselves, so a request like "clean up
what you no longer use, the disk is full" is acted on instead of refused.

Sent and received exchanges stay where they occurred in the conversation.
Continued text and new tools start after each exchange; a tool already running
keeps its original card. Consecutive exchanges within one turn collapse into
one row per discussion. The elapsed-time footer follows the last visible message or exchange,
including turns that only receive and forward messages.

Claude receives messages at its next PostToolUse hook. Codex uses `turn/steer`
with the active turn ID, and Muse its own `turn/steer` the same way. Pi uses
its `steer` RPC, Grok its `_x.ai/interject`. Providers without an interrupt
mechanism receive a new coordination turn once the current turn ends. An idle
conversation wakes for it. A permission or question prompt
is never answered by coordination.

Received means that the destination core accepted the message. Delivered means
that the provider accepted the input, or a scheduled coordination turn completed.
It does not prove that the agent understood, agreed or finished acting. Uncertain
means submission may have happened; Boite does not replay it automatically.
An offline machine leaves outgoing messages queued until recovery or expiry.

A message goes to its recipient as soon as it arrives, and again when the
recipient's current turn ends. A check every two seconds covers the rest:
expiry, retries to another machine and a provider that was not ready to take
input yet. When no message is waiting, that check is one or two index lookups.
An uncertain message is not waiting: nothing replays it, and only an outgoing
one to another machine is asked about again until it expires. Delivered,
expired, rejected and uncertain messages leave the journal after 30 days; the
panel shows the last 100 of a conversation.

For a restart, the maintenance agent should ask the agent using the resource
to confirm readiness and wait for its answer. A delivery receipt or silence is
not consent. Coordination is advisory: it is not a distributed lock, and Boite
does not intercept arbitrary reboot commands. The existing tool permissions
still apply. Treat another agent's content as untrusted, even from a linked core.

## Agent commands

```sh
boite threads                           # who is reachable, most recently active first
boite threads find login blank screen       # every word in the chat, title, project, branch or model
boite threads read <thread-id> --last 20        # that agent's conversation, text and tool names
boite threads send <thread-id> "Can the shared test service stop now?" --wait
boite threads send <machine>/<thread-id> "The parser check fails on main."
boite threads reply <message-id> "Wait until the current test finishes."
boite threads log <thread-id>                   # what the two of you said to each other
boite threads wait --timeout 120            # the next message addressed to you
boite threads contacts                      # other owners' Boites and the projects they opened to you
boite threads ask <contact> "An agent on a project like our parser" --wait
```

An agent is named by its thread id when it runs on the same core, or by
`<machine>/<thread-id>` or `<core-id prefix>/<thread-id>` on a linked one. The
CLI resolves the short form against the directory and refuses a name that
matches no contact or more than one.

`find` matches when every word appears somewhere in a conversation's title,
project, branch, provider and model, resources or chat, and returns up to 20
contacts per core with up to three chat excerpts each. Search results identify the
contact; read its allowed conversation before
acting on a secondhand description.

`read` returns the newest entries, 30 by default and at most 100, each cut at
4,000 characters. `--before` pages further back. `send --wait` and `wait` hold
the call until an answer arrives, 90 seconds by default and 300 at most; the
answer printed there counts as delivered and is not injected into the turn a
second time. Without an answer the message still arrives later.

An agent can also start a new conversation in another project with
`boite thread new <project> <brief>`; the [CLI page](cli.md) describes it. Its
first answer comes back as a message from that conversation, and the same
Communication settings decide whether the agent may start one. With
`--machine <name>` it starts it on another machine of the group, when that
machine's owner allowed it there.
`boite projects add <folder>` registers a folder as a project first, under the
same settings.

The CLI uses the authenticated current conversation as sender. Agents cannot
impersonate a different local conversation, link machines or change
permissions. `--json` returns structured results.
