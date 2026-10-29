# Groups

A group is one person's machines and devices. Put a machine in a group and it
connects to every other machine of it, in both directions. A phone or a browser
added on any machine is a device of the group: one key of its own opens every
machine, with nothing to pair machine by machine. Agents on one machine find the
agents of the others.

Settings, Machines shows one group card: the machines, one row each with their
updates and settings folded under the row
([machines](machines.md#the-machines-page)), then the devices. One button adds
anything, **Add a device**. Opening Machines converts existing full-control
connections into one group automatically, reusing an existing group when there
is one. Offline machines join when they reconnect while the page is open.

A machine already in another group stays there and shows the group to leave
before moving it; each existing group keeps its own name and controls.
An existing offline group is reused when it returns, and creation waits for
unknown owners to answer. Failed migrations name the machine and can be retried.
Leaving or removing a migrated machine is remembered on this client, so opening
Settings again does not join it back automatically.

## Trust

**Every machine of a group has full control of the others.** A member may
invite a machine, remove one, admit or remove a device, and vouch for a client
at the owner role. Group only machines that are yours. A machine that is partly
trusted, a friend's or a shared server, should not be added to your group. A
device is admitted at the device role: it reads and drives conversations and
configures nothing ([phone](phone.md#what-a-paired-device-may-call)).

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

On any machine, in Settings, Machines, **Add a device**. A machine in no group
starts one named after itself first. The card shows a QR code and **Copy
link**:

- a phone scans the QR code from its Boite app, or pastes the link there when
  its camera cannot ([phone](phone.md#adding-a-phone));
- a computer pastes the copied link under **Join** in its own Settings,
  Machines: its core joins the group. A computer alone in a group of its own,
  the one its phone brought, joins all the same and brings that phone along.

The QR code and the link work once, for ten minutes. Whoever holds them gets
in: treat them as credentials. The QR code carries the phone's part
alone, so it stays sparse enough for a camera across a room; the copied link
carries the machine invitation after `#join=` as well.

Click or tap the group name to rename it. Enter or leaving the field saves;
Escape cancels. Updated members synchronize the name, including after a restart.

**Remove from the group**, on a device's row, takes that phone or browser out:
every member refuses it from then on. On a machine's row it takes that machine
out; that machine is told and leaves on its own, or learns it the next time it
reaches a member. **Leave the group** takes this machine out and tells the
others first.

The group card also picks the group's **Default machine**, whose settings
every other member follows. The choice lives in the roster, so every member
shows it; the copy itself runs from a window that owns both machines
([machines](machines.md#automatic-settings-synchronization)).

A machine with no window uses the core's command, on the data directory of
the running core:

```sh
boite-core group create Home
boite-core group invite          # prints a machine invitation, and nothing else, on stdout
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
four is reached. Each address is sent a request of its own, signed and sealed
for that attempt: the same request sent twice to a machine that has two
addresses would be refused there as a replay, and counted against its sender.
A request begun for a member leaves sealed or not at all, even when this
machine leaves the group between two attempts. What it sends is sealed to that machine's key, so an address that
leads elsewhere reads nothing and cannot answer. When none answers and the
owner's app is connected to both machines, the app relays the sealed request,
as it does for two machines linked by hand ([coordination](coordination.md)).

A client is sent to fewer of them, because its link is not sealed: to the
HTTPS address alone when the machine has one, and otherwise only to an address
written as numbers. A name over plain HTTP is whatever the client's resolver
says it is, so a client never sends a ticket or a key to one. A device sends no
secret at all, only a signature made for the machine it means, but what follows
its hello is not sealed either, so it keeps to the same addresses. A link that
adds a device follows the same rule.

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
first listener outside loopback raises the firewall prompt for the core, unless
the rule Boite asks for is already there ([phone](phone.md#windows-defender-firewall)).

A machine that only listens on itself and has no tailnet gives a loopback
address, which reaches it from the same computer and nowhere else. The group
card says so.

What two members say to each other is signed and sealed to the recipient,
whatever network carries it: the roster, agents' messages and the join
request are unreadable on the path, a plain LAN and the owner's app relay
included ([sealing](#sealing)). A member refuses a readable roster, and
refuses any readable request from a machine it trusts through the group alone.
A bot of one member looking after projects of another
([bots](bots.md#projects-of-the-other-machines-of-the-group)) uses these
same sealed requests: no key or token of either machine is copied to the
other, and the member holding the projects lets bots in only while its own
`groupBots` switch is on.

What a client says to a core is not sealed. That link is as private as its
transport: WireGuard on a tailnet, TLS on an HTTPS address. A core that listens
on the local network (`listenOnLan`) serves its clients over `ws://` there, as
a pairing link already does, and a ticket or a session key sent on that link
is readable by that LAN.

Clocks of two members may differ by one minute; past that, signed requests and
tickets are refused for their date.

A phone whose page is served over HTTPS can only open secure sockets. It
connects directly to the members that give an HTTPS address or are served at
one, and reaches the others through a member it reaches ([relay](#relay)). The Tailscale
switch of Settings, or `boite-core tailscale on` ([server](server.md)), serves
a member on `https://<machine>.<tailnet>.ts.net` and sets it as its public
address; a tailnet without HTTPS certificates needs a reverse proxy for that.

## Devices

A phone or a browser holds one Ed25519 key, made the first time it is added and
kept in its storage (`lib/device-key.ts`, `@noble/ed25519`, since a page served
over plain HTTP has no WebCrypto). Its id is the SHA-256 of the public key. The
desktop app is no device: it is its machine's own.

**Admission.** "Add a device" mints a one-time grant, drawn as a QR code and
carried by the copied link ([phone](phone.md#adding-a-phone)). The device says
`hello` with that grant and `device: { publicKey, name, sig }`, where `sig` signs the
grant itself with the key, so whoever reads the grant on the way cannot have
another key admitted with it. The member spends the grant, writes the device in
the roster under its own signature over the group, the device id and its role,
and the socket is the device's from then on. The same key asking again with the
same grant, after an answer lost on a weak link, gets the same answer; any other
is refused as for a used link. The link names the machine that drew it, so a
device always says `hello` with the grant to that machine, whichever page it
was opened from.

**Hello.** From then on the device says `hello` with `device: { id, at, nonce,
sig }` on any member, `sig` signing `boite-device-hello`, the id of that member,
`at` and `nonce`. The member checks that its roster lists the device, not
removed, admitted by a machine that is still a member; that the signature names
it; that `at` is within two minutes of its clock; and that it never saw the
nonce. Nothing the device sends opens another member or opens this one twice.
The member keeps a session row of its own for the device, made on its first
visit, whose token it throws away: it carries the device's last visit, its push
subscription and its sockets. The device's `group.get` lists its own entry only.

**Removal.** `group.revokeDevice`, on any member, writes the device's removal in
the roster. Every member, as it hears of it, drops the device's session and
closes its sockets; a member that is off does it when it is back. A removal is
final: the same key is never admitted again, and the app makes a new one when it
is added again. A device admitted by a machine that is then removed with **Remove
from the group** stays: the member that removes it signs those devices in again.
A machine that leaves on its own takes the devices it admitted with it.

**Devices paired before device keys.** A phone that holds a key of the older
kind, one per machine, keeps it. The next time it connects to an updated member
it sends its device key with `group.enrollDevice`, signed for that member; the
member admits the key and lists the session it called with as one the key took
over (`legacy`), so revoking the key revokes that session too, on every member
that issued one. The page then signs, and drops the old key. A machine in no
group starts one of its own for it. Nothing is asked of the user.

**Origins.** A member accepts the origin of a page served by any member: the
addresses each gives, and the origins each says its page is served at. A machine
learns where it is served from the socket a page opens: an origin it already
accepts of its own accord (its public address or an origin listed under
Advanced) whose host is the one the socket asked for, outside loopback. It
learns it before any hello, so the first page of a phone that holds no key yet
already opens the way, and publishes up to four in the roster (`origins`). A
machine behind a reverse proxy is thus accepted by the others without anything
set on them. Every core also accepts the phone app's own address
(`APP_ORIGIN`, [phone](phone.md#the-app-on-its-own-address)), a page no machine
serves. The origin check keeps arbitrary websites out; it grants nothing,
since every socket still needs a credential at `hello`.

## Relay

A member a client cannot reach itself is reached through a member it can.
That covers a desktop that gives only a plain-HTTP tailnet address, seen from
a phone whose page came over HTTPS, and a machine on a network the client is
not on but another member is.

The client tries the member's own addresses first, those it may send a key
to. When none is usable or none answers, it tries
`<member>/group/relay/<core id>/rpc` at once on every machine its own key opens
or it was paired with by hand that lists that member, and the first that answers carries it. Its `hello` names, in
`relay`, its credential for the relaying machine: a device's signature for that
machine, or the key that machine issued, beside its credential for the member at
the end. The relaying machine checks it (a device of its roster, a key it issued,
or its owner's token; never an agent's), takes it out, opens
a socket on the other member at one of its addresses and passes the rest of
the hello on. A client that holds no key for the relaying machine any more
sends nothing on that route: the hello would hand that machine its key for the
member. Once the hello is passed on, the relaying machine forwards every frame
both ways without acting on it, though it can read it (see below). The member
at the end authenticates the hello as it would any other. `/file/<ticket>` and `/view/<ticket>` under the
same route are fetched from that member and streamed back with their headers
and ranges, their tickets being what opens them. Nothing else of the other
member is carried.

The ticket for a member reached that way comes from the relaying machine,
which picks the address it names among the member's own: the member checks
that it still gives that address, not that the socket arrived on it. The key
the ticket becomes is the client's for that member, and lives as any key the
group issued.

The hop between the two members carries client traffic, so it follows the
client's rule: the member's HTTPS address when it has one, otherwise one
written as numbers. A member that gives neither, a MagicDNS name alone, is
carried by nobody and shown as giving no usable address. A direct ticket goes
to an address every machine the client was paired with by hand allows, so a
common one is enough. A carrier dials whichever of its own addresses for the
member answers, which the client does not choose: nobody carries the client
there until those machines list the same addresses (their order does not
count), since one of them may hold an older roster and dial an address the
member gave up. One of them that no longer lists the member stops every route
to it, as it stops a direct ticket.

On the socket, a refusal of the relay key (no key for the relaying machine, or
a wrong one) is answered `Refused`, and a member it cannot reach `Unavailable`:
never `Unauthorized`, which the client would take for its key on the member
being revoked. A first frame that is not a hello is answered `Unauthorized`, as
on a direct socket. A file or a view answers 404 for a machine that is not another member
and 502 when that member does not answer. A relayed socket is deflated when
the client asked for a host that is not loopback, and is held to a direct
socket's outgoing budget: 32 MiB unread, a dropped send or 10 seconds without
a drain closes it with 1013, and the client reconnects and loads a fresh
snapshot. Until its key is checked, a relayed
socket counts against the same bounds as a direct one: five seconds and 64 KB
for its hello, and the places for sockets waiting on one. Revoking the key it
came in with closes it, and its sockets to a machine that leaves the group are
closed within fifteen seconds.

While a member is reached through another, the client tries its own addresses
a minute after the last try, longer after each that fails, and moves to the first that answers, so a phone back on the
tailnet, or a desktop given an HTTPS address, stops depending on the relaying
machine. Settings, Machines names the machine a member is reached through.

**What the relaying machine sees.** Everything the client and the member say
to each other, the client's key for that member included. Every member of a
group already has full control of the others ([trust](#trust)), so this gives
it nothing it did not have. The client link is not sealed on that hop either:
as private as the network between the two machines.

### Contact projects on a member

An explicitly shared Contact project can live on another member. The linked
gateway forwards `contact.project` through existing sealed `relay.in/out`
requests, checking the member's current admission and that contact's exact
member/project grant again before returning the answer. Saved member mirrors
bind the group and both admission epochs; removing and readmitting a core does
not restore an old copy's authority. The association and jobs stay on the
executing member, with no copy on the gateway. This bounded peer protocol is
separate from the owner's general group RPC relay. See
[Contacts](contacts.md#implemented-association-service).

### Notifications through the group

A phone installs one machine's page and subscribes to Web Push there, with
that machine's key. That machine writes itself in the roster as the device's
push home (`push`). A member whose thread needs the user, or finished, also
sends the news to the push home of every device of the group that has no
subscription of its own there. (A key of the older kind, issued through a ticket,
has the member it was paired with for its home and cannot subscribe elsewhere,
the refusal naming its home.) That machine pushes it to the
device with its own key, once per device, as a sealed `group.push` request
between members. The request carries an id the home remembers for two
minutes: tried on two addresses that both reach it, it pushes once. Title,
body and tag are cut to 300, 2,000 and 200 characters on the way. The push
carries the id of the machine the thread is on: the notification's tag is that
machine's, and a tap opens the thread there once the group has connected it.
The receiving machine pushes only to a device the roster lists as its own, and
the badge adds the threads waiting on it to those waiting on the machine that
sent the push. A machine holds a push back while the device watches the thread
through any route, the relay included, as it does for its own.

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
minutes. A member that does not answer waits longer after each failed offer,
from 30 seconds doubling up to five minutes; a different roster still goes to
it at once, and any signed request from it ends the wait. A merge whose result would not be a valid roster is not kept. A roster is accepted only from a current member, never readable, and
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
still be live once the request has been read, before it is opened or counted. A request already received is
refused before anything is computed for it, however its JSON is written, so
one recorded on the path and sent again spends nothing of those thirty, in
that minute or a later one. An invitation asked with more than 64 different
requests is taken away. Neither
does the invitation of a machine that was since removed: it is spent, and
refused before it is read. A request is counted only once it has proved who
sent it, and an invitation already used is good for the machine it admitted
alone, asking again after a lost answer: anybody else holding it is refused
uncounted. The joining core accepts the answer only if the key that signed it has
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
fresh and not seen before, one turned away for that allowance included: by
name up to three times the allowance a minute, and past that by date, nothing
as old as what was turned away being taken again. A request is dated against
the clock once its body is in.

**Tickets.** A device of the group needs none: its key opens every member. A
ticket is what the desktop app of a member, and a client paired the older way
until it sends its device key, use to reach the others. A client connected to a
member asks it for a ticket to another
(`group.ticket`): the member's signed statement of who vouches, for whom, at
which role, for which machine, for one minute. The client says `hello` with
the ticket on the other member, which checks the signature against the roster,
that the ticket names it, its date and that it was never used, then issues a
session key of its own, exactly as it does for a pairing grant. A ticket also
names the one address it is good at, one of the addresses the member gives or
an origin it is served at, and the member refuses one made for an address it
does not give, or no longer: a ticket a client was led to send where
the member used to be opens nothing when carried to the member. The key the
ticket becomes lives while the member still gives that address. When it
publishes an HTTPS address, or its address changes, the keys issued for what it
gave up are revoked, so a key sent there afterwards is worth nothing. Both
checks read what the machine gives at that moment, off its interfaces and its
settings, at every `hello`: the roster holds what it last published, which is
behind for a few seconds after a move. At a start, until the server listens,
there is nothing to read and what was last published stands. The use and
the session are one write in the journal, so a restart does not make a used
ticket good again. A ticket is refused one minute after its date, plus one
more for the difference between two clocks. From then on
the client holds one key per machine, as with pairing links, and the ticket is
spent. The desktop app of a member is vouched for as the machine itself and
gets the owner role; a paired client keeps the role of its pairing and is
listed in the roster as a device.

**What follows from the roster.**

- Browser origins: a page served by one member may open its socket on another,
  at any address that member gives or origin it is served at
  ([devices](#devices)). The list under Advanced is only needed for a page
  served outside the group.
- Agent coordination: every member is a trusted peer for messages, with the
  app closed, while it is a member. The app writes no standing agent link for
  a machine the group brought, or between two machines one of which lists the
  other, so a removed machine keeps none. A
  thread's own restrictions and pause still apply. Letting the agents of
  another machine read this machine's conversations stays the per-machine
  switch of Agent links, on a link made by hand: membership does not grant it.
- Links to add a device: a member's link names its HTTPS address, else its
  tailnet address in numbers.
- Revocation: `group.revokeDevice`, or `sessions.revoke` on a device's session,
  writes its removal in the roster first, then drops the session, and every
  member drops its own session for that device and any key it issued for it. A
  removed machine loses the keys the others issued to it. A core checks at every
  start that no key outlived what it stood for.

The UI does the client's part by itself (`lib/group-links.svelte.ts`). Each
connected machine says which group it is in; for every member this client
holds no key for, it finds an address that answers and connects. A member that
does not answer is tried again a minute later, then after 2, 4, 8 and at most
15 minutes. The wait goes back to a minute when the roster gives the member
other addresses, and the next try comes at once when the network comes back or
the hidden page is shown; nothing is tried by the clock while the page is
hidden. A device signs
its own way in there and is done: what a member lists is all it needs, and a
machine its key opens that another one of the group no longer lists leaves its
list. A machine out of every group says so, to `group.get` or on the hello it
refuses the key with (`reason: 'ungrouped'`, `UngroupedData`). That refusal is
signed with the machine's key over the nonce of the hello it answers, and the
page checks that the key's SHA-256 is the machine it signed the hello for:
unsigned, signed by another machine now at that address, or over an older
hello, it is heard as "come back". A machine joining a group says "come back"
too, since the group it joins may know the device. The machine leaves on its
word once no machine the key opens lists it; so does one that refuses the
key. That word is of itself only, and a machine that says nothing, off or not
answered yet, says nothing of anybody. Beyond it the page checks no signature:
a removal is a member's word that nobody signs, and the admissions members
sign and check are left out of the group's view. What it cannot tell apart
stays as it was:

| the machine | the other machines the key opens | it |
| --- | --- | --- |
| removed while the page reloaded, refuses the hello: no group | none lists it | leaves |
| same | one not caught up lists it | stays until that one hears |
| refuses the key | none lists it | leaves |
| says nothing or "come back": off, behind, moved, joining | any | stays |
| another machine at its address, or an older answer, says no group | any | stays |
| answers its group | one of that group omits it | leaves |
| answers its group | only a machine paired with a token, or brought by the group, omits it | stays |

A roster that omits a machine drops it whoever holds that roster: a removed
machine that still answers can drop the one that removed it, and one not
caught up drops a machine let in since, until it hears. Rosters the page can
check would end that.

Its page's own machine, waiting for the device to be added, is taken over
the same way. The rest of this section is about clients that use tickets, the
desktop app and a client paired the older way: they ask a connected member
for a ticket and connect. Who is in a group is read off the machines this
client was paired with by hand, the one it opened on included. A machine the
group brought vouches for nothing: it is dropped once one of those hand-paired
machines, in the same group, no longer lists it, whatever it and other
machines the group brought say. A machine paired by hand is never touched,
even when it sits at a member's address or another machine reports its name,
and a machine the group brought never takes the place of the window's own core
by reporting this computer's name. Opening a pairing link on a machine the
group brought makes it one paired by hand from then on, and since a machine
the group removed can make such a link itself, a link in the address bar that
brings a key of its own for that machine, a grant or a token, asks first. A
client takes a new key only from a core it showed a grant or a ticket to. A
machine the group drops leaves the window, and its saved entry goes only while
it is still the one the group brought: paired by hand since, in another
window, the entry stays. The group's mark is kept wherever a key of that
machine is saved, the core the window opens on next included, and a link that
reopens the machine keeps it. A machine the group dropped is remembered, by
its address and by what it is, in storage every window shares
(`boite.group.dropped`), with which admission of it that was
(`GroupCore.epoch`): a window that holds it under another address lets it go
too. Addresses make room for newer ones, 256 of them; a machine dropped is
never forgotten to make room, and the highest admission recorded as dropped is
kept. Windows share that record without a lock, so two that write at the same
instant can erase or lower what the other recorded: a window that hears the
record change puts back what it knew of the machines dropped. A window closed
at that instant cannot, and an address erased that way stays erased, since a
pairing made by hand clears it too. The other way round, a write that started
from an older record can put back the mark of an address a pairing made by
hand had just cleared: that pairing is then not read, and the machine has to
be paired again. Nothing saved for that
address is read again, whichever window left it and wherever it sits, so a key
left behind never passes for a pairing made by hand, and a link to that address
asks as for a core nobody knows. No ticket is asked for it on the word of a
member that still lists the admission that was dropped. It ends when a new key
is issued for the address: a pairing made by hand, a link the owner said yes
to, or the machine admitted again, which a member lists under a later
admission. A window that is open lets the machine go as soon as another window
marks its address, whoever answers in that window, and a ticket exchange that
began before the mark and ends after it is refused its key and closed. Only a
machine the group dropped is marked, and only when something saved says the
group brought it: one that moved to another address is not, nor an address a
member gave that was tried and given up. A key the group handed
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
`?core=` link names it or would fall back on it, or it is one of the others. A
machine that opens no socket within three seconds is taken for off. One whose
socket opened is on, and its answer is waited for up to fifteen seconds from
the question: a machine that starts slowly still has its say, and giving up on
it sooner would send the key to an address it may no longer give. When none of
that group answers in that time, the machine that vouched being off or silent,
the key is used as it was left.
Someone able to keep those machines silent still gets it sent to the old
address, where it is worth nothing once the member has given that address up.

## Limits

- A core belongs to one group at most, of up to 32 machines and 200 devices
  at a time.
- The client link is not sealed. On a tailnet or over HTTPS it is private. A
  machine that listens on the local network serves its clients in the clear
  there: a ticket, a session key and what follows are readable, and can be
  taken over, by someone on that network. A device's signed hello is good for
  that machine once, but the socket it opens can be taken over the same way. Sealing it needs a secure channel
  inside the WebSocket, which a page served over plain HTTP cannot build.
- A core remembers the requests it has seen in memory. For a minute after it
  restarts, a request recorded on a plain HTTP path before the restart can be
  sent to it again. Nothing is done twice by it, a letter is delivered once
  and a roster merged again is the same roster, but it counts against the
  allowance of the member that signed it. Device hello nonces are kept in
  memory too: for two minutes after a restart, a device hello recorded on a
  plain HTTP path can open a socket again.
- A window trusts the machine that serves its page. A machine removed from
  the group that still serves the page a client opens decides what that page
  does, with every key saved under its address.
- A page served by a machine comes from that machine; the app's own address
  ([phone](phone.md#the-app-on-its-own-address)) is no machine's. With the
  page's machine off, an installed app opens from the copy its service worker kept, which needs an
  HTTPS address ([phone](phone.md#https-and-installation)); a page opened over
  plain HTTP does not load at all, and another member's address is another
  origin, which holds none of this device's storage, its key included.
- A page served by a machine outside the device's group reaches nothing of that
  group: its origin is none of theirs. The Android app that opened one fixed
  machine's page was this case for anybody else's phone.
- A scanned or pasted link reaches the machine that drew it, which it names.
  A page served by a machine outside the group still holds none of the group's
  keys, its origin being none of theirs: open the app's own address, or the
  drawing machine's, and scan there.
- A machine that runs a version from before device keys drops them from the
  roster it keeps and lets no device key in. Update every member.
- A member that has not heard a removal stays exposed to the removed machine,
  which may use it to act on the group. The only answer is to have every
  member on when a compromised machine is removed.
- The group gives keys, and a route through a member, not reachability. A
  machine that is off or asleep stays listed and unreachable. One that neither
  the client nor any machine it reaches can reach stays so too.
- A member reached through another goes with it: that machine off, it is
  unreachable until its own address answers. An agent's browser surface,
  opened on a port of the member, is not carried.
- A member that is off when a device is revoked, or a machine removed, keeps
  honouring it until it is back and has exchanged the roster.
- The settings switch copies from one window; members do not replicate
  settings between themselves.
- Notifications of another member reach a device through the machine it
  installed only once that device has connected to the member. A member that
  runs a version without `group.push` sends none.
- Verified on loopback cores and in the in-memory client, the relay and the
  addition of a phone from an HTTPS page in Chrome behind two reverse proxies.
  Not exercised here: two physical machines over a real tailnet, the Windows
  firewall prompt, a physical phone, a push delivered by a real push service
  through another member.

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
says who is in a group, and what is asked before a held key is sent, and when
a member is carried by another and moved back to its own address.
`packages/core/test/group-relay.test.ts` runs two real cores: a phone carried
from one to the other with a ticket, then with the key it got; refusals by the
relaying machine for a missing, wrong, agent or revoked key; a member outside
the group or one that does not answer; a file with its range and a view with
its headers; a socket closed when its member leaves; a notification forwarded
to the device's home machine, refused for a device that is not its own. The shared contract scenario in
`tests/contract/scenarios.ts` holds the refusals on the core and on the
in-memory client. `tests/e2e/machines.test.ts` joins two real cores from the
page, reloads a paired phone while its own machine answers nothing, and writes
desktop and phone captures. `tests/e2e/group-relay.test.ts` serves the page
over HTTPS to a phone-sized Chrome paired with one core, and shows it reaching
a second core that gives only a plain-HTTP address: through the first, chatting
there, named in Settings, and again after a reload with the key it kept.

`packages/core/test/group-devices.test.ts` runs real cores for device keys: a
phone added on one member says hello on another with its signature and none
made for a third machine, twice, or two minutes off; one revocation shuts it out
of both; a phone retrying its grant after a lost answer; a phone paired the older
way handing over its key, kept when the machine that admitted it is removed; a
machine alone with its phone joining a group and bringing it; a member learning
where another is served from the first page socket, before any hello.
`tests/e2e/group-devices.test.ts` puts two real cores behind two HTTPS reverse
proxies, installs the phone app from the first one's address at phone width,
scans the QR code the second one drew through Chromium's fake camera, lists and
answers conversations on both with no origin set by hand, then removes the phone
on one machine and shows every machine refusing it.
