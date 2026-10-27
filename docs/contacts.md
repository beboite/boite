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
   `/coordination/contact/link` and redials with backoff, from two seconds to
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

For legacy unilateral lookups, the linked machine answers for the member
(`contacts/members.ts`): a directory, a search, a read, a letter or a receipt
for one of the member's threads is relayed to the member (`relay.in`) with the
contact's current copy, and the answer comes back under the linked machine's
core id, the thread id followed by `~` and the first 16 characters of the
member's core id. These legacy descriptors disclose neither the member's name, its address nor
its key. Explicit shared-project offers additionally disclose the canonical
member endpoint, and accepted directories disclose its machine label, as
described under [Completion protocol](#completion-protocol). A member that does not answer within 3.5 s lists no thread; a letter
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
These counts include local cards and the explicitly associated shared cards.
Local cards stay private. The [shared board protocol](board.md#shared-board-protocol)
requires both endpoint owners' board consent.

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
owner-only for administration; `contacts.sendHuman` also permits paired devices.
Agents call `collaboration.contacts` and `collaboration.ask`.
`packages/core/test/contacts.test.ts` links two cores over loopback, and
`contacts-parts.test.ts` covers the pieces, the Tailscale client against a
stubbed `fetch`. `contacts-group.test.ts` links a contact to one machine of a two-machine
group and opens it a project of the other. `contacts-funnel.test.ts` drives the Funnel mounts through
the fake CLI (`test/fixtures/fake-tailscale.ts`) and checks their reachability
through stubbed DNS and requests, never the internet. `magic-dns.test.ts` covers
the tailnet name lookup against a resolver on loopback.

This machine's tailnet name is the PTR record of its tailnet address at
100.100.100.100, asked as one UDP datagram (`group/magic-dns.ts`). On Windows
`node:dns` answered that question from the system resolver, which names the
machine by its bare host name, so a Windows core had no tailnet name and
refused every invitation.

## Completion protocol

The version 1 association, scoped thread/search/read service and scoped
subscriptions are implemented in `contacts/projects.ts`. The durable board
service is in `contacts/board.ts`, with its protocol in [board.md](board.md#shared-board-protocol).
Host-owned compute admission and the workflow adapter are implemented in
`contacts/compute.ts` and `workflows/shared-compute.ts`. Compute admits tool-free
echo and protected Claude/Codex/Muse/OpenCode/pi on a host with a native boundary/helper
and a supported permission mode. File enforcement, activity review, attested human letters and the Client/Store/fake
transport and project/board/Contacts components are implemented. Direct and
group-member associations share the signed/sealed transport. Unsupported ACP
implementations remain refused. Windows requires the native helper described
below; macOS has no protected backend. This protocol does not claim the whole
roadmap is complete.
`packages/contracts/src/shared-projects.ts` declares the vocabulary;
`coordination.ts` retains the existing contact types. A core must not advertise
`features.sharedProjects: 1` until its enforcing handlers exist. A contact
negotiates `capabilities.sharedProjects: 1` and `humanLetters: 1` through sealed
`contact.sync`; absence means legacy traffic only, never implicit consent.
Existing unilateral grants, asks, board counts and agent letters keep their
meaning. Unknown methods fail closed; a new client must not send an optional
machine selector to an old core that would ignore it.

### Implemented association service

Both owners first grant their selected project through Contacts. Offering
requires the peer's negotiated `sharedProjects: 1`; an ordinary trusted contact
cannot accept an offer. The owner of the receiving endpoint accepts explicitly.
Offers never enable conversation reads, board consent or compute. Pending and
declined offers leave the existing unilateral lookup path available. Once an
association is active, or has been revoked, lookups to that contact use the
source project's exact active associations; unscoped peer directory/search/read
requests are refused. This prevents a revoked association falling back to a
broader legacy query. Human and agent letters use the existing delivery path
with the exact source/destination association; receipt and deferred delivery
both recheck current authority.

Journal schema 39 keeps associations, content-bound operation receipts,
the durable control outbox and the local grant fingerprint. Grant or project
revocation closes an association permanently. Changing `readThreads` advances
the endpoint's grant revision; reads check current access after awaiting their
response, including a destination revision check before publishing a transcript.
Contact names are resolved locally on every read. A contact rename changes no
endpoint identity or grant revision.

`sharedProjects.search` and the peer `search` method complete the foundation's
search contract. Agent actors carry their host-attested `agent` provider/model
description so both owners enforce their current model tier. The existing
`collaboration.directory/search/read` entry points route through these scoped
queries. Foreign descriptors keep canonical endpoint/thread identity and a
separate public address; the combined array groups the local endpoint first,
then the remote owner/machine. It creates no local foreign thread or owner
connection.

Connection watches use 60-second peer leases, renewed every 20 seconds only
while subscribed. Invalidations coalesce for 50 ms and carry only the local
source thread and association ID. They are delivered directly to the subscribed
connection, never broadcast from the event bus. Unsubscribe, disconnect,
source moves, archive and revocation release the watch; link loss removes peer
leases and reconnect renews live watches. Without watches or leases this
service starts no notification timer. A closed subscription ID stays rejected
for the two-minute wire replay window so a delayed enable cannot recreate it.

Member endpoints execute on their original core. A `contact.project` request
carries explicit canonical `route.source` and `route.target` endpoints. The
linked gateway checks the authenticated contact, current group admission and
exact member/project grant before forwarding through existing `relay.in/out`.
It compares the admission epochs, contact admission and complete grant again
after awaiting a response. A changed read grant cannot release an older
transcript while its member mirror is delayed. The member accepts only the
selected gateway's mirror. Saved mirrors bind both membership epochs and do
not survive removal and readmission as authority.

The gateway creates no association, board, worker or project copy. Canonical
identities remain owner/core/project/thread tuples; public thread addresses
use the gateway and the existing member alias. Authority is never derived by
parsing that alias. The explicit grant advertises the member's canonical core
fingerprint and project identity; an accepted shared directory also discloses
its machine label. Legacy unassociated queries retain the linked machine's
labels and privacy projection. Source mailboxes from contact requests remain
separate from these project endpoints.

The Contacts association control uses the project's owning Store, including
when the grant is configured at another gateway. Remote offers and menu keys
use all three endpoint fields, so colliding project IDs remain separate. A
new board worker's public address comes from the scoped directory rather
than being constructed by the UI.

### Identity and association

`SharedProjectRef` is `(ownerCoreId, coreId, projectId)`. `ownerCoreId` is the
contact-link identity vouching for that owner's side. `coreId` owns the selected
project and runs its work, including on a different member of that owner's
group. A bare project, thread, card or job ID is never a cross-machine key.
`SharedThreadRef` adds the canonical host-local `threadId` and a separate public
`AgentAddress` advertised for routing that thread. The canonical key is
`(ownerCoreId, coreId, projectId, threadId)`; aliases are not identity. Keep the
public address unchanged when a group member relays it, and preserve the local
origin in that origin core's journal. Contact names come from the receiver's own configuration on
every read, including after rename. An endpoint reveals only the selected
machine's identity/display name, never its keys, addresses or group roster.

PR #755 defines `ContactGrant.machine`/`name` and the optional `machine` on
`contacts.grant`/`revoke`. Missing machine still means the linked core. It hides
member threads behind the linked core and a `<thread>~<member-prefix>` alias.
PR #756 keeps A's public A/C addresses when B carries its contact traffic,
using durable `cmb_` mailboxes at B without a real B conversation. These are
different directions of relay and must compose: preserve the advertised
alias and the originating A conversation. Neither mailbox IDs nor truncated
member suffixes become execution authority. Version 1 explicitly discloses
the selected endpoint metadata when associating, without changing legacy
contact directories or treating a contact as an owner/group member.

The owner offers one local registered project and one exact advertised remote
endpoint with `sharedProjects.offer`. Persist a fresh association ID, both
endpoints and the proposing project's existing execution core as immutable
board authority. The other owner accepts or declines with
`sharedProjects.decide`; a trusted contact/concierge cannot accept it. Each
endpoint independently controls its grant revision, board consent and compute
policy. Association does not turn on `readThreads` or compute. Both current
project grants and explicit board consent are required for board traffic.
Revocation is final for that association ID; associating again mints a new ID.

`sharedProjects.list/get/threads/search/read` are scoped to a local source conversation
in one endpoint. The combined view contains only those two endpoints' allowed
threads, grouped by owner and machine. Directory eligibility still respects
archive, communication Off, project-only and remote restrictions. Transcript
reads and chat search additionally need the destination's current
`readThreads`; association never widens that grant. Foreign rows are read-only
descriptors, not local `ThreadSummary` rows or connections with owner RPC.
The existing `collaboration.search/read/send` remain the agent entry points;
their source-project filter must honor the association before returning data.

### Transport and durable state

Reuse `/agent-messages`, the contact link and coordination signing/sealing.
One new operation, `contact.project`, carries `SharedProjectPeerRequest`, not
arbitrary RPC forwarding. `offer` and `decide` admit only the authenticated
owner-side control exchange. All scoped methods carry the association ID,
destination grant revision, request ID and source actor attested by the
calling core. Reject mismatched sender/endpoint, revoked admission, stale
grant, wrong destination or source project before dispatch and again after
asynchronous reads. `access` changes only the authenticated sender's own
access record; a peer can narrow its participation, never grant itself ours.
The same validation runs after every group relay. Extend the existing
group-only relays to carry this bounded payload; contacts never gain access
to `group.*`, group relays, tickets or owner tokens.

Persist associations, per-endpoint access revisions, outgoing commands,
receipts and board changes in the journal. Request IDs are unique within
`(association, authenticated actor)`; reuse with changed content is refused.
Transport retries get fresh envelope nonces but the same operation ID.
Keep a canonical content fingerprint with every receipt. A transport failure
is retryable, a signed policy refusal final, and an uncertain provider
submission is never automatically replayed. A committed command and its
receipt precede acknowledgement. No timer or SDK starts for an unused feature.

`sharedProjects.subscribe` is connection-owned and scoped to its local thread
and association. `sharedProjects.changed` contains that scope and the changed
surface kinds (`threads`, `board`, `compute`, `access`). An older core's event
without kinds invalidates all surfaces. Audit/verdict changes reread access and
project policy without rereading threads: reviewing a directory read cannot
recursively trigger more reads and inference. Policy changes invalidate all
four surfaces. Reads recover from their last durable cursor after reconnect;
unsubscribe, disconnect, moving the source thread, removal and revocation
release subscriptions. Notifications go only to explicit subscribers, with
coalescing and backpressure; no global foreign-thread stream. Delayed results
recheck current permission and client/navigation generation. Unsubscribe and
disconnect retain the admitted source but send the current grant revision,
releasing an online peer lease even after a consent change. The legacy member
relay also rechecks the contact admission, member epochs and exact grants after
awaiting its answer, before returning any discovery data or transcript. A
permission withdrawn and restored during the wait still fences the old answer.

Peer `subscribe` records a bounded lease tied to the current contact link/group
admission and attested source scope. Close, expiry or revoke removes it. Renew
only while a local subscriber exists, catching up from its cursor; no subscribers
means no renewal timer. Peer `changed` carries only kinds/revisions and scoped
job IDs, triggering permission-checked pulls. A nonterminal job also follows its
source through this path so terminal results reach its parent without a UI.

### Board and claims

Reuse `Todo.status`, `TodoGoal`, `/goal2` and the drawer board. To do is open
without an assignment; In progress is an open assigned card; In review is
claimed or currently reviewing; Done is the user's confirmation. Checklist
and progress come only from the assigned host's actual goal journal, never a
client's claimed checklist. Keep local-only todo storage and behavior intact.

The authority serializes accepted commands in a durable increasing revision
log. Edits are optimistic locally and queued durably while offline. Text and
ordinary status edits merge field by field in authority acceptance order;
the last accepted edit of a field wins, never a wall-clock comparison. An
agent still cannot confirm, remove or reopen a user-confirmed Done card.
Remove writes a permanent tombstone. Later edits/adds for that ID return
`deleted`; recreating a task needs a new card ID. A snapshot carries surviving
cards and tombstones; deltas carry contiguous authority revisions. Ignore
repeated/older revisions, fetch gaps, and never turn a received projection
back into a new local command. Compaction retains tombstones and deduplication
evidence, including through restart or a long-offline replica.

Claim is a compare-and-set against the card revision at the authority. A
successful receipt reserves the card to one exact worker and returns a claim
ID scoped to association, actor, card and request before any goal starts.
Different agents can reuse a request ID without sharing a claim identity.
Start/link the ordinary goal idempotently under
that ID. A losing claim starts no work and removes only its own empty draft,
as the existing board does. There is no timeout-based authority failover or
automatic claim expiry. An unreachable authority leaves edits pending and
claims unavailable. An uncertain worker cannot be reassigned until its host
proves the previous execution stopped. Release first stops that captured
execution. Goal progress accepts only the current claim's authenticated host
and increasing host sequence, preventing stale progress from restoring a
released/deleted card. Phone menus expose every move, confirmation and removal.

### Compute and results

Compute defaults off independently of contact trust, board consent and read
grants. `sharedProjects.configure` on the owning host selects its permitted
delegation profiles, permission mode and optional host concurrency limit.
`null` inherits host settings, not a new default ceiling. Peers receive route
names/models/capabilities, never account IDs, credentials or environment.
`SharedComputeAllocation` expresses an explicit contribution such as four
local children and five remote children. A workflow step's `compute` target
selects one host. Shared-compute plans have no new default concurrency ceiling;
an explicit plan limit and each host's contribution/resource settings still
apply. Ordinary plans keep their existing limits. No exchange/hop counter is
added. An authenticated shared worker can request work only in its exact
association, through the next host's admission, never through an unrestricted
local child or another associated project. Ordinary delegation retains its
existing parent rules.

Opt-in also names `computeThreadId`, an active host-local parent in this project
with delegation enabled. Only that parent resolves the offered profiles to
local accounts. Rebinding, pausing, archiving, changing its route or changing
the grant fences existing jobs. This parent/account binding stays host-local.
The owner restores its saved parent through `sharedCompute.host`; it is absent
from device, agent and contact views. Contribution/profile/mode edits omit
`computeThreadId` unless the owner explicitly chooses a different parent before
enabling compute. Saving an unchanged policy keeps the grant revision and
running jobs' authority.
OpenCode 1.19.3 ACP shared routes support native default/build and plan; other
ACP implementations remain refused. pi supports only YOLO/bypass because its
RPC has no approval gate. Claude, Codex and Muse retain their existing permission
mapping. Claude, Codex, verified Muse 1.4.13, OpenCode and pi use their protected
native adapters on hosts with an available tool boundary and helper. Echo accepts only default mode and blocks its scripted
shell escape at the process boundary. A text instruction is not protection.

`sharedCompute.start` names an associated host, approved profile, validated
repository base commit, task and optional board claim, never a path, shell
command, account or remote permission override. Bind it to the authenticated
source conversation and host access revision. Persist a job and an admission
reservation before calling existing delegation/scheduler/worktree machinery.
Duplicate starts return the same job; changed-content retries fail. Use the
host's own registered repository, account, quota, permission mode and process
caps. Validate the base object/repository before creating an isolated worktree.
Do not inherit a remote parent's account, bypass mode, hooks or Boite token.
Local nested delegation stays subject to the same shared scope; it cannot
escape into an unrestricted child or another project.

The requester follows only its own jobs; the host owner inspects/cancels all
jobs on this association. Remote steering is an external agent letter, never
an answer to a host permission card. Cancellation/revocation closes admission,
retries, result delivery and authority for exactly these captured job IDs,
including after restart. Keep terminal ledger entries as deduplication fences.
Unrelated jobs and ordinary local turns continue. An offline remote host
cannot acknowledge cancellation until it hears it; report that state honestly.
The enforcing host denies locally at once, and checks again before execution,
tool use and result publication. A regrant cannot revive jobs from an old
revision. Group membership changes invalidate relay admissions too.

Schema 41 keeps the source request and host job separately. Identity includes
association, canonical source and request ID; switching hosts under that ID
is a changed-content retry. Host state revisions prevent late responses from
overwriting completion. A cancellation can precede start: its durable fence
blocks the delayed request. Confirmation waits for captured execution, Git
preparation and result inspection to settle. Restart preserves the job but
marks interrupted host execution uncertain; it never replays inference. A
workflow persists the identity before waiting for a launch response, reattaches
it after restart, and cancels the previous job before an explicit retry.
Contacts reconnect/flush and scoped invalidations deliver state without a new
polling timer. Ledger receipts currently have no pruning policy.

`SharedComputeResult` returns credential-free repository identity, branch,
base commit, exact commit, dirty status and bounded assistant text. Verify
these against the host job/worktree and the local registered repository,
including object format and provenance. Fetch/integrate through the project's
normal approved git workflow; never execute a returned command, trust an
arbitrary URL/path or auto-merge a result. Changed files, artifacts and any
bundle/patch still pass the shared-file policy. A failed or revoked job
cannot publish a late success. Results remain verifiable data across reconnect.

### Human letters and file boundaries

`contacts.sendHuman` authenticates an owner or paired human, resolves the local
source conversation, checks the same allowed destination/reply path and
idempotent receipt as agent mail, then attests `origin: 'contact-human'`.
An agent cannot call it or supply its provenance. The receiver assigns its
own contact name and association scope. Human contact, contact agent, local
delegation `user` origin and actual owner prompt remain distinct in provider
input and letter data. Component rendering is a separate integration step.
A contact human has no invented model/tier; agent mail
continues to obey `minTier`. Require negotiated human-letter support, never
fall back to an owner prompt on an older peer. None of these external letters
answers an approval or changes host settings.

The gateway preserves authenticated `contact-human` provenance through durable
mailbox delivery and retry. Human replies have no model tier or agent label.
The initiating core trusts this provenance only from its saved, sealed group
route; an agent RPC cannot mint it or impersonate the internal `contact` origin.

`contacts/access-policy.ts` binds shared compute workers, shared board goals,
ordinary associated conversations consuming contact mail, and their children
to the captured checkout, association and grant revision. Before a wake, steer
or safe-tool-boundary hook passes external text to a provider, `letter-scopes.ts`
captures that authority. Contact humans and core-formatted contact request
answers remain external data. Multiple consumed associations intersect their
file permissions; replacing a goal or restarting does not release the history's
protection. A scoped agent may reply to the associated contact through the
ordinary destination checks, but cannot forward execution to an unrestricted
local sibling. Other ordinary owner conversations retain their permissions.
A new remote compute worker starts with its own captured host authority and
fresh task; its host parent supplies an account/profile, never conversation
history. That parent's old letter scopes do not replace the new job boundary.

Legacy correspondence and pre-policy consumed history have no captured file
authority: they use the no-tools route and deny file/tool/upload/publication
RPCs. Such history cannot resume an unrestricted native session. Unsupported
native providers hold contact mail in the inbox before exposing its text,
including on an active warm session; local work already running without that
mail continues. Claude and Codex retire idle ordinary control before consuming associated mail
and install the protected capability before preparation. Mail introducing a new
authority waits for an active native turn to finish; it cannot enter the old
unrestricted process. Unsupported protocols and legacy unscoped native mail stay
held.

The file policy denies environment variants, private keys, credential
directories/files, hard links and paths outside that checkout. Both the supplied spelling and
the canonical target are classified. Foreign Windows drive-relative, UNC,
device, stream and backslash spellings are rejected, including on Linux;
internal paths use canonical relative slash notation. Open descriptors must
match the authorized file identity, including its change timestamps.

File listings omit denied entries. Reads inspect credential-like text before
returning it, and scan complete binary/large files before issuing a ticket so
a Range cannot skip that inspection. Tickets recheck file identity, live grants
and overrides on use and while streaming. Secret checkpoint entries are
omitted; ordinary files still get checkpoints. Shared Git RPCs and rewind are
refused because historical blobs and configurable Git helpers have no selective
file boundary. Fixed-argument internal compute Git operations remain separate.
The process launch gates also reject unisolated tools, including an echo
fixture's spawn command and delayed attempts. Ordinary local sessions retain
their existing permissions.

Published snapshots and self-contained HTML views inspect every source file
and embedded dependency. Their durable source manifests keep the captured
authority: changing/removing a source, changing a grant, or revoking/expiring
an override makes subsequent snapshot tickets fail closed. Shared live previews
are refused. Protected message/image tickets use `no-store`. Contact transcript,
title, search and compute-result projections withhold credential-like text.
Content detection is conservative pattern matching, not general data-loss
prevention for encoded or obfuscated content.

Uploaded prompt/question attachments and history materialization also check
names and bytes before the core stores or forwards them. Ordinary uploads are
allowed; secret uploads have no captured host-file identity and are refused.
Use publication from an exact authorized host source for an override, rather
than treating an upload or a contact letter as implicit file consent.

Reuse the credential directory/file classifications already in `workdir.ts`
(`DEVICE_SECRET_DIRS` and `DEVICE_SECRET_FILE`), and extend them for this shared
scope. They currently guard paired file reads, not arbitrary provider tools or
agent/owner file reads. `existingInside`/`openChecked` provide containment and
handle identity checks; neither is a secret policy by itself. Shared rules
also deny `.env` variants by default, including template-named variants unless
the host explicitly permits that exact file.

A host-only `SharedFileOverride` names one exact canonical relative file,
`read`/`publish` actions, optional job, expiry and reason, and can be revoked.
Its durable record also binds the file identity, checkout and grant revision.
`jobId: null` applies only to the registered project root, not copied job
worktrees. Replaying a revoked creation receipt never restores it. `execute`
is reserved and refused: an exact read override cannot authorize a process.
Overrides neither disable the policy globally nor travel as remote authority.
A route reports
`SharedExecutionProtection`: enforced isolated process, no-tools execution, or
unsupported with a reason. A prompt, resource cap, approval callback or the
Codex workspace-write mode alone cannot guarantee file read isolation. Refuse
protected shared execution when the actual process/tool boundary cannot
enforce it. Keep the host's permission semantics; never silently substitute
another driver/mode or enable bypass.

`sharedExecutionProtection` admits echo/default with no tools, and Claude/Codex,
verified Muse, OpenCode ACP and pi with an available host native boundary/helper and
supported permission mode. Native preparation probes the real launch and fails
closed on an unusable helper or kernel. Muse additionally requires native
1.4.13 and its exact verified MSP fingerprint; older/unverified runtimes and
other ACP implementations remain unsupported. The in-memory client defaults to unsupported native execution;
`setSharedNativeExecution` explicitly supplies a fixture capability for parity,
never OS evidence.

| Driver | Mandatory protected control path | Shared admission |
| --- | --- | --- |
| Claude | SDK `tools: []`, explicit native-tool denies, empty setting sources, strict in-process MCP only, no plugins/skills and configured hooks disabled. Only `boite_exec` and job-bound `boite_commit` run through the host mediator. A bypassable `canUseTool` callback is not the security boundary. | Isolated-process on an available native host. |
| Codex | CLI strict configuration, native shell/hooks/plugins/apps/browser/elevation/memory disabled, all effective MCP servers disabled, granular filesystem root deny and no network. Only host dynamic tools enter the executor. Configuration discovery failure refuses startup. | Isolated-process on an available native host. |
| ACP | Verified OpenCode 1.19.3 core plugin denies other tools/commands; a private core-only MCP enters the same OS executor. Private normalized config prevents discovered plugins/MCP, external SDK imports and remote configuration. Native extension readiness and version are mandatory. | OpenCode 1.19.3, default/build or plan only, on an available native host. Other ACP implementations remain refused. |
| Muse | Verified native 1.4.13 mandatory named MCP toolset rejects forged native calls before invocation. Required private MCP resolves before the first API request. Core-only HOME/XDG roots and an empty workspace prevent account/project hook, plugin and instruction discovery. Native auth remains on trusted control. | Native 1.4.13 with the verified MSP fingerprint and an available OS executor. Other runtimes fail closed. |
| pi | Native extension registers protected tools and blocks other calls, including nested extension calls. Builtins and external discovery are disabled. Native account auth remains on trusted control; model selection is captured and command-valued keys/headers refused. | YOLO/bypass only on an available native host. RPC approvals remain unavailable. |
| echo | Deterministic in-process provider with tool launches refused. | Default no-tools only. |

`contacts/native-execution.ts` captures jobs, board claims and associated contact
letters before warm preparation and every attempt. Its authority callback checks
all consumed grants, host route/account/mode/profile, checkout and exact read
exceptions. Every authority must grant the same exception; the earliest expiry
wins. Changing that capture revokes the old capability and its control/tools.
The capability fingerprint participates in every implemented native warm-session key.
Codex `thread/resume` cannot replace dynamic tools, so protected cold starts use
the existing session-loss replay to open `thread/start` with the mandatory tool
profile. Warm sessions with the same capability remain reusable.

`boite_exec` accepts only command, argv and an optional checkout cwd. It runs
through the production process registry and OS boundary, then publishes only
validated edits. It cannot set environment, pass descriptors or request escape
or elevation. Default/acceptEdits ask the host for each command; bypass/YOLO skip
that approval; plan/dontAsk refuse commands. A host context with a restricted
tool list exposes no general command tool. The selected native mode/account
remain unchanged.

`boite_commit` is available only on a captured shared-compute branch. It stages
only the executor's validated changed-file manifest, requires an empty staged
index, rechecks captured file identities, disables hooks/filters/signing and
returns a real host Git object. Model tools never see host Git metadata.
Stop, archive, host selection changes and durable policy revocation close tools
and tracked trusted control. A later host-admitted attempt can install a new
capability; dropping a board goal releases the parent's process boundary, while
its captured descendants and consumed letter history stay scoped.

Claude and echo currently implement the tool-free `sideQuestion` used by
`contacts/concierge.ts`; Codex, ACP, Muse and pi do not. A reviewer on a route
without that capability records unavailable and starts no ordinary tool-using
turn. This is separate from whether that route can run protected compute.
Windows jobs track descendants; Linux/macOS track direct children/process
groups and cannot promise termination of a detached descendant. Shared
execution must account for that limit, not claim a captured PID is an OS sandbox.

### Native Linux tool execution

`ProcessPlatform.protectedExecution` now implements a native Linux boundary,
consumed through `procs.protection` by the Claude/Codex/Muse/OpenCode/pi protected adapters.
Other adapters must enforce their native file/tool gates and close alternate
shell, hook, MCP, extension and descendant paths before reporting support. Account authentication/control remains trusted and
separate; a tool receives neither the account home nor the ambient environment.
There is no spawn option to bypass an installed capability.

`install(threadId, input, assertCurrentAuthority)` captures the job, board claim
or letter, association revisions (including additional intersected scopes),
canonical checkout inode, selected host route, credential paths, expiry and
exact read exceptions. It binds before its first await. Reuse the returned
immutable `fingerprint` in warm-session identity; a new installation has a new
capability identity. `inherit(parent, child)` binds before a descendant's first
process. Each launch and `flush(threadId)` rechecks authority and captured
identities. `revoke(threadId)` closes every inherited binding, kills tools and
preparation helpers, then removes the private filesystem. Retries stay refused.
Only the trusted scope owner may `release(threadId)` after retiring the work.
Grant/claim/job/override revocation must call `revoke`, rather than wait for a
future tool call; expiry also terminates a running namespace automatically.

The private view omits classified names/content, hard links, symlinks, special
files and host Git metadata/config/hooks by default. Exact authorized read
exceptions expose only their captured files, including within a classified
directory. Configured account credential paths always stay excluded. The host
checkout is never a writable bind. Tools can read/edit/build/test in its private
view at the original absolute checkout path. After all tools exit, `flush`
validates the whole candidate, refuses hidden/linked/credential outputs and
host changes, then copies permitted file edits/new directories/deletions back.
Read overrides bind the captured file read-only and expire with their capability.
The boundary also permits the public system toolchain under `/usr/bin`,
`/usr/lib`, `/usr/lib64`, `/usr/include`, `/usr/share`, `/bin`, `/lib` and
`/lib64`, read-only, plus explicitly captured individual toolchain executables.
Credentials overlapping those runtime roots are refused. Home, temporary files,
procfs, devices and network namespaces are private. No host service, socket,
loader variable or credential environment is inherited. Extra descriptors,
visible windows and terminal launches are refused for protected tools.

The backend requires unprivileged user/mount/PID/network namespaces, seccomp
and maintained bubblewrap >= 0.13.1. It probes the actual production launch and
fails closed without any weaker fallback. Its seccomp filter prohibits new
namespaces (including namespace clone flags and clone3), mount/handle/ptrace
escape paths and io_uring. Ordinary fork/exec/threads remain available. It
also denies pathname UNIX socket creation, which could otherwise reach a
host socket through a public runtime mount; private socketpairs remain usable.
This works in containers with a read-only `max_user_namespaces` sysctl without
changing that sysctl. PID namespace teardown also kills detached descendants.

Use an installed maintained `bwrap`, or build the pinned userspace dependency
with `cc`, `tar` and libcap development files, without elevated installation:

```sh
bun packages/core/bin/install-linux-sandbox.ts /absolute/task-owned/bin/bwrap
BOITE_BWRAP_PATH=/absolute/task-owned/bin/bwrap BOITE_TEST_NATIVE_EXECUTION=1 bun test packages/core/test/protected-execution.test.ts --timeout 60000
```

The installer verifies the upstream 0.13.1 source SHA-256, compiles through the
registry and removes its build workspace. An optional second argument points to
an unpacked libcap development package prefix instead of a system development
installation. The helper path is trusted core configuration. Nothing downloads,
builds or launches at core startup. Native tests are explicitly enabled by
`BOITE_TEST_NATIVE_EXECUTION=1`; refusal/cancellation tests run without it.
`test/fixtures/native-protected-tool.ts` is an ordinary deterministic program
that edits source, builds it and runs a child test command while attempting
synthetic file/credential/link/descriptor/child reads. This is native OS evidence,
independent of provider inference. `protected-drivers.test.ts` additionally runs
the installed Claude SDK/CLI and Codex app-server against deterministic loopback
API responses, exercising useful edits/build/child tests, native forged file and
escape tools, synthetic credentials and hostile configured MCP/hooks. This
proves the production driver/control/tool path, without live inference.
`protected-adapters.test.ts` runs installed pi 1.4.0 and OpenCode 1.19.3 against
local APIs through their production adapters and the OS boundary: edits/builds,
child tests, forged native tools, hostile discovery, selected account auth,
warm reuse and revoked retries. Set `BOITE_TEST_PI_CLI` to its installed CLI
script. `protected-muse.test.ts` uses `BOITE_TEST_MUSE_CLI` for native Muse
1.4.13 production edits/builds/child tests, forged native read/shell/workflow
denial, selected synthetic account auth, warm/cold/tool-free and revoked turns.
It verifies missing required MCP and unresolved tool names stop before any
provider request. `protected-muse-limitations.test.ts` uses the separately
opted-in `BOITE_TEST_MUSE_LEGACY_CLI` to retain production refusal of 1.3.0.
`shared-access.test.ts` also exercises native Muse jobs, consumable Git commits,
associated letters and board claims with override, stop and revocation changes.
Windows and macOS do not gain this Linux backend.

### Activity review

Schema 42 persists sanitized `SharedAccessEvent` metadata at enforced boundaries:
association, attested actor, action, allow/deny, classification and a bounded
core-generated reason. Never include secret bytes, raw tool arguments,
credential-bearing paths or unrelated projects. `sharedAccess.get` pages these
events by association-bound event-ID cursor; the host and paired devices can
inspect history after revocation, while agents need a live own scope. Overrides
remain owner-only and are stored separately from reviewable events.
`core.sharedAccess.onEvent` supplies a post-persistence feed, and
`confirmed(eventId, associationId)` recognizes only a locally journalled
classified denial. Listener failure cannot change the deterministic decision.
This feed adds no timer, SDK or model process.

`contacts/review.ts` implements the optional reviewer. The host owner sets
`sharedProjects.configure.reviewer` and reads that private configuration with
`sharedAccess.reviewConfig`. It defaults off and has no implicit account or
fallback model. Provider/account/model/effort and `revokeOnViolation` stay
host-local. Unsupported tool-free routes record unavailable, never start an
ordinary turn. Claude and echo support this query path; Codex, ACP, Muse and pi
do not. The concierge and reviewer share `contacts/side-inference.ts`.

Schema 43 persists configuration revisions, admitted event work and reasoned
verdicts. Only activity attributed to the associated remote endpoint is
admitted, after opt-in. Owner override administration and old history do not
trigger inference. A request batches up to 32 events, with one request running
at a time. This page size never caps activity or agent exchanges. The model
gets only enumerated action, allow/deny, classification and core reason: no
identities, project names, message/task text, paths, override reasons, file
bytes, tool arguments or unrelated project lists. Evidence is data, never
instructions or owner approval. Its fresh tool-free side question has no
conversation history, tools, MCP, hooks, settings or Boite credentials.

The output is exactly one JSON object with `verdict` and a reason of at most
500 characters. The host redacts credential-like reason text and persists
evidence event IDs, assessment and consequence; `sharedAccess.get` includes
verdicts associated with the events on that page. Invalid output, failure,
unsupported inference or a 90-second deadline records unavailable. Nothing
retries inference automatically. A restart marks admitted/interrupted reviews
unavailable without running them; completed verdicts keep their receipts.
Only actual new activity starts a new query. No activity means no inference,
worker or new timer; heavy provider SDKs remain lazy. Shutdown cancels the
request and waits for its captured processes. Process coverage retains the
platform limits described above.

Only a locally journalled classified denial plus a model violation and current
`revokeOnViolation` can revoke. A model violation without that confirmation is
recorded as suspicious. Before applying a consequence the host rechecks the
association, both access records, current project grant, contact admission,
configuration revision and runnable account/provider. A delayed answer cannot
revoke a newer grant, replacement association or changed configuration.

The verdict and project-grant revocation commit together. Existing Contacts
revocation rejects pending letters and provider wakes and closes reply windows;
the shared-policy listeners fence reads, board writes, compute retries/results
and only the captured shared workers. Board revocation removes core-tagged
shared goals and stops their protected descendants without touching replacement
owner activities. A durable contact/project policy hold also prevents a later
letter or a trusted contact's automatic request from reopening access. A new
explicit owner grant clears that hold. A member without a direct contact may
instead initiate a new owner proposal under its gateway's current grant; only
that new local proposal clears the member's hold, and the peer must accept
the replacement association. A mirror refresh, incoming offer or replay cannot
clear it. Neither path reactivates the old association or its jobs.
Other contacts/projects and ordinary local turns keep their
authority. Repeated revocation changes no revision twice. Model delay, failure
or disagreement never unblocks the immediate deterministic file/tool decision.

### RPC and event permissions

All new owner methods still validate the selected owning Store/core. The
device allowlist is in `packages/contracts/src/access.ts`; the agent method
allowlist remains in `packages/core/src/access.ts`. Neither allowlist enables
unimplemented methods. These handlers and connection-scoped invalidations are
registered, with the explicit permissions below. New RPCs otherwise default
to owner-only.

| Methods | Owner | Paired device | Agent with its own `threadId` |
| --- | --- | --- | --- |
| Existing `contacts.*` administration; `sharedProjects.offer/decide/revoke/configure` | Yes, local endpoint only | Denied | Denied |
| Existing `collaboration.get/directory` | Yes | Yes | Yes, own source; peer grants still apply |
| Existing `collaboration.send/search/read/wait/contacts/ask` | Yes | Denied | Yes, own source; contact tier/read/reply rules still apply |
| Existing `collaboration.configure/identity/peers/check/trust/untrust/bridge.*` | Yes | Denied | Denied; a contact cannot become a trusted owner link |
| Existing `todos.list/add/update` and `todos.updated` | Local project | Same | Own project; no Done/reopen Done; event project scope |
| Existing `todos.remove` | Yes | Yes | Denied |
| Existing `delegation.get/result/wait/send/stop` | Own family | Follow/steer/stop | Own parent/child relationship |
| Existing `delegation.spawn/models/resume`; `delegation.configure` | Yes | Denied | Spawn/models and permitted resume only; never configure |
| Existing `files.list/read`, `git.status/diff` | Local scope | Existing project/credential guards and HEAD diff only | Own thread; shared policy applies additionally |
| Existing `artifacts.publish/view/preview`; `artifacts.read` | Local scope | Published snapshot read only | Own thread only; no contact file/preview authority |
| `artifacts.viewCheck` | Local thread scope | Denied | Own thread; shared publication policy covers the page, embedded files, draft ticket and returned captures |
| `sharedProjects.list/get/threads/search/read/subscribe` | Source project scope | Same scope | Own associated project; reads still need readThreads |
| `sharedBoard.get/apply/start` | Association + board consent, start uses its local reserved worker | Same; every board action | Own association, add/edit/claim/start; no remove/Done/reopen Done |
| `sharedCompute.models/list/get/send/cancel` | Host jobs or source scope | Follow/steer/cancel existing jobs, no admission | Own source jobs; no host policy or permission answers |
| `sharedCompute.start` | Explicit host opt-in and supported protection | Denied | Own source project, current grant and host-approved route |
| `sharedCompute.host` | Private persisted local host thread, for restoring host settings | Denied | Denied |
| `sharedAccess.get` | Sanitized scoped activity, including historical revocations | Same | Live own association metadata only |
| `sharedAccess.overrides/override/revokeOverride` | Host only, exact local paths | Denied | Denied |
| `sharedAccess.reviewConfig` | Host only, inference account and settings | Denied | Denied |
| `contacts.sendHuman` | Attested human, allowed contact destination | Same | Denied |
| `sharedProjects.changed` | Explicit connection subscription | Same subscription | Own thread + association, invalidation only |

Agents never receive all shared-project events. The server needs an explicit
shared-scope filter as well as `AGENT_EVENTS`; `sharedProjects.subscribe` owns
that connection's exact source/association lease. A signed contact request
uses the peer method subset, never these owner/device/agent WebSocket roles.

### Acceptance matrix

The named suites exercise behavior on fresh journals and deterministic fixtures.
Core fixtures use real RPC sockets and signed/sealed peer transport. Browser
fixtures use the in-memory client and prove presentation, not OS isolation.
An unavailable requirement is recorded explicitly rather than counted as passed.
Native results below apply to these observed hosts and modes, rather than every
platform a provider can launch on.

| Native host | Claude / SDK | Codex / app-server | OpenCode / ACP | pi / RPC | Muse / MSP |
| --- | --- | --- | --- | --- | --- |
| Linux x64, Bun 1.4.3, bubblewrap 0.13.1 | Tools, jobs/Git, board, letters | Same | Same; explicit unavailable model refused before API | Same | Same, verified 1.4.13 only |
| Windows x64 NT 10.0.26200, Bun 1.4.3 | Tools, jobs/Git, board, letters | Same | Same; explicit unavailable model refused before API | Same | Not attested |
| Hosted Server 2025 NT 10.0.26100 | Native NUL prerequisite refuses admission | Same | Same | Same | Not attested |
| Linux arm64 | Backend source exists; native execution not attested | Same | Same | Same | Same |
| macOS | No protected backend; refused | Same | Same | Same | Same |

Native fixtures exercise Claude 2.1.310 and Codex 0.164.0 in default and YOLO,
OpenCode 1.19.3 in default/build, pi 1.4.0 in YOLO, and Muse 1.4.13 in default
and YOLO on Linux. OpenCode also admits plan with deterministic mode-admission
coverage; a complete native plan scenario is not attested. pi admits only YOLO
or bypassPermissions. Muse pins its MSP fingerprint and refuses legacy 1.3;
other versions remain unsupported. Echo/default is tool-free orchestration.
Control clients retain the selected host account and necessary API/auth transport;
only model-facing tools enter OS containment. No live inference, Meta-login
refresh, real quota, nine concurrent native jobs, physical phone or real
Tailscale/Funnel acceptance is implied by these fixtures.

| Required outcome | Executable evidence | Coverage and current limit |
| --- | --- | --- |
| Explicit association and allowed foreign threads | `packages/core/test/shared-projects.test.ts`; `tests/e2e/shared-cores.test.ts`: two owners associate a group member; member initiates association; `packages/ui/src/lib/fake-client.shared-projects.test.ts` | Exact colliding owner/core/project/thread IDs, private project exclusion, read/search grants, wrong source/route refusal, owner/paired/agent roles, reverse member offer and persisted association. No foreign owner RPC is created. |
| Shared four-column board and goal | `packages/core/test/shared-board.test.ts`; `tests/e2e/shared-cores.test.ts`; `packages/ui/src/components/shared/SharedCollaboration.test.ts`; `tests/e2e/shared-collaboration.test.ts` | Atomic competing claims, receipts, field patches, offline replay/restarts, permanent deletes, protected goal start/release/progress, retained busy assignment, person/machine/agent labels and phone menus. Native goal transitions are covered in `shared-access.test.ts` for Claude/Codex/Muse/OpenCode/pi on Linux and Claude/Codex/OpenCode/pi on Windows. |
| Host compute and actual Git consumption | `packages/core/test/shared-compute.test.ts`; `SharedCollaboration.test.ts`: reopen a host from another thread; `tests/e2e/shared-cores.test.ts`: consume an attested Git result and cancel reverse compute after member restart | Host account/profile, persisted private parent, unchanged-policy authority, contribution settings, durable job and exact result, repository/base validation, restart and captured cancellation. The source performs a real fixture-controlled fetch, object/ancestry check and cherry-pick of the returned commit. No automatic peer URL/command execution. Claude/Codex/OpenCode/pi native fixtures edit/test/commit through the production driver and consume the returned real commit on Linux and Windows. Muse 1.4.13 has native Linux job/letter/board fixtures; other ACP implementations remain refused. |
| Human and agent contact mail | `packages/core/test/contact-mailboxes.test.ts`, `coordination.test.ts`; `tests/e2e/shared-cores.test.ts`; `tests/e2e/contact-messaging-ui.test.ts`, `shared-collaboration.test.ts` | Owner/paired human sends, agent impersonation refusal, recipient's configured contact name, separate provenance, both member directions, source journal and mailbox replay/restart. No external letter answers owner approval. |
| Audit regressions and selective invalidation | `packages/core/test/contacts-review-regressions.test.ts`, `shared-projects.test.ts`, `shared-review.test.ts`, `shared-compute-journal.test.ts`; `packages/ui/src/lib/store-shared-projects.test.ts`; `tests/e2e/shared-cores.test.ts` | Contact wake/steer/hooks/history and intersected guards, transcript post-await revocation/readmission/restoration, human mailbox provenance after gateway restart at the default tier, current-revision direct/member lease teardown, access-only refresh, retained compute fences and cancellations. Claude/Codex/OpenCode/pi native associated-letter execution and ordinary warm-session retirement are covered on Linux and Windows in `shared-access.test.ts`; Muse is covered on Linux. Unsupported routes remain held. |
| Secret file and tool boundaries | `packages/core/test/shared-access.test.ts`, `shared-review.test.ts`, `ntfs-file-ids.test.ts`; `packages/ui/src/lib/fake-client.shared-projects.test.ts` | Classified files/content, handles/symlinks, Windows path forms/identities, transfer/tickets/HTML/attachments/checkpoints, overrides and immediate revocation. All six protocols have admission checks; echo/default reports no-tools, Claude/Codex use the native boundary and OpenCode/pi have separate native adapter fixtures; Muse 1.4.13 has native job/letter/board fixtures; other ACP implementations remain refused. Dedicated `protected-windows.test.ts` fixtures establish Windows execution independently of Linux. |
| Native Linux tool boundary | `packages/core/test/protected-execution.test.ts`; `packages/core/test/fixtures/native-protected-tool.ts` | Production registry launches an ordinary program: useful read/edit/build/child test, denied synthetic secrets/outside files/credentials and inheritable descriptors/links/children, isolated network, exact read-only overrides, immutable scope/retry/cwd, expiry/revoke/cleanup (including detached descendants), unsupported-host refusal and ordinary local process retention. Claude/Codex integration is covered by `protected-drivers.test.ts` and native `shared-access.test.ts` scenarios; Muse uses `protected-muse.test.ts` and the same native scopes. OpenCode/pi adapter behavior is covered by `protected-adapters.test.ts`, with full job/board/letter and Git integration in `shared-access.test.ts`. |
| Native Windows tool boundary | `packages/core/test/protected-windows.test.ts`, `protected-drivers.test.ts`, `protected-adapters.test.ts`, `shared-access.test.ts` | Real Windows processes exercise useful project edits/builds/child tests, synthetic file and descriptor denial, read-only exceptions, offline networking, scope/account/mode retention, restart and captured descendant termination/identity cleanup. Claude/Codex/OpenCode/pi use native clients and deterministic local APIs for remote jobs, letters and board scopes. Muse Windows and macOS remain unverified. |
| Lazy review and confirmed project revoke | `packages/core/test/shared-review.test.ts`; `tests/e2e/shared-cores.test.ts`: member policy revocation without a direct contact | Tool-free deterministic verdicts, confirmation independent of inference, timeout/invalid/stale response, no-work laziness and exact local project hold. A member hold does not mutate gateway grants or obtain owner authority; a stale mirror cannot reopen it. |
| Security and network proof | `packages/core/test/contacts.test.ts`, `contacts-group.test.ts`, `contact-mailboxes.test.ts`, `contacts-review-regressions.test.ts`, `access.test.ts`; `tests/e2e/shared-cores.test.ts`: held transcript and readmission regressions | Independent security/network passes identified three access/provenance faults, a review feedback loop, stale lease teardown and compute scan waste. Regressions cover their corrections. Per-peer SQLite expression indexes/selective materialization retain all durable job fences. The independent combined native-isolation review remains a separate gate; fixture passes do not substitute for that review. |
| Transport and UI parity | `tests/contract/shared-projects.ts` through core/fake contract suites; fake/Store tests; `tests/e2e/shared-collaboration.test.ts` at 1440 and 390 px | Same contract and refusals, captured owning Store, canonical remote offers/addresses, connection cache fencing, leases and phone actions. No paid inference, physical phone, real Tailscale/Funnel or remote CI proof is implied. |

Local release proof on 2026-10-24 reran `bun run check`, 733 core tests in
35 isolated file processes, seven real three-core scenarios, 99 UI tests and
seven browser tests. All passed at runtime head `9bd9211e`. Desktop (1440 px)
and phone (390 px) interactions also showed a contact-owned board assignment,
converged completion, attested human mail, host job results and revocation;
their captures were opened. Fresh network regression replays recorded one
inference and no recursive refresh with the reviewer enabled, then zero peer
leases and no notification traffic after unsubscribe.

Publication verification after reconciling the merged Contacts dependencies
reran the full check (1,153 architecture modules, no Svelte errors or warnings),
300 core/E2E tests in 19 files and 96 UI tests in eight files. Four Boite browser
fixtures at 1440 and 390 px repeated the shared board/mail/job/revoke flow and
restored a different persisted host conversation. Saving the unchanged numeric
contribution preserved its binding, grant revision and running jobs at both ends.
The desktop and phone captures were opened. These remain deterministic
protocol/UI fixtures, not native-provider isolation proof.

The independent combined native review found an OpenCode model-selection defect
and the Server 2025 admission blocker. Protected ACP now requires confirmed model
selection before fresh and warm prompts. Native regressions cover refusal before
any API request, including a complete remotely hosted job. Server compatibility
and current-head CI/review clearance remain required release gates.
Claude/Codex/OpenCode/pi now have native Linux and
Windows driver/control/tool fixtures proving useful edits/build/tests, forged
tool denial, account/mode retention, associated letters/board goals, warm
transitions, protected stop/overrides and real Git result consumption. These run
installed clients against deterministic local APIs without inference.
Muse 1.4.13 proves its mandatory native-tool gate, useful execution,
job/letter/board transitions and actual Git consumption on Linux; 1.3.0 remains
refused. Muse Windows, native macOS and live inference remain unverified.
Windows evidence comes from its own native lane, independently of Linux.
The full native Windows result currently comes from NT 10.0.26200. Exact SDK
clang and MinGW helper bytes from CI both pass there. On Server 2025 NT
10.0.26100, the existing NUL device denies LPAC read/write with native error 5;
private pipes and direct child creation succeed. Both compilers reproduce this
failure. Admission now checks NUL access before any model tool. The Server CI
lane remains red, so Windows readiness remains incomplete; the 26200 result does
not attest Server 2025 compatibility. No host device ACL is changed.

### Native Windows tool execution

`ProcessPlatform.protectedExecution` selects the Windows LPAC backend. It reuses
the immutable policy, filtered checkout, exact read exceptions, authority
callbacks and checked publication used on Linux. It copies explicitly captured
toolchain executables into a private read-only runtime. Tools work in the private
checkout directory; the original host checkout path grants no access. Windows
PE executables are checked by their native extension and captured file identity,
rather than POSIX execute bits.

The Windows copy uses a user temporary directory on the system volume. Bun's
AppContainer path fallback reconstructs DOS directory names only on that
volume. A compatible configured temporary directory is retained; otherwise
the backend uses `LOCALAPPDATA/Temp` after canonical volume validation, or
refuses preparation. The host checkout can remain on another volume. This
selection changes neither global TEMP/TMP nor any host ACL.

`platform/windows/protected-tool.c` creates an unpredictable per-capability
AppContainer profile and changes ACLs only inside that task's scratch directory.
It grants the package project edits, private home/temp and runtime reads, with
read-only ACLs for exact file exceptions. No host directory ACL, firewall policy,
loopback exemption, elevated token or service is installed. LPAC excludes ambient
`ALL APPLICATION PACKAGES` grants; only the explicitly allowed private files and
Windows' public LPAC runtime remain accessible. The sole capability is
`registryRead`: native child creation needs the public Windows registry keys
whose ACLs grant that SID. It does not grant arbitrary registry keys or restore
ambient application-package access. No network capability or host credential
environment is supplied.

Each root starts with kernel process attributes for LPAC, only three duplicated
standard handles and a private non-breakaway Job Object. The launcher verifies
the suspended child's AppContainer token; a trusted native probe must also fail
to read a task-owned file granted only to `ALL APPLICATION PACKAGES`. This tests
LPAC access rather than relying on an unsupported token-information query. Neither
the private job handle nor other inheritable host handles reach the tool.
Each launch owns an invisible window station and desktop, with ACLs for that
capability and its owner only. A hidden console permits toolchain descendants.
Launcher termination closes the job and kills descendants. A normal root exit
also terminates and drains detached descendants before reporting success. Revoke
and expiry stop captured processes before deleting the private profile and
filesystem. Native control bridges revoke their channel immediately and remove
their private directory after the captured process releases its Windows working
directory. Windows' normal process registry and guards still trace the launcher
and its children. Checked publication retains full metadata checks before
opening a host file. When NTFS updates ChangeTime on a write-open, it also checks
the file object, size, LastWriteTime and captured content through that same
descriptor before writing.

Build with a preinstalled Windows SDK clang or MinGW, then configure the host
helper path (or put it beside the running core executable):

```powershell
bun packages/core/bin/install-windows-sandbox.ts C:/task-owned/bin/protected-tool.exe
$env:BOITE_WINDOWS_SANDBOX_PATH = 'C:/task-owned/bin/protected-tool.exe'
$env:BOITE_TEST_NATIVE_EXECUTION = '1'
bun test packages/core/test/protected-windows.test.ts --timeout 120000
```

The build script also accepts Linux's installed cross compiler to produce the
userspace PE helper; cross-compilation alone is not native execution proof.
Nothing compiles or downloads at core startup. Missing helpers or unsupported
Windows kernel attributes fail closed before a model tool runs. The launcher
creates and releases its own window station and desktop, including in a
noninteractive session; it does not alter a host station or desktop ACL.
It also sets a package-specific default DACL on the suspended job token for new
private IPC objects. Helper protocol version 2 first runs the real admission
probe through direct LPAC execution. Only an empty-output exit 125 with the
exact NUL access-denied diagnostic permits repeating that same probe through
`run-null-broker`. A successful probe pins the mode and helper file identity and
bytes for the session; every other failure refuses admission.

The broker adds task-local process debugging while preserving the same LPAC,
sole registry capability, three standard handles and exact private job. Before
continuing each process creation it verifies that job, package, NOALLAPPPKG and
capability identity. It brokers only exact Null requests, opening the fixed real
`\Device\Null` afresh and duplicating that handle with its requested access and
mode. Other paths execute in the target token. Invalid output memory passes
through to the real syscall. Application exceptions remain forwarded. A single
step owner per process, continued thread exits and parked-event replay protect
concurrent calls. Process/thread ledgers grow with the live workload; only
startup, owned steps and draining have deadlines, not the entire tool session.

This broker currently requires the pinned x64 ntdll SHA256
`160ef9b82e2895ef48fa031cb1cf683a8b123febf7cf7d5590cd3104864424b3`, its
verified exports and loader site. Unsupported images fail closed. Installations
whose direct probe succeeds keep direct execution. `protected-tool.exe
--diagnose-null` prints the existing device DACL without changing it. Historical
build 26100 direct NUL failures and the positive build 26200 native fixture do
not prove this new production integration; current-head native CI decides it.
The native Windows CI lane runs inside the existing Windows core check, including protection
changes on a draft PR. It uses synthetic directories/accounts and deterministic
local provider APIs. Its fixture checks useful builds/tests, secret paths,
junctions/hardlinks, inheritable handles, host process access, offline networking,
read-only overrides, expiry/revoke/root-exit descendants and cleanup. A successful
breakaway creation must finish its captured child's lifetime before the root
exits, under the broker's exact-job and LPAC binding. The suite also exceeds the
old diagnostic's cumulative process limit. Native driver/shared-access and Muse
MSP admission scenarios run with both SDK and MinGW helpers. Their Windows
results remain required; Linux results do not establish them. macOS has no
protected execution backend.

### Client transport

`Client.call` is generic over the domain contracts. The fake dispatch table
exhaustively implements the shared-project, board, compute, protection and
human-letter RPCs in `lib/fake-client/shared-*.ts`. Fake cores must join and
grant projects explicitly; compute fixtures register repository/base identity
with `setSharedRepository`, then finish captured jobs with `finishSharedCompute`.
Neither fixture accepts caller-supplied result provenance through RPC. The
fake is an in-memory behavioral fixture, not a provider process sandbox.
Captured fixture file reads deny secret names/content and honor the exact
host job override; real file identities, links and streaming tickets are
validated by the core tests.

Each owning Store exposes `store.shared`: `load(threadId)`, `watch(scope,
surfaces)`, `view(scope)`, typed `call`, `read` and `sendHuman`. Pass canonical
project/thread refs intact and use `threadKey(ref)` for identity. Public relay
addresses stay separate; a foreign thread ID never selects a local Store.
Only watched scopes subscribe, with one active read and one coalesced trailing
read. Board pages apply contiguous revisions and tombstones; a gap reloads the
snapshot. Access invalidation rereads the displayed page so delayed review
verdicts appear even without a new access event. Reconnect drops cached results
and leases, retaining only live consumer intent. Revocation clears that scope's
threads, board, jobs and access page and releases its subscription.

`tests/contract/shared-projects.ts` runs the same association, read refusal,
board receipt/update/delete, human provenance, host policy and revoke scenario
through `packages/core/test/contract.test.ts` and
`packages/ui/src/lib/fake-client.contract.test.ts`. Additional fake/Store tests
exercise duplicate IDs on two machines, offline board edits/cancellation,
agent/phone rights, secret-text projection, exact overrides and reconnect races.
The integrated member relay and source mailbox implementations share Contacts
admission and transport. Their internal routes grant neither owner RPC rights
nor access to another endpoint with the same project or thread ID.
