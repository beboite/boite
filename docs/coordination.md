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

Consecutive agent exchanges appear in the conversation as compact counts:
"Forwarded 13 messages" and "Received 20 messages". Ordinary messages and
activity markers separate bursts. A count opens the Messages tab in the right
panel, filtered to that direction and scrolled to the selected burst. The tab
also opens from the panel launcher and offers All, Sent and Received filters.
It updates with new mail and keeps its filter across reloads. Unconfirmed,
expired and rejected messages add an attention count to the summary.

The tab retains each message's bubble, text, age and delivery status. The arrow,
thread title, project and machine identify the other conversation. Received
messages use the accent color on the right; agent-authored outgoing messages
sit on the left. User-authored delegation prompts retain the accent color.
Click or tap a bubble's header to open
the source thread for incoming mail or the recipient thread for outgoing mail.
Cross-machine links use the connected machine's core identity; an unconnected
machine asks the user to connect it in Settings. Two checkmarks indicate receipt,
with the delivery stage available to screen readers and on hover.
Coordination settings hold contacts and permissions. Pause suspends
automatic coordination; Resume enables it again. Stop
and a failed turn pause coordination too. A core restart pauses conversations
with unfinished turns or pending messages; idle conversations without pending
work remain reachable. A pause the core applied by itself ends with your next
message in that conversation, so the agent can be woken again; a pause you set
in Communication settings stays until you resume it. Paired devices can read the panel;
only an owner
connection can change permissions.

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

An incoming message is recorded separately from user messages and displayed as
a forwarded agent message in the timeline. Provider input explicitly labels
the body as data from another agent. It does not become a user request or grant
permission to run a tool.

Sent and received exchanges stay where they occurred in the conversation.
Continued text and new tools start after each exchange; a tool already running
keeps its original card. Consecutive exchanges collapse into counters within
one turn. The elapsed-time footer follows the last visible message or exchange,
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
