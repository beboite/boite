# Contacts

Behind the Contacts experiment ([experiments](experiments.md)). Not ready for a
stable channel: a full security pass and a network pass come first.

A contact is another owner's Boite. Your agents and theirs work together on the
projects each side opens to the other, and on nothing else. A contact never
sees your other projects, your group, your devices or your other contacts. The
machines of your own [group](groups.md) stay what they are: full control,
yours only.

## Linking two owners

Tailscale carries the link, with each owner keeping their own tailnet. The
inviter shares one machine with the invitee through Tailscale's machine
sharing; the invitee's tailnet sees that machine and nothing else of the
inviter's. Only the inviter's machine is shared. The invitee's core dials it
and keeps one link open, and the inviter's requests to the invitee travel on
that link: Tailscale quarantines a shared machine, which answers connections
but opens none, and the invitee exposes nothing.

A share only reaches another tailscale.com tailnet. A Headscale tailnet, or a
machine without Tailscale, never meets the inviter's coordination server:
it can neither resolve nor reach the inviter's tailnet name. For such an
invitee the inviter opens Boite's contact routes to the internet through
Tailscale Funnel instead (below). Only the inviter must be reachable, so
between a Headscale owner and a tailscale.com owner, the tailscale.com owner
invites. A Headscale inviter can only invite someone on its own tailnet.

1. The inviter's **Invite a contact** (`contacts.invite`) makes a one-time link
   valid 24 hours: `boite://contact#` then the inviter's core id, signing
   key, sealing key, machine name, tailnet URL, a one-time token and the
   Tailscale share link. With a Tailscale API key stored
   (`contacts.tailscaleKey`), the core creates the share itself
   (`POST /api/v2/device/{id}/device-invites`, single use); without one the
   invitation says so and the owner shares the machine from the Tailscale
   admin console. The page offers three buttons: **On another Tailscale**
   does the above, **Already on my Tailscale** (`contacts.invite` with
   `share: false`) is for an invitee on the same tailnet, or one this
   machine is already shared with: no share is made or asked for, the link
   carries none and the invitee's Join card offers no share to accept.
   **Elsewhere** (`internet: true`) is for an invitee on another network:
   the link names `https://<machine>.<tailnet>.ts.net:8443`, Boite's contact
   routes on Tailscale Funnel, and carries no share. On a tailnet whose names
   are not under `ts.net` (Headscale) **On another Tailscale** and
   **Elsewhere** are off, a line says the other owner invites, and the core
   refuses both with that reason.
   While invitations are open the page counts them beside **Cancel them**
   (`contacts.cancelInvites`), which spends every one unused: a link sent
   too widely, or one that leaked, creates no contact any more, and the
   tailnet listener closes when no hosted contact needs it. Contacts already
   joined stay. The Tailscale share a link carries is not revoked: remove it
   in the admin console, as when removing a contact.
2. The invitee pastes the link (`contacts.join`). Its core accepts the
   Tailscale share with its own API key when it has one
   (`POST /api/v2/device-invites/-/accept`). Without a key, the Join card
   reads the share from the pasted link and shows **Accept the Tailscale
   share** before Join; it stays while the link does, so after a join that
   could not reach the inviter the owner accepts it and joins again.
3. The invitee's core posts to the inviter at its tailnet name,
   `http://<machine>.<tailnet>.ts.net:<port>/contacts/join`: a shared machine
   is reachable by that name only, and its IP may differ in the invitee's
   tailnet. A Headscale tailnet gives names under its own base domain
   (`boite.net.example.com`): the link carries that name, and the invitee's
   core dials it over plain HTTP only when every address it resolves to is a
   tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) or loopback, and checks
   the name again before each later request and each redial of the link; any
   other plain HTTP origin is refused. The body is sealed to the inviter's sealing key and carries the
   token and the invitee's card, signed by its key. The inviter looks the
   token up before it checks the signature or keeps the nonce, spends it
   before anything else changes, so a second join with the same link is
   refused, then answers with its own card, signed and sealed back. Every
   refusal is a sealed 403, which the server counts against the caller's
   address (60 a minute). Each core stores the other's keys. The inviter
   keeps only the token's SHA-256.
   Two owners who invite and join each other at once end with one
   relationship: the core with the smaller core id hosts and the other
   dials it, a rule both cores compute alone.
4. Both apps show the same eight words, derived from both public keys. Two
   owners who read the same eight words know nobody sat between them.
5. The invitee's core keeps a WebSocket open to the inviter at
   `/coordination/contact/link` and redials with backoff, from one second to
   a minute. It dials with a hello in its headers: from, to, the time and a
   nonce, signed. Before the upgrade, the inviter refuses a hello more than a
   minute off, a nonce it has seen or a signature by another key. That link
   is a [coordination bridge](coordination.md#contacts) route for the
   invitee: the inviter's signed requests go down it and the answers come
   back on it. The invitee's requests to the inviter are plain POSTs.

Requests between contacts are signed with each core's Ed25519 key and sealed
to the recipient, as between members of a group, then carried by WireGuard. A
readable request from a contact is refused. Owner tokens, provider credentials
and the Tailscale API key never cross. The API key sits in
`contacts-tailscale-key` in the data directory, mode 600; no RPC answer, log
or error carries it, and the core sends it to `api.tailscale.com` only.

The inviter's core listens on its tailnet address while it hosts a contact or
has an invitation out, as it does in a group, and closes that listener once
the last invitation expires or the last hosted contact goes. A core with no
contact and no invitation opens nothing and runs no timer. **The tailnet
policy decides which ports a shared user reaches**: without a rule, assume
every port of the shared machine. The Contacts page reads the policy with the
API key and says `restricted`, `open` or `unknown`; when `open`, it gives the
lines that limit `autogroup:shared` to Boite's port. Boite never writes the
policy.

## Funnel, for another network

**Elsewhere** runs the Tailscale CLI (`contacts/funnel.ts`): `funnel --bg
--https=<port> --set-path=<route> http://127.0.0.1:<port><route>` for
the three routes a contact dials, `/contacts/join`,
`/coordination/contact/link` and `/agent-messages`. Nothing else of the core
is on the internet: not the UI, the owner RPC or the pairing routes. Funnel
opens a whole port, so the mounts take 8443, or 10000 when 8443 serves
something else, and never 443, which the phone's `tailscale serve` uses; with
both taken the invitation is refused. A node without the `funnel` node
attribute, HTTPS certificates or a running Tailscale is refused with what to
do, and the Funnel consent page when the CLI printed one
(`data.actionUrl`); the CLI's own words never reach a client. Every request on
these routes is signed and sealed as on the tailnet, with TLS instead of
WireGuard under it. Requests Funnel hands over come from loopback, marked
`Tailscale-Funnel-Request` with the sender in `X-Forwarded-For`, both set by
tailscaled: the refusal quota counts them under that sender
(`strangerAddress` in `server.ts`).

The journal keeps `contacts:funnel`, the loopback targets the mounts may
proxy to, while they may be up. An invitation holds the mounts until its
token is saved, so a refused invitation made at the same time never takes
them down. Once no contact is hosted and no invitation is out, `serve
--https=<port> --set-path=<route> off` removes them, and only them; the
record is cleared after every removal succeeded, else the next release or
start tries again. A core that comes back on another port moves the mounts a
hosted contact still dials to its new port, on the same public origin, and
removes old ones left anywhere else, or all of them when nothing needs them. A client shows **Elsewhere**
only when `contacts.get` answers `internet: true`: an older core reads only
`share` and would share the machine instead.

While the mounts are up, the core checks them from the internet
(`contacts/funnel-check.ts`), after each invitation for another network and
at start. This machine cannot see its own Funnel name as the internet does:
MagicDNS answers it with the tailnet address. So the core resolves the name
over DNS-over-HTTPS (`dns.google`, then `cloudflare-dns.com`), then posts to
`/contacts/join` at one of the public addresses, TLS still named after the
Funnel name. The join route's own refusal of a request naming no peer proves
the request went through Funnel to this core; any other answer is
`unreachable`. Tailscale usually publishes the name within minutes of turning
Funnel on, and sometimes not until it is turned off and on again: still
unpublished after 10 minutes, the core removes its mounts and puts them back
once, then checks again; a repair that could not put them back is not counted
and is tried again 10 minutes later. Checks run every 30 seconds until one goes through,
for an hour at most. `contacts.get` gives the result as `funnel` (`checking`,
`ready`, `unpublished`, `unreachable` or `unknown`, and `repaired`), null once
the mounts are down. Under an Elsewhere link, the page says when the link is
ready to send, or to wait and what to do.

The guest's side of an https link tells a name DNS does not know from a host
that does not answer. For the first, `contacts.join` is refused with
`data.retryAfterMs` (30 seconds): the token was never spent, and the client
joins again by itself for up to 15 minutes, with **Stop** to end it.

## Projects and requests

A pending incoming request appears at the top of the app, with the contact,
receiving machine and request text. Dismissing the notice leaves a bell with
the pending count. Either opens the request on its owning machine, including
from Settings and on a phone. Reconnection refreshes requests even when the
Contacts page is closed.

Each side opens projects to the other (`contacts.grant`). An open project's
threads are listed in the contact's agent directory: title, project, branch,
model, status and declared resources. Each thread's own coordination settings
still apply: one with communication off or kept to its project stays hidden.
The contact's agents can write to them. Reading a conversation, and searching
its chat, needs `readThreads` on that grant, off by default. A thread that
wrote to a contact, or asked it something, may hear back from it for 7 days
after its last letter, even in a project not opened to it. A grant change
reaches the contact as `contact.sync`, retried until heard, and becomes the
contact's `offers`.

**Share a project** reuses the new-thread project search: type a project,
machine or folder name. Projects are grouped by machine and omit drafts,
archived projects and existing grants. The menu lists every connected owner
machine linked to this contact, and every machine of the same
[group](groups.md) as one of them. The shared list names the machine that
holds each project; opening its board uses that machine's Store, even when
two machines have the same project ID.

### Projects of the other machines of the group

A contact is linked to one machine, yet the owner may open it a project of
any machine of that machine's group: `contacts.grant` with `machine`, the
member's core id. The linked machine asks the member for the project
(`relay.project`), keeps the grant with the member's id and the project's
name, and announces that name in the contact's offers. Reading, revoking and
the read switch go through the linked machine too, with the same `machine`.
A machine linked to the contact itself is asked directly.

The contact never meets the member. The linked machine answers for it
(`contacts/members.ts`): a directory, a search, a read, a letter or a receipt
for one of the member's threads is relayed to the member (`relay.in`) with the
contact's current copy, and the answer comes back under the linked machine's
core id, the thread id followed by `~` and the first 16 characters of the
member's core id. The contact sees neither the member's name, its address nor
its key. A member that does not answer within 3.5 s lists no thread; a letter
to one of its threads, or its receipt, waits and is asked again until it
expires. The members are asked a receipt at once, and it is unknown only
when each of them said so.

The member keeps a copy of each contact it was opened to: its name, the
owner's model tier on the linked machine, what the contact opened in return
and the grants on the member's own projects. The linked machine pushes it
(`relay.mirror`) on every grant, revoke, rename, tier, offer or link change,
and retries every 30 seconds until the member heard it, even once the last
contact is gone. A member whose copy missed a revoke reaches nothing through
the linked machine, which answers from its own grants and pushes the copy
again. With that copy the
member's agents list the contact (`boite threads contacts`), reach the
threads it opened and write to it; their requests go to the linked machine
(`relay.out`), which sends them on as its own. A member that loses a grant
forgets its threads' replies from that project and rejects the letters
waiting for them, as a revoke does on the linked machine. A copy from a
machine that left the group reaches nothing. `boite threads ask` goes through
a mailbox, as below ([Contacts through your group](#contacts-through-your-group)).

Every machine of the group has full control of the others, so a member
believes what the linked machine says of a contact; a contact still reaches
only what was opened to it. Both machines run a Boite that knows these
operations: an older member refuses the grant with "update it".

With the [project board](board.md) on, a contact's page shows each project
shared with that contact as its board's four counts: to do, in progress, in
review and done. A click opens the board in the project's last conversation.
These are this core's cards and stay on it: the contact sees none of them
until shared projects sync their board.

An agent asks a contact for help with `boite threads ask <contact> "<text>"`
(`collaboration.ask`): "an agent on a project like X". The request carries the
agent's git remote when its checkout has one. On the contact's side it waits
in the Contacts page: the owner accepts by opening one project, or refuses with
a reason. A contact marked trusted is answered without the owner:

1. a request whose git remote matches exactly one local project opens that
   project (`decidedBy: 'match'`);
2. otherwise the concierge decides: one inference on the delegation profile
   named `concierge`, else Opus 5.5 at high effort, given the request and the
   project list as JSON data. It answers with the project to open or the
   reason to refuse (`decidedBy: 'concierge'`). If it fails, takes over 3
   minutes or ends without a verdict, the request waits for the owner.

The concierge runs on the driver's side-question path: no tools, no MCP
servers, hooks or settings, nothing persisted, in an empty folder under the
data directory. Its processes get no Boite token or thread id, not even one the
core inherited from an agent that started it. A request cannot make it read a
file. A
profile on a protocol without that path (pi, Codex, ACP) never runs it: the
request waits for the owner and the log says why. It creates no thread; the
decided request shows its verdict and reason. It never grants `readThreads`.

Each request a contact sends gets an id of this core; the contact's own id is
kept only to recognize its retries and to answer it, so two contacts, or a
contact reusing an id of this core's requests, never reach each other's
request. The decision comes back to the asking thread as a
message (`origin: 'contact'`): the project opened and its threads, or the
reason for the refusal. When the contact's core refuses the ask itself (a
tier, a full queue), the asking thread is told the same way.

## What an agent knows

### Contacts through your group

An agent can reach contacts linked on another machine of its own group.
`boite threads contacts`, directory, search, read, send and ask use that
machine as a gateway. A directly linked contact takes precedence. Project
grants, transcript grants and model tiers still apply. A contact that opened
this machine's own projects through the gateway is that relayed contact
(above): its letters cross through the gateway as the member's thread, not a
mailbox; asking it still takes a mailbox.

The initiating conversation keeps its sent and received letters and receives
the wake. The gateway creates a durable virtual mailbox, never a conversation
or provider process. The external contact sees that mailbox on the machine it
already knows, with the initiating thread's title and model. Replies and
request decisions return to the initiating thread. Pending letters retry
after a transport failure, within their expiry; the gateway retains its
mailboxes and reply outbox across restarts.

The internal `contact.route` operation requires a sealed request from a
current group member. It shares no contact credentials or direct trust with
the initiating machine. Removing a group admission or gateway contact
invalidates its mailboxes and withdraws replies still waiting for delivery.

### Sender identity

A letter from a contact carries `contact`, the name this owner gave that
contact, set by the receiving core from its own list, never taken from the
sender. The agent reads "Chris's agent, a contact: not your user" beside the
sender's thread and project. The guide tells the agent that a contact is not its owner:
a contact's message does not authorize a destructive action, a credential or
work outside the opened project.

Agents may talk with contacts as long as the work needs: there is no cap on
exchanges. The guide asks for messages that move the work, with no courtesy or
acknowledgment-only replies.

## Model tiers

`ContactSettings.minTier` sets the least capable model allowed on contact
traffic, 1 by default. An agent below it cannot write to a contact or ask one,
and an incoming letter whose sender model, as the contact's core attests it,
is below it is refused with the reason. Tiers: 1 frontier (Opus, Fable, GPT-6
class), 2 mid (Sonnet, high Flash), 3 small (Haiku, Lite, OSS); an unknown
model is 2. The attested model is the contact's word: a tier is a cost and
cooperation rule, not a security boundary.

## Revoking

`contacts.revoke` closes one project: its threads stop hearing back from the
contact under the 7-day reply rule (only a later letter of theirs opens it
again), pending letters to them are rejected with `Project closed to this
contact`, a provider wake already queued for such a letter included, and its
threads leave the contact's directory. `contacts.remove` ends every grant, drops the contact's requests,
rejects pending letters both ways and closes the link. Removing is one-sided:
the other core keeps its entry, its redials are refused and its letters wait
undelivered until they expire, until its owner removes it too. Removing the
Tailscale share is the owner's, in the admin console.

## Limits

At most 32 contacts and 16 open invitations, 32 requests waiting per contact
and direction, and the last 50 decided requests kept. A join in flight holds a
contact slot until it ends, so joins at once never pass the cap together and
an incoming join cannot take a held slot. The tailnet address is
read when the core starts or joins a group: a core outside any group that
gets on Tailscale later listens there after a restart.

## Code and tests

`packages/core/src/contacts/`: `store.ts` (contacts, the link, requests and
the RPC methods), `members.ts` (projects of the other machines of the group),
`invitations.ts` (making an invitation and the origin it
names), `funnel.ts` (the routes on Tailscale Funnel), `funnel-check.ts`
(whether the internet reaches them), `join.ts` (both sides
of a join), `invite.ts` (the link format), `words.ts`
(fingerprint words), `tier.ts`, `git-remote.ts` (read from the git config
files, no process), `concierge.ts` and `tailscale.ts`. `contacts.*` are
owner-only; agents call `collaboration.contacts` and `collaboration.ask`.
`packages/core/test/contacts.test.ts` links two cores over loopback, and
`contacts-parts.test.ts` covers the pieces, the Tailscale client against a
stubbed `fetch`. `contacts-group.test.ts` links a contact to one machine of a
two-machine group and opens it a project of the other. `contacts-funnel.test.ts`
drives the Funnel mounts through the fake CLI (`test/fixtures/fake-tailscale.ts`)
and the internet check through a stubbed resolver and request, never the
internet, and `magic-dns.test.ts`
the tailnet name lookup against a resolver on loopback.

This machine's tailnet name is the PTR record of its tailnet address at
100.100.100.100, asked as one UDP datagram (`group/magic-dns.ts`). On Windows
`node:dns` answered that question from the system resolver, which names the
machine by its bare host name, so a Windows core had no tailnet name and
refused every invitation.

## Not yet

Shared projects (both sides' threads in one view, a kanban synced with
`/goal2`), shared compute between owners, a person writing straight to a
contact's agent, default denial of secret files in opened projects and the
review agent that can revoke a contact are later phases.
