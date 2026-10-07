# Machines and thread views

Boite connects to several cores at once. Each machine owns its projects, files,
accounts and execution. Opening a thread selects its machine for the chat,
composer and settings. It does not move the thread or its processes.

## Connecting a machine

Machines connect through a [group](groups.md): one invitation per machine,
and each connects to every other, phones included. Existing full-control
connections are merged into one group when opening Machines and updates.
The group card contains each machine's settings, connection status and display
preferences. Click its name to rename the group.

On the first machine, create a group. Invite each additional machine and paste
the invitation on that machine under Join a group. A phone pairs with any
member and reaches the others with the same role. Pairing links and the CLI
remain available for connecting a device or repairing a remembered key.

The client saves the exchanged session key and discards the grant
([pairing](phone.md#pairing)). Startup restores the selected connection and
connects remembered machines. A fresh local core without threads yields to a
remembered core on the same computer that already has them.

Machine names and icons can be changed in Settings. These preferences are saved on this client and follow the core across address changes. Connections to the same host, data directory and channel appear once.

The shell discovers its local core on startup instead of remembering its temporary
port as another machine. Older generated `This computer` loopback entries are
removed during startup. Paired remote connections are retained. The sidebar
counter and project picker use the workspace's connected machine list.

The machine list shows connection errors and lets you reopen a host or remove
it. Remove machine asks first, then closes that host's socket and forgets its
saved address and key, so connecting it again needs a new pairing link. It does
not stop agents, remove files or revoke the key on the remote host. Use the remote
core's paired-device list to revoke it. The primary core stays attached.

If a machine goes offline, its known rows remain visible and its machine badge
shows the disconnected state. Other hosts remain usable. WebSocket reconnection
reloads the host's project and thread summaries. An initial connection whose
handshake does not finish within twelve seconds can be retried from Machines.
Once the machine has said hello, loading its lists is waited for however long
it takes on a slow link; the connection is never dropped for it.

The client detects silent remote sockets (`packages/ui/src/lib/client.ts`).
On a remote host, 25 seconds without any
frame while no call waits for its answer sends a `hello`, which the core
answers on an open connection with its info and nothing else. If no frame of
any kind arrives within 15 seconds, the socket is replaced and the calls it
carried fail with "connection lost; check the conversation before resending".
While a call waits, silence may be its answer still downloading, one frame of
up to 16 MB behind which the probe's answer would queue, so only that call's
own 120 second timeout starts the check, on any host. Returning to the page, an `online` event or
a page restored from the back/forward cache also send the `hello` first, and
replace the socket only if it stays silent for 4 seconds, so a tab switch no
longer drops a healthy connection or reloads the lists. An `offline` event asks
a remote socket the same way and drops it after 4 silent seconds without
reconnecting, so the header stops saying Connected while the network is gone.
A hidden page is not checked.

A prompt whose socket went while it was being sent is not reported as an
error at once. The failure carries `data.transport: 'dropped'`, the store waits
up to 15 seconds for the connection to come back, then sends `turns.start`
once more with the same `clientRequestId`. The core answers with the turn it
already took, or starts it if the first request never arrived, and the
composer clears as for any sent prompt. A refused retry shows the error and
keeps the text. A connection that does not come back in time moves the prompt
into the thread's outbox (below) under that same `clientRequestId`, so the core
can still take it only once.

Retries wait 1, 2, 4, 8, then 10 seconds, each 20 % longer or shorter at random
so the clients of a restarted core do not all return at once. An attempt gets
10 seconds to open and say hello, the next one 20, then 30, so a slow, lossy
link is not cut off every time. While the browser reports itself offline, a
remote host is not retried at all: the `online` event starts the next attempt.
A loopback core is retried regardless, since it is on the same machine.

A remote machine that cannot be reached is not a fault in itself: a laptop
switched off between uses shows a grey "Offline" dot in the footer's machine
menu and the button keeps its normal icon. The button turns into a warning, and
the dot red, only when the user must act or depends on the missing machine: a
machine that refused this device's key, the machine the window runs on, this
PC's own core, or a machine whose last known threads still had a turn queued,
running or waiting when the connection went.

A key a remote core refuses is not retried: the machine shows as closed with
the reason. A page opened on its own core with no key says the device holds
none. Click the affected machine's **Pair again** control and paste a new
pairing link from that machine. This replaces the key of a listed machine that
is not connected, the page's own included, which cannot be removed. Device-only
clients can also paste the link under **Add a machine**. Only a connected
machine is refused as already connected.

The link decides which machine is reached; the name only labels it. Once a
link is pasted the form names the host it reaches and the listed machine at
that address, if any. A name already used by another machine gets the
newcomer's host beside it, as in `Studio (build.example)`, when pairing and
when renaming.

## The machines page

Settings, Machines and updates shows each machine on one row: its icon, its
name, whether it is connected and one word about its updates. The row's chevron
opens its details: its address, Boite's version on that machine with its
update, its agents with theirs and the automatic update switch, Settings for
this machine and Remove machine. A machine alone on its list shows its details
without a click. Before this, a machine appeared twice, once as an updates
card listing every agent version and once as a connection.

One Check for updates button at the top reads everything again: the desktop
app, Boite on every machine connected with full control, and the agents there.
The row's word is the most pressing of what it finds: a failed update, then
one in progress, then one available, then a check in progress, then Up to
date. A row says nothing until something has answered.

Phones and other devices has one button, Add a phone, which draws the QR code.
Reachable on the local network and Full control sit under More options. Phone
app keeps the Tailscale HTTPS switch in view and folds the address of a
reverse proxy of one's own under Use another HTTPS address.

## Agent links

Group members establish agent trust and browser origins through the shared
roster. Their agents can find, read and message each other
([coordination](coordination.md)) once both cores are reachable. Removing a
machine from the group removes that trust when the other members hear it.
Paired-device connections do not grant agent trust.

Older manually configured agent links remain supported by the core and CLI.
The Machines page manages group membership instead of offering a second list
of pairwise links.

## Automatic settings synchronization

The group card has one checkbox to keep its machines
synchronized with the named source. Checking it copies settings
immediately, then copies changes while this client is open, including when
Settings is closed. The source stays the one chosen when checking the box;
switching the visible machine does not reverse the direction. Cyclic links are
refused.

The preference is saved on this client using each core's host, data directory
and channel. Both machines need full control and a live connection. A reconnect
or a client reload copies the latest values again. Unchecking stops future
copies, including a pending copy that has not started writing. The remote core
persists what it receives and keeps executing independently when the source or
this client is offline.

The client copies:

- deleted-history retention, process guards and question mode;
- keybindings where the two differ, including unbound commands and restored
  defaults. A failed or canceled copy attempts to restore entries already changed;
- the brain's Use with agents, instructions, guide and automatic pull switches
  when both machines have a brain folder. The target keeps its own folder.

Resource limits, memory protection, process retention, automatic agent updates,
worktree storage, network access, public URLs, browser origins and provider
sign-ins stay on their own machine. Each owner machine card has a Settings for
this machine button beside its synchronization control. It opens resource and
execution settings for that core without changing the active conversation.
Agent update checks, versions and the automatic update switch sit under that
machine's details ([the machines page](#the-machines-page)).
Checking synchronization leaves the machine list open. The button is available
on desktop and phone; offline machines cannot be edited. The report names
providers that still need signing in on the target
and opens that machine's Providers page. Methods absent on an older core are
skipped for that part. Automatic brain changes require the source core's
`brain.configured` event. A failure names its stage; earlier changes stay copied,
and the next source change or reconnect tries again.

## Remote terminals

The [thread terminal](terminal.md) runs on the conversation's owning machine
and working directory. Its owner-only access, output reattachment and focus
behavior are documented there.

## Browser and phone connections

The desktop shell is an allowed origin on every core. A browser or phone has
the origin of the core serving its page. On each additional machine, add that
exact origin to Machines, Allowed browser origins. Origins contain a scheme,
host and optional port, with no wildcard. A pasted address keeps only its
origin: the core drops a trailing `/` or a path, since the browser's `Origin`
header never carries one, and a line given twice is kept once. Save the list on
that core.
Removing an origin blocks new connections from it; existing authenticated
connections must be revoked separately if they should lose access immediately.

The machines of a [group](groups.md) allow each other's addresses as origins,
so this list is only needed outside one.

The origin permission does not replace authentication. Every socket still needs
its own valid token or one-time grant. HTTPS pages need secure WebSocket
endpoints. [Phone setup](phone.md#https-and-installation)
owns HTTPS/pairing setup; [server deployment](server.md) owns host reachability.

## Two views

The sidebar's Display options menu (the sliders icon) chooses between Projects
and Recent, above its grouping switches. Projects is the default. Projects
appear by recent user activity, using the latest accepted user message among
their visible threads, or creation time when no message exists. Assistant
output and title changes leave that order alone. The order button under the
switch toggles to Custom order; then drag project headers to rearrange them,
with the mouse or, on a phone, after holding a header still for a moment; a
line shows where the project lands and Escape cancels. Their menus also offer Move project up and Move
project down, including on a phone. Switching back to recent activity keeps
the saved custom arrangement. The view and custom order belong to this device.

Recent flattens the list. Its All projects picker can limit conversations and
drafts to one project on one machine. The new-conversation button and Ctrl+N
then create a draft in that project. An archived or removed selection falls
back to All projects. Inside projects and in Recent, pinned threads come
first, followed by threads needing attention and then recent user messages.

All machines can be narrowed to one machine from the filter button beside
Settings at the bottom of the sidebar. The search icon opens the command
palette, also available with Ctrl+K, without a permanent search field.
It matches thread titles, project names and machine names across connected
hosts. The draft's project picker also includes every connected host.

With several machines connected, Recent cards show the machine icon beside the
title. In Projects the project header carries it once for its cards, in red
while that machine is unreachable. The machine name remains in the tooltip and
accessible label. Every card shows
the provider's logo before the title; its tooltip names the provider and the
model. A second row appears only for the project or an associated PR, shown as
a green underlined number. A card that has that row also names the thread's
worktree branch there; a branch alone does not add the row. The phone list
always has a second line and appends the branch to it. Connecting another machine leaves cards without project or PR metadata
at their single-machine height. No placeholder appears when there is no PR. PR
metadata comes from the execution machine's `gh pr list`, using the branch
associated with the thread. A shared checkout's current branch alone does not
identify a thread's PR. Non-repositories and detached checkouts have no PR.
Lookups share the common Git directory across worktrees: `git remote -v` is
cached for five minutes and the newest 200 PRs for one minute, errors included.
A missing branch gets its own lookup only when that list was full. At most two
commands run at once, each with a ten-second deadline through `procs` as
`pull-request:<threadId>`. Folded projects defer lookups until opened.

When a machine drops, its cards stay listed, greyed, and still open. The client
asks nothing of the core then: it shows the timeline it last read for that
thread, or an empty one for a thread it never opened. Sending in such a thread
puts the prompt in the thread's outbox, and the composer says the machine is
offline. When the machine is back, the reconnect reopens the thread, reads its
team, workflows and coordination, then sends the outbox.

The outbox is the thread's queue with a request on each entry
(`OutboxRequest` in `store/composer.svelte.ts`): a `clientRequestId` drawn when
the prompt is written, and the model, effort and speed it was written with.
The drafts journal keeps it per machine with the unsent text, in IndexedDB
and its localStorage backup, attachments included, so it survives closing the
app. Each entry is its own turn and goes through the composer's own send path,
in order, never steered into a running turn. The core answers a
`clientRequestId` it already took with that turn, so an entry whose answer was
lost is not sent twice. A refusal from the core marks the entry as failed with
its reason and holds the entries written after it; Send again retries it under
the same id, and the cross removes it. A tap takes it back into the box, and
sending it from there draws a new id. A thread that moved to another model
meanwhile is put back on the written one first; a choice for another agent or
account is ignored. A new thread needs the core, so a
draft keeps its text until the machine returns. A machine offline since the app
started has no cards to open: the client keeps no copy of the thread list.

A lookup the user did not ask for fails quietly, and once `gh` is missing or
signed out the core stops starting it. The thread menu's refresh reads the
repository again, tries `gh` again, and shows a missing `gh`, an
authentication failure or a malformed response in the error notification. A
PR link opens in the system browser.

Older cores that do not implement PR lookup are probed once per connection.
Their cards omit the PR link. A manual refresh explains that the hosting
machine needs an update; other RPC errors still appear in a notification.
Reconnecting clears the capability check so an updated core is detected.

## Merged PR conversations

Git projects default to Archive merged PR conversations. An owner can change
this per project in its menu under Manage project, from desktop or phone.
Older cores without the setting omit the toggle. The change is sent through
that project's owning Store, even when another machine has the same project ID.

Automatic archive hides an eligible idle worktree conversation after its exact
branch tip is proved merged. The proof reads the checkout's current branch, so
an agent may leave the starting branch for one named after its fix. A PR linked
with `boite pr link` counts too, even when the agent pushed under another branch
name, as long as its head commit is the checkout's tip. It preserves the worktree, branch, commits, files,
history and provider session. Archived conversations show the PR reason/link
and archive time; Restore makes them visible and protects that restored checkout
from automatic archiving again.

The core leaves viewed, pinned, unread, busy or dirty conversations visible.
Drafts, shared checkouts, child/resident-agent conversations, ambiguous/fork PRs,
pending cards/input, active goals/loops/workflows and undelivered results are
protected too. A root can archive with completed retained children only after
every child is idle, read and free of protected input or remaining work, and all
family results have been delivered. Child histories and archive flags stay
intact; new child work requires restoring the parent. Connected clients report
parked input; older or disconnected clients cannot report it. Missing
authentication, unavailable repositories or failed checks leave the conversation
visible. The [lifecycle reference](development.md#merged-pull-request-archives)
details proof validation and protection checks. Turning the toggle off stops
future automatic archives; it does not restore conversations already archived.

## Isolation and tests

Each connection has its own Store. IDs remain native to that core and are never
sent to another one. Notifications, panel state and saved composer text include
the machine identity. Only the visible host subscribes to an open conversation;
all hosts continue receiving summaries. Driver protocols remain unchanged.

`tests/e2e/machines.test.ts` covers two real temporary cores, pairing, routing,
restart, reload, automatic settings copies and a real remote terminal. Its fake fixture deliberately reuses thread and
project IDs on two hosts and produces desktop and phone captures. Core tests
cover user-message timestamps, origin validation and PR metadata parsing.
`tests/e2e/project-views.test.ts` checks project filtering, draft routing,
recent and custom ordering, drag and menu moves, reloads and phone layouts.
