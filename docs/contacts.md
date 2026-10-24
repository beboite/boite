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

## Projects and requests

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
the RPC methods), `invitations.ts` (making an invitation and the origin it
names), `funnel.ts` (the routes on Tailscale Funnel), `join.ts` (both sides
of a join), `invite.ts` (the link format), `words.ts`
(fingerprint words), `tier.ts`, `git-remote.ts` (read from the git config
files, no process), `concierge.ts` and `tailscale.ts`. `contacts.*` are
owner-only; agents call `collaboration.contacts` and `collaboration.ask`.
`packages/core/test/contacts.test.ts` links two cores over loopback, and
`contacts-parts.test.ts` covers the pieces, the Tailscale client against a
stubbed `fetch`. `contacts-funnel.test.ts` drives the Funnel mounts through
the fake CLI (`test/fixtures/fake-tailscale.ts`), and `magic-dns.test.ts`
the tailnet name lookup against a resolver on loopback.

This machine's tailnet name is the PTR record of its tailnet address at
100.100.100.100, asked as one UDP datagram (`group/magic-dns.ts`). On Windows
`node:dns` answered that question from the system resolver, which names the
machine by its bare host name, so a Windows core had no tailnet name and
refused every invitation.

## Completion protocol

The following is the version 1 contract and implementation acceptance plan.
The primary-core association, scoped thread/search/read service and scoped
subscriptions are implemented in `contacts/projects.ts`. The durable board
service is in `contacts/board.ts`, with its protocol in [board.md](board.md#shared-board-protocol).
Host-owned compute admission and the workflow adapter are implemented in
`contacts/compute.ts` and `workflows/shared-compute.ts`. Compute admits only
tool-free echo until a host-enforced execution boundary is installed; human
letters, file enforcement, reviewer, fake handlers and UI remain integration work.
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
broader legacy query. Agent letters still use the existing delivery path; their
association scope belongs to the human-letter/delivery integration.

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

Member endpoints currently fail with a member-relay requirement. Integrating
PR #755 must extend its existing `ContactMembers` relay for the bounded
`contact.project` payload, preserve canonical host IDs separately from its
public aliases and revalidate member admission. It must not infer authority
from the alias suffix or copy the relay into a second implementation. PR #756's
source mailboxes remain a separate dependency.

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
and association. `sharedProjects.changed` is an invalidation containing only
that scope. Reads recover from their last durable cursor after reconnect;
unsubscribe, disconnect, moving the source thread, removal and revocation
release subscriptions. Notifications go only to explicit subscribers, with
coalescing and backpressure; no global foreign-thread stream. Delayed results
recheck current permission and client/navigation generation.

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
ACP and pi shared routes are refused because the current adapters cannot
attest the offered permission semantics. Claude, Codex and Muse retain their
existing permission mapping, but also require an actual host protection service;
none starts by default. Echo accepts only default mode and blocks its scripted
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
input and the timeline. A contact human has no invented model/tier; agent mail
continues to obey `minTier`. Require negotiated human-letter support, never
fall back to an owner prompt on an older peer. None of these external letters
answers an approval or changes host settings.

`contacts/access-policy.ts` binds shared compute workers, shared board goals
and their children to the captured checkout, association and grant revision.
It denies environment variants, private keys, credential directories/files,
hard links and paths outside that checkout. Both the supplied spelling and
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

Current `sharedExecutionProtection` admits only echo in its default no-tools
route. Claude, Codex, ACP, Muse and pi advertise `supported: false` with a
protocol-specific reason and are refused before a protected turn starts.
There is no isolated external provider implementation yet. Consequently real
provider shared compute and shared board execution remain unavailable; the
deterministic fixture coverage does not complete that feature.

| Driver | Existing boundary and limitation | Required shared admission |
| --- | --- | --- |
| Claude | SDK `canUseTool` is reached only for approval; `PreToolUse` currently records tools. YOLO allows approvals and disables configured hooks. Arbitrary shell/MCP/native child work can read outside a lexical tool gate. | Enforce below bypass and across children, tools, processes and output; otherwise refuse. |
| Codex | Native approval/sandbox pair; workspace-write permits reads outside the workspace and unrestricted modes skip approval. A mode change replaces the process. | Verify an actual file-denying execution boundary; no claim that read-only/workspace-write hides secrets. |
| ACP | Advertised modes are provider-specific; a refused/absent setter currently logs a warning and continues. Approval events do not cover every operation. | Capability-specific enforcement; a protected shared start must fail closed on an unenforceable route. |
| Muse | Native approval mode plus launch-time sandbox flags; permissive modes disable its sandbox. No evidence here of selective secret read denial. | Verify process isolation and keep the chosen supported mode; otherwise refuse. |
| pi | RPC has no approval call; permission mode does not reach the CLI. | Require host process isolation or deny protected compute, never simulate an approval gate. |
| echo | In-process deterministic fixture; no provider tools/network. | Exercise the same admission/revoke ledger; report no-tools, not proof of external driver isolation. |

Claude and echo currently implement the tool-free `sideQuestion` used by
`contacts/concierge.ts`; Codex, ACP, Muse and pi do not. A reviewer on a route
without that capability records unavailable and starts no ordinary tool-using
turn. This is separate from whether that route can run protected compute.
Windows jobs track descendants; Linux/macOS track direct children/process
groups and cannot promise termination of a detached descendant. Shared
execution must account for that limit, not claim a captured PID is an OS sandbox.

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
This feed adds no timer, SDK or model process. Verdict projection and the
reviewer itself are not implemented by the file-policy service.

A lazy host-configured reviewer
uses the tool-free side-question path over only relevant events, with no owner
or agent token, hooks, MCP, disk tools or ordinary conversation history.
Persist a verdict and its evidence event IDs, reason and applied consequence.

Only a current local policy confirmation plus configured `revokeOnViolation`
can turn a model's violation verdict into revocation of this exact project
grant. Suspicion alone cannot widen access or choose another contact/project.
Repeated verdicts/revokes are idempotent. Invalid output, injected activity,
timeout, absent inference support or failed inference records unavailable;
none unblocks a deterministic denial. Delayed verdicts recheck the association
and access revision. A confirmed revoke also closes reply windows, reads,
board writes, queued wakes, compute and result delivery. No activity means no
inference, worker or new timer.

### RPC and event permissions

All new owner methods still validate the selected owning Store/core. The
device allowlist is in `packages/contracts/src/access.ts`; the agent method
allowlist remains in `packages/core/src/access.ts`. Neither allowlist enables
the reserved methods at the contract stage. All new RPCs default to owner-only
and remain unregistered; the new event is neither emitted nor allowlisted.
The following rows for new methods describe intended permissions, installed
only alongside enforcing handlers and scoped subscriptions.

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
| `sharedProjects.list/get/threads/search/read/subscribe` | Source project scope | Same scope | Own associated project; reads still need readThreads |
| `sharedBoard.get/apply` | Association + board consent | Planned: same; every board action | Planned: own association, add/edit/claim; no remove/Done/reopen Done |
| `sharedCompute.models/list/get/send/cancel` | Host jobs or source scope | Planned: follow/steer/cancel existing jobs, no admission | Planned: own source jobs; no host policy or permission answers |
| `sharedCompute.start` | Explicit host opt-in and supported protection | Denied | Planned: own source project, current grant and host-approved route |
| `sharedAccess.get` | Sanitized scoped activity, including historical revocations | Same | Live own association metadata only |
| `sharedAccess.overrides/override/revokeOverride` | Host only, exact local paths | Denied | Denied |
| `contacts.sendHuman` | Attested human, allowed contact destination | Planned: same | Denied |
| `sharedProjects.changed` | Explicit connection subscription | Same subscription | Own thread + association, invalidation only |

Agents never receive all shared-project events. The server needs an explicit
shared-scope filter as well as `AGENT_EVENTS`, and then the client/fake step
adds that event and the planned methods with reasons. A signed contact request
uses the peer method subset, never these owner/device/agent WebSocket roles.

### Acceptance matrix and implementation ownership

These are required behavioral scenarios, not claims of tests already passing.
Each fixture uses fresh data directories and deterministic echo/stub providers.
`integration` must replace scenario descriptions with test names/evidence,
and `proof` must run them on the integrated branch with inspected captures.

| Outcome | Existing entry points/consumers | Required behavior and test ownership |
| --- | --- | --- |
| 1. Explicit project association and foreign threads | `contacts/store.ts`, `contacts/rpc.ts`, `coordination.ts`, `coordination-lookup.ts`, `coordination-peer.ts`; UI `lib/contacts.svelte.ts`, owning `lib/store.svelte.ts`/`lib/workspace.svelte.ts`, project chooser and sidebar | `shared_projects`: two cores with identical project/thread IDs associate exact endpoints; private projects/settings/contacts remain absent; readThreads off denies transcript/chat search; rename, archive, revoke during await, offline recovery and restart. `client_transport`: same core/fake refusals/events. `collaboration_ui`: both owners grouped by person/machine at desktop/phone widths. |
| 2. Synchronized board and goal | `todos.ts`, `activity.ts`; UI `components/ProjectBoard.svelte`, `lib/board.ts`, `lib/fake-client/todos.ts`; contracts `todos.ts` | `board_replication`: simultaneous CAS claims start exactly one goal; mixed-field offline edits converge in accepted order; duplicate delivery adds no revision/echo; restart retains receipts and permanent deletes; stale goal sequence/old claim cannot revive a card; lost authority prevents work. `collaboration_ui`: menu moves, checklists, person/machine/agent, confirm/remove without drag on phone. |
| 3. Host-authorized compute and git result | `delegation.ts`, `delegation/routes.ts`, `delegation/worktrees.ts`, `workflows.ts`, `workflows/register.ts`, `procs.ts`, `resource-usage.ts`, `platform/` | `shared_compute`: two/three-core fixture runs four local/five remote under the correct host profiles and configured contribution; duplicate start/retry/restart is one job; reject wrong repository, ref/path/account/mode/result injection; verify exact branch/base/commit and consume through normal git workflow; host cancel/revoke stops only captured jobs and rejects late result/retry. All six driver capability/permission paths tested with protocol fixtures, no paid calls. |
| 4. Human contact letter | `coordination-letter.ts`, `coordination.ts`, `coordination-peer.ts`, UI `components/AgentDiscussion.svelte`, `lib/timeline-rows.ts`, `lib/fake-client/coordination.ts`; PR #756 origin-thread mailbox route | `client_transport`: owner/paired human sends, agent impersonation refused, receiving local contact name wins, contact-human/agent/owner prompt visibly distinct, no permission/question answered, repeat ID stable. Three cores preserve canonical destination, source journal and one wake through B/restart. `collaboration_ui`: direct message from allowed agent row on desktop/phone. |
| 5. Secret file policy | `workdir.ts` file RPC/credential classification/handle checks, `files.ts` listing, `server/file-response.ts`, `artifacts.ts`, `artifact-preview.ts`, `views.ts`, `attachments.ts`, git/checkpoints, driver tool/process admission | `file_protection`: .env variants/private keys/credential classifications denied before read or transfer, path traversal/symlink swap/Windows forms/ticket after revoke/HTML neighbouring asset/git diff/transcript/tool/child escape covered; ordinary file succeeds, ordinary local session unchanged, exact host override expires/revokes. Unsupported protected execution fails before spawn in core and fake. `security_review` independently verifies real boundaries. |
| 6. Lazy review and confirmed revoke | `contacts/concierge.ts`, `drivers/types.ts` sideQuestion, `drivers/claude/side-question.ts`, `drivers/echo.ts`; shared admission event feed | `activity_reviewer`: legitimate vs suspicious vs confirmed violation using stubs; malicious activity cannot instruct the reviewer or select another project; timeout/invalid/unsupported/delayed output remains unavailable; denial immediate with reviewer stalled; concurrent/replayed verdict and restart revoke once; unrelated project and secret canaries absent; no-work core starts no reviewer/SDK/worker/timer. |
| 7. Security and network proof | `contacts/join.ts`, `invitations.ts`, `funnel.ts`, `group/seal.ts`, `group/relay.ts`, `coordination-wire.ts`, `coordination-peer.ts`, all surfaces above; `tests/contract/scenarios.ts` | `security_review`: signatures/seal/replay/nonce/destination/origin, grant changes during awaits, invitation/Funnel mounts, group admissions/relays, file/ticket/preview exposure, message provenance, job/result authority and revoke. `network_review`: fresh bytes/requests/idle resources and restart/reconnect for 0/1/multiple active associations, offline retries and unsubscribe; no unrelated broadcasts or steady polling. `review_fixes`: each confirmed finding red before fix, then green. `proof`/`final_review`: full check, relevant suites, multi-core E2E, inspected desktop/phone captures. |

Paths in the table are relative to `packages/core/src/` unless prefixed UI or
contracts. UI paths are under `packages/ui/src/`. Verify exact source names
when implementing: the table identifies the present integration boundaries,
not new services to create automatically.

The real/fake parity work belongs to `client_transport`: implement every new
RPC in `packages/ui/src/lib/fake-client/`, extend `FakeMethods` exhaustiveness,
owning Stores, events/reconnect and the shared scenarios in
`tests/contract/scenarios.ts`. `Client.call` is already generic. The core and
fake contract runners are `packages/core/test/contract.test.ts` and
`packages/ui/src/lib/fake-client.contract.test.ts`. No temporary known
divergence may stand in for a required capability. Integrate the reviewed
#755 and #756 commits rather than copying their routing implementations;
reconcile their shared contact/peer/docs edits before final validation.
