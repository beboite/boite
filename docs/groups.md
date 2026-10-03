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

A removal takes effect on each member when it hears of it. A machine removed
while another member was off is still listened to by that member until it
comes back and learns the removal. Remove a machine you believe is
compromised while the others are on, or have every member leave and start a
new group.

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
boite-core group join <invitation>
boite-core group status
boite-core group leave
```

`--data-dir` and `--channel` name another core, as they do at start.

## The network

Tailscale is the expected network. A machine in a group answers on its tailnet
address, and gives the other members these addresses, best first:

1. its public HTTPS address, when `publicUrl` is set ([phone](phone.md));
2. its MagicDNS name, `http://<name>:<port>`;
3. its tailnet address, `http://100.x.y.z:<port>`;
4. its LAN address, when the core listens on the network (`listenOnLan`).

A member dialing another tries all of them at once and keeps the first that
answers with a valid signature, so a machine reachable by any of the four is
reached. When none answers and the owner's app is connected to both machines,
the app relays the signed request, as it does for two machines linked by hand
([coordination](coordination.md)).

The core reads its tailnet address off its network interfaces (the range
100.64.0.0/10) and its MagicDNS name from the PTR record Tailscale's resolver
at 100.100.100.100 answers. It runs no Tailscale command. A machine with no
tailnet gives its LAN address, and two machines on one LAN group the same way
once both listen on the network.

Joining or creating a group makes the core listen on the tailnet address too,
on the same port, beside the address it was started on. It stops when the
machine leaves. Nothing else is opened: a core that listens on itself stays
closed to the LAN. `--host` or `--lan` on the command line names the only
address a core answers on, and such a core opens no other. On Windows the
first listener outside loopback raises the firewall prompt for the core.

A machine that only listens on itself and has no tailnet gives a loopback
address, which reaches it from the same computer and nowhere else. The group
card says so.

Boite encrypts nothing between members. Requests are signed, so a member
knows who it talks to, and privacy comes from the network: WireGuard on a
tailnet, TLS on an HTTPS address. On a plain LAN the traffic is readable by
that LAN, as a `ws://` pairing already is. Clocks of two members may differ
by one minute; past that, signed requests and tickets are refused for their
date.

A phone whose page is served over HTTPS can only open secure sockets. It
connects to the members that give an HTTPS address and lists the others as
not reachable from a secure page. The Tailscale switch of Settings, or
`boite-core tailscale on` ([server](server.md)), serves a member on
`https://<machine>.<tailnet>.ts.net` and sets it as its public address; a
tailnet without HTTPS certificates needs a reverse proxy for that.

## How it works

Each core has an Ed25519 key, the one [agent coordination](coordination.md)
signs with, in `coordination-key.pem`. The core's id is the SHA-256 of its
public key, so it survives a change of name or address.

**The roster.** Every member holds the whole roster: the machines (id, name,
public key, addresses) and the devices paired with them. It is one settings
row in the journal. An entry carries a revision; when two rosters meet, the
higher revision wins, a removal wins at the same revision, and a removed entry
stays as a tombstone so a member that was off cannot bring it back. Members
exchange the roster whole through the signed endpoint coordination already
uses (`POST /agent-messages`, operation `group.sync`): the receiver merges and
answers with the result, which leaves both equal after one round trip. A
member offers its roster on every change, every 15 seconds to members that
have not agreed on it yet, and to all of them every five minutes. A roster is
accepted only from a current member, never from a machine linked by hand for
agent messages.

**Joining.** An invitation names the group, the inviting member's id and
addresses, and a one-time grant. The joining core calls `POST /group/join` on
that member with the grant and its own public identity, signed with its key.
The member checks the grant, checks that the signature matches the announced
key, adds the machine and answers with the roster, signed. The joining core
accepts the answer only if the key that signed it has the id the invitation
named, so a machine that merely sits at that address cannot answer for it.

**Tickets.** A client connected to a member asks it for a ticket to another
(`group.ticket`): the member's signed statement of who vouches, for whom, at
which role, for which machine, for one minute. The client says `hello` with
the ticket on the other member, which checks the signature against the roster,
that the ticket names it, its date and that it was never used, then issues a
session key of its own, exactly as it does for a pairing grant. From then on
the client holds one key per machine, as with pairing links, and the ticket is
spent. The desktop app of a member is vouched for as the machine itself and
gets the owner role; a paired client keeps the role of its pairing and is
listed in the roster as a device.

**What follows from the roster.**

- Browser origins: a page served by one member may open its socket on another.
  The list in [machines](machines.md#browser-and-phone-connections) is only
  needed outside a group.
- Agent coordination: every member is a trusted peer for messages, with the
  app closed. A thread's own restrictions and pause still apply. Letting the
  agents of another machine read this machine's conversations stays the
  per-machine switch of Agent links: membership does not grant it.
- Pairing links: a member's link names the address the group gives for it, its
  tailnet name when it has one.
- Revocation: `sessions.revoke` on a device of the group marks it removed in
  the roster, and every member drops the key it issued. A removed machine
  loses the keys the others issued to it and to the devices paired with it.

The UI does the client's part by itself (`lib/group-links.svelte.ts`). Each
connected machine says which group it is in; for every member this client
holds no key for, it finds an address that answers, asks a connected member
for a ticket and connects. A member the group no longer lists is dropped from
the list, unless it was paired by hand.

## Limits

- A core belongs to one group at most, of up to 32 machines and 200 devices.
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

`packages/core/test/group.test.ts` runs real cores on loopback: roster merges,
address order, joining through either member, forged, expired and replayed
tickets, a phone reaching a second member as a device, revocation from either
side, removal heard at once and after an absence, leaving, and origins and
agent coordination without a hand-made link. The shared contract scenario in
`tests/contract/scenarios.ts` holds the refusals on the core and on the
in-memory client. `tests/e2e/machines.test.ts` joins two real cores from the
page and writes desktop and phone captures.
