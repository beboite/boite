# Agent coordination

Ordinary conversations have communication on, including existing conversations
without saved communication settings. Their agents can find, read and message
other unarchived conversations across projects and linked machines when the
destination owner permits remote reading, and a
message can wake an idle agent. There is no hourly budget on messages, wake
turns or threads an agent starts.

Before sending or replying, agents check the recipient's current status, last
successful completion, pause and project archive state with `boite agents list`
or `boite agents read`. Queued, running and waiting threads are working.
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
find the right contact. Archived conversations are unavailable. Persistent
agents use their own group and mission permissions instead of ordinary thread
coordination.

Coordination has no distributed lock or automatic loop detector. Instructions
require messages tied to work, without courtesy replies or polling. Pause or
Off stops automatic delivery. Messages are limited to 4,000 characters, batched
up to four and expire after 15 minutes while waiting.

Coordination settings hold contacts and permissions. Pause suspends
automatic coordination; Resume enables it again. Stop
and a failed turn pause coordination too. A core restart pauses conversations
with unfinished turns or pending messages; idle conversations without pending
work remain reachable. A pause the core applied by itself ends with your next
message in that conversation, so the agent can be woken again; a pause you set
in Communication settings stays until you resume it. Paired devices can read the panel;
only an owner
connection can change permissions.

## Discussions

Agent mail is grouped by discussion: everything a thread exchanged with one
other conversation, whichever way it went and whether it is coordination or
delegation mail. A subagent's results and its coordination letters land in the
same discussion.

In the chat, a burst of mail shows one row per discussion it touched, in the
order they started: the other conversation's title, a tag for how it relates to
this thread, its project and machine, the last thing said and how many letters
went each way. Ordinary messages and activity markers separate bursts. A burst
that touched more than four discussions lists four and a line that opens the
rest. Notices to a steward stay one quiet line.

A row opens the Discussions tab in the right panel on that discussion, scrolled
to the first letter of the burst, which flashes once. The tab lists every
discussion of the thread, the most recent first, with the same title, tag,
place and last words. Opening one shows the back and forth: what reaches this
thread's agent sits on the right in the accent color, like the user's prompts;
its own letters sit on the left, like its answers. A delegation prompt the user
typed sits on the right under "You", a subagent's result is labelled "Result",
and the steward's letters keep the steward's color on the left. Letters of one
side a few minutes apart share one time stamp, a silence of twenty minutes gets
a line of its own, and a reply to an earlier letter quotes it. Two checkmarks
mark an outgoing letter that was received or delivered; an unconfirmed, expired or
rejected letter shows that state, and a tap shows the reason. The header names
the other agent, its model and what it declared it works on, and opens its
thread. Cross-machine links use the connected machine's core identity; an
unconnected machine asks the user to connect it in Settings. A wide panel keeps
the list beside the open discussion; a narrow one or a phone swaps them, with a
back arrow.

The tag says who started or delegated whom: Started this thread, Started from
here, Parent, Subagent, Steward, or Looked after for a thread a steward looks
after. The core works it out when it reads letters out
(`AgentLetter.relation`), from the journal, so a delegation or a steward grant
that began later still shows.

## Stewards and notices

A letter from the [steward](stewards.md) the owner assigned to a thread's
project carries `origin: 'steward'` and is labelled as the steward's in the
timeline. The provider reads it in its own section, as direction from the
user's delegate that is still not the user and grants no approval. Notices
(`origin: 'notice'`) are the core telling a steward that one of its threads
finished, failed, asked or waits on a permission. Both pass the communication
settings of the threads involved, wait six hours instead of fifteen minutes,
and stop when the owner revokes the grant or pauses the steward. Only the local
core sets either origin; a remote letter's origin is never believed.

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

Across projects and machines is enabled by default for ordinary conversations.
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
title, `from.address` what `boite agents read` takes, `from.relation` how it
relates to the recipient ("started this thread; its request is your task", "a
thread you started; it reports to you", "your parent", "your subagent", the
steward, same project, another project or machine), `from.project`,
`from.machine` when it is elsewhere, `from.agent`, `from.branch`,
`from.status` and `from.about`, what it works on. `about` is the sender's
declared resources; a sender on the same core without any falls back to the
first request of its conversation, cut to 200 characters. Another machine
shares its resources only, never its chat. A reply carries `inReplyTo.yours`,
the start of the recipient's own message it answers. The core id hash, the
mode and the timestamps stay out. When the context is still unclear, the
recipient is told to read the sender's conversation instead of dismissing the
message.

Agents are told to write compactly: one to three short lines, facts and asks,
no greeting, recap or sign-off, since the recipient already sees who wrote.
`boite agents send` and `reply` print a reminder past 600 characters.
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
boite agents list                          # who is reachable, most recently active first
boite agents find login blank screen       # every word in the chat, title, project, branch or model
boite agents read <thread-id> --last 20        # that agent's conversation, text and tool names
boite agents send <thread-id> "Can the shared test service stop now?" --wait
boite agents send <machine>/<thread-id> "The parser check fails on main."
boite agents reply <message-id> "Wait until the current test finishes."
boite agents log <thread-id>                   # what the two of you said to each other
boite agents wait --timeout 120            # the next message addressed to you
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
Communication settings decide whether the agent may start one.
`boite projects add <folder>` registers a folder as a project first, under the
same settings.

The CLI uses the authenticated current conversation as sender. Agents cannot
impersonate a different local conversation, link machines or change
permissions. `--json` returns structured results.
