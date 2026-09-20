# Agent coordination

Open **Agent coordination** above a conversation to let its agent contact other
agents. It starts off. Choose Brief for occasional questions about a shared
resource, or Team for a task that needs several agents. Describe what the agent
is working on in Resources so another agent can find the right contact.

| Mode | Messages sent per hour | Automatic wake turns per hour | Messages received per hour |
| --- | --- | --- | --- |
| Brief | 6 | 2 | 20 |
| Team | 40 | 12 | 100 |

These are rolling limits enforced by the core. An agent cannot raise them.
Messages are limited to 4,000 characters, delivered in batches of up to four,
and expire after 15 minutes if still waiting. Agents are instructed to send
only useful questions or answers, without courtesy replies or repeated polling.
Wake limits bound new turns, not the tokens used inside a turn.

The panel shows contacts, budgets and the exchange history. Expand a message to
read it. Pause suspends automatic coordination; Resume enables it again. Stop,
a failed turn and a core restart pause coordination too. Paired devices can read
the panel; only an owner connection can change permissions.

## Reaching another computer

Connect both machines in Machines using owner connections. Give each core an
HTTPS public address in General settings, reachable from the other core. Then
use the agent coordination section in Machines to link them. Boite exchanges
their public identities and checks the connection in both directions. HTTP is
accepted only on numeric loopback for two cores on the same computer.

Each participating conversation must also enable Across projects and machines.
Without it, discovery and messages stay within that conversation's project on
the same core. A machine link does not enable every conversation. Removing a
link revokes that machine's access on the selected core.

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

An incoming message is recorded as a system event in the timeline, with its
agent and machine in the coordination panel. Provider input explicitly labels
the body as data from another agent. It does not become a user request or grant
permission to run a tool.

Claude receives messages at its next PostToolUse hook. Codex uses `turn/steer`
with the active turn ID. Pi uses its `steer` RPC. Providers without an interrupt
mechanism receive a new coordination turn once the current turn ends. An idle
conversation can wake within its hourly budget. A permission or question prompt
is never answered by coordination.

Received means that the destination core accepted the message. Delivered means
that the provider accepted the input, or a scheduled coordination turn completed.
It does not prove that the agent understood, agreed or finished acting. Uncertain
means submission may have happened; Boite does not replay it automatically.
An offline machine leaves outgoing messages queued until recovery or expiry.

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

The CLI uses the authenticated current conversation as sender. Agents cannot
impersonate a different local conversation, link machines or change budgets.
Addresses include both core and thread IDs because thread IDs can collide
between machines. `--json` returns structured results.
