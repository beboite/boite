# Agent coordination

Ordinary conversations start in Brief mode, including existing conversations
without saved communication settings. Their agents can contact other unarchived
conversations across projects and mutually trusted machines, and can wake an
idle agent within its hourly budget. No machine is trusted automatically.

Open **Communication settings** above a conversation to disable communication,
restrict it to the current project, or choose Team for a task that needs several
agents. Explicit owner settings are preserved. Describe what the agent is
working on in Resources so another agent can find the right contact. Archived
conversations are unavailable. Persistent agents use their own group and mission
permissions instead of ordinary thread coordination.

| Mode | Messages sent per hour | Automatic wake turns per hour | Messages received per hour |
| --- | --- | --- | --- |
| Brief | 6 | 2 | 20 |
| Team | 40 | 12 | 100 |

These are rolling limits enforced by the core. An agent cannot raise them.
Messages are limited to 4,000 characters, delivered in batches of up to four,
and expire after 15 minutes if still waiting. Agents are instructed to send
only useful questions or answers, without courtesy replies or repeated polling.
Wake limits bound new turns, not the tokens used inside a turn.

Agent messages appear in the conversation as forwarded bubbles. The arrow,
sender name and machine identify where a message came from; its text is visible
without expanding a technical panel. Incoming messages sit on the left with
"Received from"; outgoing messages sit on the right in the accent color with
"Your agent sent to" and the recipient's name.
Coordination settings hold contacts, budgets and permissions. Pause suspends
automatic coordination; Resume enables it again. Stop
and a failed turn pause coordination too. A core restart pauses conversations
with unfinished turns or pending messages; idle conversations without pending
work remain reachable. Paired devices can read the panel; only an owner
connection can change permissions.

## Reaching another computer

Connect both machines in Machines using owner connections. Give each core an
HTTPS public address in Settings, Machines and devices, Phone app, reachable
from the other core. Then
use the agent coordination section in Machines to link them. Boite exchanges
their public identities and checks the connection in both directions. HTTP is
accepted only on numeric loopback for two cores on the same computer.

Across projects and machines is enabled by default for ordinary conversations.
Both endpoints must allow it: disabling it restricts discovery and messages to
that conversation's project on the same core. A machine link never overrides
a conversation's explicit restrictions or pause. Removing a link revokes that
machine's access on the selected core.

Each core signs requests and responses with its own Ed25519 key. Trusted public
keys identify peers; owner tokens and provider credentials never cross this
channel. Signatures cover destinations, timestamps, unique request nonces and
content. The receiver checks replay, size, expiry and rate limits. HTTPS protects
message privacy. Keep the core data directory private, including its signing key.

Trusted peers can discover titles and declared resources of conversations that
allow remote coordination. They do not gain access to transcripts, files, tools
or settings. The core authenticates the sending conversation locally. On a
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
conversation can wake within its hourly budget. A permission or question prompt
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
boite agents list
boite agents inbox
boite agents send <core-id>/<thread-id> "May I restart the shared VM?"
boite agents reply <message-id> "Wait, the deployment is still running."
```

An agent can also start a new conversation in another project with
`boite thread new <project> <brief>`; the [CLI page](cli.md) describes it. Its
first answer comes back as a message from that conversation, and the same
Communication settings and a separate hourly budget (3 in Brief, 12 in Team)
decide whether the agent may start one.

The CLI uses the authenticated current conversation as sender. Agents cannot
impersonate a different local conversation, link machines or change budgets.
Addresses include both core and thread IDs because thread IDs can collide
between machines. `--json` returns structured results.
