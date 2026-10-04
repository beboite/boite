# Groups

A group is the set of machines one person owns. Put a machine in a group and
it connects to every other machine of it, in both directions, with no pairing
link each. A phone paired with one machine reaches all of them. Agents on one
machine find the agents of the others.

Before groups, each of those was set up one pair at a time: a pairing link per
client and per core, the browser origin of every other core added by hand, and
an agent link between two cores that both needed an HTTPS address. Those still
work ([machines](machines.md), [coordination](coordination.md)) and remain the
way to connect a machine you do not fully trust.

## Trust

**Every machine of a group has full control of the others.** A member may
invite a machine, remove one, and vouch for a client at the owner role. Group
only machines that are yours. A machine that is partly trusted, a friend's or
a shared server, takes a pairing link instead: that link gives one direction
and one role.

A removal takes effect on each member when it hears of it. Until then that
member still treats the removed machine as one of the group, with full control
of it: a machine removed while another member was off can still do on that
member whatever a member can. Once a member has heard, the removed machine
comes back only through a new invitation. It cannot write itself back in, even
by way of a member that has not heard, because what makes a machine a member
is the signature of a machine the receiver already counts as one. Remove a
machine you believe is compromised while the others are on, or have every
member leave and start a new group.

What members say to each other is encrypted end to end. What a client says to
a machine is not: it is as private as its transport ([the network](#the-network)).

## Using it

In Settings, Machines:

1. On one machine, **Create a group** and name it.
2. On that machine, **Invite a machine**. The invitation works once, for ten
   minutes, and whoever holds it joins: treat it as a credential.
3. On the machine that joins, paste it under **Join a group**.

The two machines list each other and connect. A third machine joins with an
invitation from either. A phone needs nothing more than its usual pairing
link, from any member ([phone](phone.md)): once paired, it connects to the
others at the same role, and keeps reaching them when the machine it paired
with is off.

**Leave the group** takes this machine out and tells the others first.
**Remove from the group** takes another machine out; that machine is told and
leaves on its own, or learns it the next time it reaches a member. Revoking a
paired device on any member revokes it on all of them.

The group card also offers one switch to keep the settings of every connected
machine like the selected one. It turns on the per-machine synchronization
described in [machines](machines.md#automatic-settings-synchronization) for
all of them at once, and has the same limits: the copy runs while that window
is open.

A machine with no window uses the core's command, on the data directory of
the running core:

```sh
boite-core group create Home
boite-core group invite          # prints the invitation, and nothing else, on stdout
boite-core group join            # reads the invitation on its standard input
boite-core group status
boite-core group leave
```

`join` takes the invitation on its standard input only, pasted then Ctrl+D or
piped: given as an argument it would sit in the process list, in the shell's
history and in a traced command line, where whoever reads it could join first.
`--data-dir` and `--channel` name another core, as they do at start.

## The network

Tailscale is the expected network. A machine in a group answers on its tailnet
address, and gives the other members these addresses, best first:

1. its public HTTPS address, when `publicUrl` is set ([phone](phone.md));
2. its MagicDNS name, `http://<name>:<port>`;
3. its tailnet address, `http://100.x.y.z:<port>`;
4. its LAN address, when the core listens on the network (`listenOnLan`).

A member dialing another asks the address that answered last, and the
others once that one has failed or stayed silent for a second, and keeps the
first that answers with a valid signature. A machine reachable by any of the
four is reached, and a request is not sent twice to a machine that has two
addresses: the copy would be refused as a replay and counted against its
sender. What it sends is sealed to that machine's key, so an address that
leads elsewhere reads nothing and cannot answer. When none answers and the
owner's app is connected to both machines, the app relays the sealed request,
as it does for two machines linked by hand ([coordination](coordination.md)).

A client is sent to fewer of them, because its link is not sealed: to the
HTTPS address alone when the machine has one, and otherwise only to an address
written as numbers. A name over plain HTTP is whatever the client's resolver
says it is, so a client never sends a ticket or a key to one. A pairing link
follows the same rule.

The core reads its tailnet address off Tailscale's own network interface
(`tailscale0`, `Tailscale`, or on macOS a `utun` that also carries a Tailscale
IPv6 address) and its MagicDNS name from the PTR record Tailscale's resolver
at 100.100.100.100 answers. It runs no Tailscale command. An address in
100.64.0.0/10 on any other interface is not taken for a tailnet: a carrier or
another VPN hands out the same range, and nothing is opened there. A machine
with no tailnet gives its LAN address, and two machines on one LAN group the
same way once both listen on the network.

Joining or creating a group makes the core listen on the tailnet address too,
on the same port, beside the address it was started on. It stops when the
machine leaves. Nothing else is opened: a core that listens on itself stays
closed to the LAN. `--host` or `--lan` on the command line names the only
address a core answers on, and such a core opens no other. On Windows the
first listener outside loopback raises the firewall prompt for the core.

A machine that only listens on itself and has no tailnet gives a loopback
address, which reaches it from the same computer and nowhere else. The group
card says so.

What two members say to each other is signed and sealed to the recipient,
whatever network carries it: the roster, agents' messages and the join
request are unreadable on the path, a plain LAN and the owner's app relay
included ([sealing](#sealing)). A member refuses a readable roster, and
refuses any readable request from a machine it trusts through the group alone.

What a client says to a core is not sealed. That link is as private as its
transport: WireGuard on a tailnet, TLS on an HTTPS address. A core that listens
on the local network (`listenOnLan`) serves its clients over `ws://` there, as
a pairing link already does, and a ticket or a session key sent on that link
is readable by that LAN.

Clocks of two members may differ by one minute; past that, signed requests and
tickets are refused for their date.

A phone whose page is served over HTTPS can only open secure sockets. It
connects to the members that give an HTTPS address and lists the others as
not reachable from a secure page. The Tailscale switch of Settings, or
`boite-core tailscale on` ([server](server.md)), serves a member on
`https://<machine>.<tailnet>.ts.net` and sets it as its public address; a
tailnet without HTTPS certificates needs a reverse proxy for that.

## How it works

Each core has an Ed25519 key, the one [agent coordination](coordination.md)
signs with, in `coordination-key.pem`. The core's id is the SHA-256 of its
public key, so it survives a change of name or address. Both key files are in
the data directory, readable by the account that runs the core only: whoever
copies them is that machine to the group.

**The roster.** Every member holds the whole roster: the machines (id, name,
public keys, addresses) and the devices paired with them. It is one settings
row in the journal. Members exchange it whole, sealed, through the endpoint
coordination already uses (`POST /agent-messages`, operation `group.sync`):
the receiver merges and answers with the result, which leaves both equal after
one round trip. A member offers its roster on every change, every 15 seconds
to members that have not agreed on it yet, and to all of them every five
minutes. A merge whose result would not be a valid roster is not kept. A roster is accepted only from a current member, never readable, and
never from a machine linked by hand for agent messages. An answer that arrives
after its sender was removed is dropped.

**Admissions and removals.** A machine is a member under an admission: the
signature of a machine that was already one, over the group, the admitted
machine and an epoch number. The machine that started the group is the only
one that admits itself, for its first epoch. A removal ends an epoch for good:
whatever revision anybody shows afterwards, that machine is out, and coming
back takes a new invitation, which a member signs as the next epoch. When two
rosters meet, a later epoch counts only if signed by a machine the receiver
held as a member before the exchange, or by one it accepts in that same
exchange. A removal counts whoever reports it: in doubt a machine is out.
Inside an epoch an entry carries a revision, for a machine republishing its
name and addresses, and the higher one wins. A revoked device is final too.
Removed entries are never dropped, since a missing one would let a stale copy
bring the entry back: a member admits no machine past 64 and no device past
400 listed over the group's life, removed ones included. Two members can admit
at the same moment before they have exchanged, so a roster received is read up
to twice those counts, and past that it is refused whole.

**Joining.** An invitation names the group, the inviting member's id, box key
and addresses, and a one-time grant. The joining core calls `POST /group/join`
on that member with its own public identity, signed with its key and sealed to
the member's box key with the grant as a pre-shared key. The grant itself is
never sent: the request names the invitation by a hash and only opens for the
machine that minted it. The member checks that the signature matches the
announced key, adds the machine and answers with the roster, signed and sealed
back. Thirty requests a minute that open are served, and the invitation must
still be live once the request has been read, before it is opened or counted. A request already served is
refused before anything is computed for it, however its JSON is written, so
one recorded on the path and sent again spends nothing of those thirty. The joining core accepts the answer only if the key that signed it has
the id the invitation named. A machine that merely sits at that address reads
nothing and cannot answer, and a request that names no known invitation costs
the member one lookup.

<a id="sealing"></a>**Sealing.** Beside its Ed25519 identity each machine holds an X25519 key
(`group-box-key.pem`) and lists the public half in the roster with its own
signature over it, so no other member can substitute a key. To send, a member
makes a one-time X25519 key, agrees on a secret with the recipient's listed
key and derives two AES-256-GCM keys with HKDF-SHA256, one for the request and
one for its answer; both machines' ids go into the derivation. The signed
message travels inside, signature included. It follows the pattern of HPKE's
base mode (RFC 9180) without being HPKE, and is written with the runtime's own
primitives (`group/seal.ts`). Who talks to whom, how much and when stays
readable on the path: the sender's id is a header. The recipient's key is long-lived: someone who records the
traffic and later steals that machine's key file reads what was sent to it.

**Strangers.** A request on these two routes is refused when it does not
prove who sent it, when its sender was removed or when that sender is over its
allowance, and each refusal costs a key agreement or a signature check. An
address has sixty places a minute: a request takes one as it arrives, gives it
back when it is answered well and keeps it for the rest of the minute when it
is refused. With no place left the address is answered nothing more, before
its body is read, so sixty requests held open together gain nothing. A
stranger on IPv6 is counted by its /64, which is all its to send from. The core
remembers 1024 strangers at once, and the ones past that share one such
allowance. An address a request was served to is a member's, and the request
proved which: that exact address keeps an allowance of its own, apart from the
strangers' table and from the rest of its /64, so neither a flood from many
addresses nor a neighbour turns the member away. A member keeps four such
addresses, and a new one takes the place of an older one of the same member,
never of another's. A member the core never served yet can be turned away with
the strangers while such a flood lasts. Requests from the machine itself are not
counted, since a reverse proxy puts every remote peer behind that one address. A member's own
allowance, 120 requests a minute, is only spent by requests that are its own,
fresh and not seen before.

**Tickets.** A client connected to a member asks it for a ticket to another
(`group.ticket`): the member's signed statement of who vouches, for whom, at
which role, for which machine, for one minute. The client says `hello` with
the ticket on the other member, which checks the signature against the roster,
that the ticket names it, its date and that it was never used, then issues a
session key of its own, exactly as it does for a pairing grant. A ticket also
names the one address it is good at, and the member refuses one made for an
address it does not give, or no longer: a ticket a client was led to send where
the member used to be opens nothing when carried to the member. The key the
ticket becomes lives while the member still gives that address. When it
publishes an HTTPS address, or its address changes, the keys issued for what it
gave up are revoked, so a key sent there afterwards is worth nothing. The use and
the session are one write in the journal, so a restart does not make a used
ticket good again. A ticket is refused one minute after its date, plus one
more for the difference between two clocks. From then on
the client holds one key per machine, as with pairing links, and the ticket is
spent. The desktop app of a member is vouched for as the machine itself and
gets the owner role; a paired client keeps the role of its pairing and is
listed in the roster as a device.

**What follows from the roster.**

- Browser origins: a page served by one member may open its socket on another.
  The list in [machines](machines.md#browser-and-phone-connections) is only
  needed outside a group.
- Agent coordination: every member is a trusted peer for messages, with the
  app closed, while it is a member. The app writes no standing agent link for
  a machine the group brought, or between two machines one of which lists the
  other, so a removed machine keeps none. A
  thread's own restrictions and pause still apply. Letting the agents of
  another machine read this machine's conversations stays the per-machine
  switch of Agent links, on a link made by hand: membership does not grant it.
- Pairing links: a member's link names its HTTPS address, else its tailnet
  address in numbers.
- Revocation: `sessions.revoke` on a device of the group writes its removal in
  the roster first, then drops the session, and every member drops the key it
  issued. A removed machine loses the keys the others issued to it and to the
  devices paired with it. A core checks at every start that no key outlived
  what it stood for.

The UI does the client's part by itself (`lib/group-links.svelte.ts`). Each
connected machine says which group it is in; for every member this client
holds no key for, it finds an address that answers, asks a connected member
for a ticket and connects. Who is in a group is read off the machines this
client was paired with by hand, the one it opened on included. A machine the
group brought vouches for nothing: it is dropped once one of those hand-paired
machines, in the same group, no longer lists it, whatever it and other
machines the group brought say. A machine paired by hand is never touched,
even when it sits at a member's address or another machine reports its name,
and a machine the group brought never takes the place of the window's own core
by reporting this computer's name. Opening a pairing link on a machine the
group brought makes it one paired by hand from then on. A key the group handed
out for an address the machine no longer gives, or no longer allows once it has
HTTPS, is dropped and the machine reached anew, the machine the window opened
on included: the window then goes to a machine paired by hand, or to the
shell's own core, never back to the address it dropped, and stays closed when
that address is all there is. When two hand-paired machines of a
group list different addresses for a member, a ticket goes only to an address
both allow, and to none until they agree. The question is asked again when an
address has answered and once more when the ticket is in hand, so a roster that
changes under an attempt stops it; the attempt starts over at once, once a
minute at most. A key that is dropped is taken out of both places it is saved
in, the list of machines and the core the window opens on next. These rules
spare a client a useless attempt. They are not what keeps a key safe: the
member is, by refusing a ticket for an address it gave up and by revoking the
keys issued for it ([tickets](#how-it-works)).

At start, a key the group brought for a plain HTTP address is not sent before
the machines paired by hand have been asked, each on a short connection of its
own, what their group lists (`GroupLinks.vet`). A key whose address no longer
stands is forgotten unsent, whether the window would open on that machine, a
`?core=` link names it or would fall back on it, or it is one of the others. They get three seconds: when none of that group
answers, the machine that vouched being off, the key is used as it was left.
Someone able to keep those machines silent still gets it sent to the old
address, where it is worth nothing once the member has given that address up.

## Limits

- A core belongs to one group at most, of up to 32 machines and 200 devices
  at a time.
- The client link is not sealed. On a tailnet or over HTTPS it is private. A
  machine that listens on the local network serves its clients in the clear
  there: a ticket, a session key and what follows are readable, and can be
  taken over, by someone on that network. Sealing it needs a secure channel
  inside the WebSocket, which a page served over plain HTTP cannot build.
- A member that has not heard a removal stays exposed to the removed machine,
  which may use it to act on the group. The only answer is to have every
  member on when a compromised machine is removed.
- The group gives keys, not reachability. A machine that is off, asleep or on
  a network the client cannot reach stays listed and unreachable. A client is
  never relayed through another member.
- A member that is off when a device is revoked, or a machine removed, keeps
  honouring it until it is back and has exchanged the roster.
- The settings switch copies from one window; members do not replicate
  settings between themselves.
- Push notifications stay per machine: enable them from each machine's own
  page ([phone](phone.md#notifications-while-closed)).
- Verified on loopback cores and in the in-memory client. Not exercised here:
  two physical machines over a real tailnet, the Windows firewall prompt, a
  phone on a tailnet.

## Tests

`packages/core/test/group.test.ts` runs real cores on loopback: admissions and
removals in the roster, address order, joining through either member, forged,
expired and replayed tickets, a phone reaching a second member as a device,
revocation from either side, removal heard at once and after an absence,
leaving, origins and agent coordination without a hand-made link, a capture of
every byte two members exchange to show none of it is readable, and one case
per finding of the security review: an invitation reused after a removal, a
ticket replayed after a restart, keys left by a crash, an answer landing after
its sender was removed, a rewritten status line, a join recorded and sent
again, requests held open from one address, the owner's app relaying between
two members that cannot reach each other. `packages/ui/src/lib/group-links.test.ts`
and `workspace.test.ts` hold the client rules: which addresses get a key, who
says who is in a group, and what is asked before a held key is sent. The shared contract scenario in
`tests/contract/scenarios.ts` holds the refusals on the core and on the
in-memory client. `tests/e2e/machines.test.ts` joins two real cores from the
page and writes desktop and phone captures.
