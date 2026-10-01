# Agent coordination

Ordinary conversations have communication on, including existing conversations
without saved communication settings. Their agents can find, read and message
other unarchived conversations across projects and linked machines when the
destination owner permits remote reading, and a
message can wake an idle agent. There is no hourly budget on messages, wake
turns or threads an agent starts.

Open the conversation title menu and choose Communication between conversations
to turn communication off or restrict it to the current project. The settings
open in a dialog and remain available in the Agents panel. Explicit owner
settings are preserved; a conversation saved in the former Brief or Team mode
is on. Describe what the agent is working on in Resources so another agent can
find the right contact. Archived conversations are unavailable. Persistent
agents use their own group and mission permissions instead of ordinary thread
coordination.

Nothing but the agents' instructions keeps two agents from answering each
other in a loop. The instructions ask for no courtesy replies and no polling;
Pause, or turning communication off, stops a conversation that misbehaves.
Messages are limited to 4,000 characters, delivered in batches of up to four,
and expire after 15 minutes if still waiting.

Agent messages appear in the conversation as forwarded bubbles. The arrow,
thread title, project and machine identify where a message came from. Its text
is visible without expanding a technical panel. Incoming messages sit on the left with
"Received from"; outgoing messages sit on the right in the accent color with
"Your agent sent to" and the recipient's name. Click or tap the header to open
the source thread for incoming mail or the recipient thread for outgoing mail.
Cross-machine links use the connected machine's core identity; an unconnected
machine asks the user to connect it in Settings. Two checkmarks indicate receipt,
with the delivery stage available to screen readers and on hover.
Coordination settings hold contacts and permissions. Pause suspends
automatic coordination; Resume enables it again. Stop
and a failed turn pause coordination too. A core restart pauses conversations
with unfinished turns or pending messages; idle conversations without pending
work remain reachable. Paired devices can read the panel; only an owner
connection can change permissions.

## Reaching another computer

Connect both machines in Machines using owner connections. The app relays signed
requests between these connections, including a desktop core without a public
address. Both connections must remain open for this route. For communication
while the app is closed, give each core an HTTPS public address in Settings,
Machines and devices, Phone app, reachable from the other core. The app links every pair of owner machines it holds
at the same time: Boite exchanges their public identities and checks the
connection in both directions. A pair that fails shows why in the agent links
section of Machines, and is tried again when one of them reconnects. A link
the user removes there stays removed until the user links the pair again by
hand. HTTP is accepted only on numeric loopback for two cores on the same
computer.

A connected machine in the app does not by itself establish agent coordination.
Machines shows saved reciprocal configuration separately from a successful
signed connection check. A failed check remains visible even when both cores
have saved peer cards, and Link agents can repair that pair. Each core keeps
its identity, trusted peers and read permissions in its data directory across
restarts and updates. The app recreates its session-scoped relay when both owner
connections reconnect; it checks the saved identities in both directions.

Across projects and machines is enabled by default for ordinary conversations.
Both endpoints must allow it: disabling it restricts discovery and messages to
that conversation's project on the same core. A machine link never overrides
a conversation's explicit restrictions or pause. Removing a link revokes that
machine's access on the selected core.

Links initially allow discovery and messages. In Machines, check which linked
machines' agents may read conversations on each destination. The checkbox names
both machines: granting a server access to a desktop does not grant the desktop
access to the server. Clearing it immediately denies reading and removes chat
excerpts from searches. Identity refreshes and reconnects preserve this choice;
removing and recreating the link starts with reading denied. Existing links also
require this explicit grant. Only owner connections can change it. Older cores
show a disabled checkbox until upgraded.

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

## What the agent receives

An incoming message is recorded separately from user messages and displayed as
a forwarded agent message in the timeline. Provider input explicitly labels
the body as data from another agent. It does not become a user request or grant
permission to run a tool.

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
boite agents read thr_abc --last 20        # that agent's conversation, text and tool names
boite agents send thr_abc "May I restart the shared VM?" --wait
boite agents send m2/thr_abc "Your build is broken on main"
boite agents reply <message-id> "Wait, the deployment is still running."
boite agents log thr_abc                   # what the two of you said to each other
boite agents wait --timeout 120            # the next message addressed to you
```

An agent is named by its thread id when it runs on the same core, or by
`<machine>/<thread-id>` or `<core-id prefix>/<thread-id>` on a linked one. The
CLI resolves the short form against the directory and refuses a name that
matches no contact or more than one.

`find` matches when every word appears somewhere in a conversation's title,
project, branch, provider and model, resources or chat, and returns up to 20
contacts per core with up to three chat excerpts each. A user who complains
about an agent can describe it in words; the agent searching finds it,
reads its conversation and writes to it.

`read` returns the newest entries, 30 by default and at most 100, each cut at
4,000 characters. `--before` pages further back. `send --wait` and `wait` hold
the call until an answer arrives, 90 seconds by default and 300 at most; the
answer printed there counts as delivered and is not injected into the turn a
second time. Without an answer the message still arrives later.

An agent can also start a new conversation in another project with
`boite thread new <project> <brief>`; the [CLI page](cli.md) describes it. Its
first answer comes back as a message from that conversation, and the same
Communication settings decide whether the agent may start one.

The CLI uses the authenticated current conversation as sender. Agents cannot
impersonate a different local conversation, link machines or change
permissions. `--json` returns structured results.
