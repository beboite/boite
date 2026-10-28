# Machines and thread views

Boite connects to several cores at once. Each machine owns its projects, files,
accounts and execution. Opening a thread selects its machine for the chat,
composer and settings. It does not move the thread or its processes.

Thread links resolve against the machine that owns the rendered answer, including
archived conversations absent from its active list. An explicit machine or core
name stays scoped to that owner; unresolved or ambiguous names show an error.
Navigation made while an address is being resolved takes precedence.

Selecting a thread in the command palette or a saved draft switches directly to
that destination. A draft retains its ID, project, text and attachments; a machine
switch without a destination still restores the previous conversation.

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

Repairing the primary connection saves its accepted device credential or session
key before reporting the handshake as ready. Draft storage and list loading may
still be pending; reloading then needs no new pairing link. Connecting another
machine saves its credentials without replacing the primary startup endpoint.

A machine that is off does not hold the others back. When the machine the
window opens on has not said hello after two seconds, the other remembered
machines are connected without it, and the window opens on the first that
answers: on the draft a start lands on, and there again at the next start. A
machine that refuses at once gives way the same way. The loading screen stays
for up to six seconds while another machine may still answer, so a laptop that
is off shows neither an empty page nor its connection error first; with nobody
else answering, that machine is shown as it is. Until this, a phone paired with
a laptop that was then switched off stayed blank for ten seconds and landed on
the laptop's error, the rest of its group connected behind it. Three cases
wait as before: a link in the address bar, which names the machine the owner
asked for; the shell's own core, which the shell restarts itself; and a window
where the user already opened something. The machine that was off is retried
in the background and comes back as one more machine of the list.

A start opens on the machine shown last. A device can name its main machine
instead, under Machines and updates in Settings, once it reaches more than one:
every start then opens on that machine, whichever one was shown since. The
choice is made on the device and kept there (`boite.main` in its storage), so a
phone and a browser each have their own. The desktop app has no such row: it
always opens on the machine shown last, and ignores a choice an earlier version
saved. The choice gives the machine nothing: its key, its role and what a
[group](groups.md) may do with it stay as they were. A
main machine that is off gives way like any other, after the same two seconds
at every start, and is asked first again at the next one. A machine the group
brought stays the one chosen when its address changes. A machine this device
holds no key for any more, removed here or dropped by its group, no longer
counts: starts open on the machine shown last until it is connected again. The
desktop app never opens on a machine connected by URL and token, since that
stored key could be its own core's from an earlier start.

Machine names and icons can be changed in Settings. These preferences are saved on this client and follow the core across address changes. Connections to the same host, data directory and channel appear once.

The shell discovers its local core on startup instead of remembering its temporary
port as another machine. Older generated `This computer` loopback entries are
removed during startup. Paired remote connections are retained. The sidebar
counter and project picker use the workspace's connected machine list.

The machine list shows connection errors and lets you reopen a host or remove
it. Remove machine asks first, then closes that host's socket and forgets it on
this device. It does not stop agents, remove files or take this device out of
the group: **Remove from the group** on the device's row does that, on every
machine. The primary core stays attached.

If a machine goes offline, its known rows remain visible and its machine badge
shows the disconnected state. A turn those rows last saw at work is only a last
known state: the row reads "Unreachable" with that state in its tooltip instead
of spinning and counting time, a folded project drops its summary mark, its
working counter loses its colour, and the Threads count leaves the machine out.
Other hosts remain usable. WebSocket reconnection
reloads the host's project and thread summaries. An initial connection whose
handshake does not finish within twelve seconds can be retried from Machines.
Once the machine has said hello, loading its lists is waited for however long
it takes on a slow link; the connection is never dropped for it.

Each machine keeps its own clock. The hello's answer carries the core's
(`CoreInfo.now`), and the client takes the difference from the middle of the
round trip as that machine's `clockOffset`. A running turn's counters (working
for, compaction elapsed) count the core's timestamps against the device's
clock plus that offset, so a desktop 11 seconds behind its server no longer
shows "Elapsed: 0s" for the first 11 seconds. Each liveness probe's `hello`
measures it again, so a device that sets its clock right on a live socket,
back from sleep, follows within one probe; a change under a second is
round-trip noise and is ignored, and so is a probe whose round trip took a
second or more, a hello held behind an upload. An older core sends no clock
and the offset stays zero.

The client detects silent remote sockets (`packages/ui/src/lib/ws-client.ts`).
On a remote host, 25 seconds without any frame sends a `hello`, which the core
answers on an open connection with its info and nothing else. That `hello`
carries no token and no device signature, since the core reads none of its
params once the socket is authenticated. A call that hears no frame at all for
3 seconds sends the same `hello`, so a click on a conversation of a machine
whose link died shows that machine offline within 13 seconds. The call counts
frames rather than reading the clock, since a frame and a call can share a
millisecond. If no frame of any kind arrives within 10 seconds of a `hello`,
the socket is replaced and the calls it carried fail as dropped. A remote
client asks the core to slice every answer (`progress`,
`features.chunkedAnswers`): each 64 KiB slice is a frame, so a long answer on a
slow link keeps the socket alive while a dead link stays silent. Requests are
not sliced, and the `hello` queues behind what the client still uploads: past
the first 64 KiB sent since the last frame arrived, the deadline grows by the
time those bytes take at 32 KiB/s, so a prompt with 2 MiB of pictures gets 62
seconds more. A core without sliced answers may still be sending one frame of up to
16 MB: there, while a call waits, only that call's own 120 second timeout
starts the check. Until 2026-10-22 that rule held on every core, and a VPN
that dropped under an open conversation left the machine reading as connected
for over two minutes while every call made there waited. A failure that only
says the machine went away is not shown in red: the machine's status, its
greyed rows and the composer already say it, and a conversation opened as the
link went shows offline until the reconnect opens it again. Returning to the page, an `online` event or
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
the reason. A page opened on its own core with no key says the device is not in
its group yet. A phone then scans the QR code of **Add a device** from any
machine of the group, or pastes its link ([phone](phone.md#adding-a-phone)); a
computer's browser pastes the copied link under **Add a machine**. Both are the affected machine's
**Add again** control too. Only a connected machine is refused as already
connected.

The link decides which machine is reached; the name only labels it. Once a
link is pasted the form names the host it reaches and the listed machine at
that address, if any. A name already used by another machine gets the
newcomer's host beside it, as in `Studio (build.example)`, when pairing and
when renaming.

## The machines page

Settings, Machines and updates folds nothing. Its first card is Boite's
updates: the version this desktop app runs, the release found with its
changelog, the channel (Nightly or Release; Release stays disabled until a
stable release is published), Check for updates and Update. Check reads
everything again: the app, Boite on every machine connected with full control,
another Windows PC's desktop app as its window reports it
([updated from here](updates.md#the-desktop-app-of-another-pc)), and the agents
there. Under it, every other pending update is listed by machine, and Update
starts all of them ([update everything](updates.md#update-everything)); a
server still downloading or waiting can be cancelled from its line. Once the
app's own release is downloaded and nothing else waits, the button restarts
into it after its confirmation. A browser has no app updater: the card shows
the version of the machine the page is on.

The group card lists each machine on one row, then the phones and browsers:
its icon, its name, whether it is connected, its Boite version and one word
about its updates. The row's word is the most pressing of what it finds: a
failed update, then one in progress, then one available, then a check in
progress, then Up to date. A row says nothing until something has answered. A
Docker, hand-made or too old server says how it updates in a tip on its row.
This computer goes by its host name while it keeps the default name, and by
the name it was given once renamed; either way lists add "(you)" after it. A
core started with `BOITE_MACHINE_NAME` goes by that name instead of its host
name, on the roster and wherever it names itself (`machineName` in
`packages/core/src/paths.ts`); the [Android server](android-server.md) sets it,
since every phone's host name is `localhost`. **Add a device**, in the card's
header, draws the QR code and offers the link ([groups](groups.md#using-it)).

Once the group has two machines, each machine's row this window controls
carries a **Threads from the other machines** switch (`groupThreads`), off by
default: on, the agents of the other machines may start threads in its
projects with `boite thread new --machine` ([CLI](cli.md#commands)). The
setting belongs to that machine and is saved there, so the PC with the printer
can accept them while the server does not. Beside it, **Bots from the other
machines** (`groupBots`, off by default) lets a bot of another machine look
after the projects of this one its owner entrusted to it; off, it cuts them
off at once ([bots](bots.md#projects-of-the-other-machines-of-the-group)). A
row shown away hides both.
Agent versions and their automatic update switch are on each machine's
Providers page. How a phone reaches this machine without a server of the
group (Tailscale HTTPS, the local network, a reverse proxy of one's own) is the
Phone app card under Advanced.

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

The group card's **Default machine** picks one member whose settings every
other member follows, or None. The choice is the group's (`group.settingsHome`,
kept in the roster beside its name and merged the same way: the latest choice
wins), so every member on current Boite shows the same one, and a member that
leaves the group stops being the default. A core before `features.settingsHome`
reports no choice and keeps its own settings; the card names it.

A window that owns both machines makes the copy: at once, then after each
change on the default machine and after each reconnect, while that window is
open, Settings closed or not. The remote core persists what it receives and
keeps executing independently when the default machine or this window is
offline. Copies saved per window by earlier versions are dropped.

The client copies (`SYNCED_SETTINGS` in the contracts):

- deleted-history retention, process guards, question mode, short answers,
  tool summaries, automatic compaction and the cache keepalive;
- **Install updates by itself when nothing runs** (`autoInstallUpdates`), so a
  server as default machine, which cannot update itself, still carries the
  choice to every desktop ([updates](updates.md#installing-by-itself));
- keybindings where the two differ, including unbound commands and restored
  defaults. A failed or canceled copy attempts to restore entries already changed;
- the brain's Share instructions automatically, instructions, guide and automatic pull switches
  when both machines have a brain folder. The target keeps its own folder.

Resource limits, memory protection, process retention, automatic agent updates,
worktree storage, network access, public URLs, browser origins and provider
sign-ins stay on their own machine. So does **Threads from the other
machines**: it says what one machine lets the others do, a choice made per
machine, and a copy would open every follower as soon as the default machine
opened.

A synced setting changed on a following machine stays there: the change also
adds it to that machine's `syncOverrides` (a setting's key,
`keybinding:<command>` or `brain:<switch>`), which the copy skips. The settings
part of the copy goes through `settings.follow`, which leaves out what the
follower keeps at the moment it writes, so a change saved there from another
window meanwhile stays. The page
shows it with a star in the accent colour; clicking the star gives it back and
copies the default machine's value at once when that machine is connected in
this window, at its next connection otherwise. Only a change made on that machine
marks it; the copy itself never does.

Every settings page that belongs to one machine (General, Keyboard, Voice,
Providers, Plugins, Brain, Limits, Task manager, Protection, Advanced and
Diagnostics) has a machine picker above it once this window has more than one
machine to pick. Picking another machine shows and
changes that machine's settings without moving the window or its open
conversation; Plugins opens on this PC, the others on the window's machine.
On a machine that follows the default one, a note under the picker says so;
the default machine says it is the default. Appearance and Experiments belong
to the window, Machines to the group, and Usage keeps its own machine filter,
which can read every machine at once.

Methods absent on an older core are skipped for that part. Automatic brain
changes require the default machine's `brain.configured` event. A failure names
its stage; earlier changes stay copied, and the next change or reconnect tries
again.

## Remote terminals

The [thread terminal](terminal.md) runs on the conversation's owning machine
and working directory. Its owner-only access, output reattachment and focus
behavior are documented there.

## Browser and phone connections

The desktop shell is an allowed origin on every core. A browser or phone has
the origin of the machine serving its page, which every machine of that
machine's [group](groups.md#devices) accepts on its own: the addresses it gives
and the origins its page was served at. A page served by something outside the
group needs its exact origin under Advanced, Allowed browser origins, on each
machine it opens a socket on. Origins contain a scheme,
host and optional port, with no wildcard. A pasted address keeps only its
origin: the core drops a trailing `/` or a path, since the browser's `Origin`
header never carries one, and a line given twice is kept once. The list saves
on that core by itself after a pause in typing; until every line is an origin,
nothing is sent and the card says so.
Removing an origin blocks new connections from it; existing authenticated
connections must be revoked separately if they should lose access immediately.

The origin permission does not replace authentication. Every socket still needs
its own credential: a device signature, a token, a one-time grant or a group
ticket. HTTPS pages
need secure WebSocket endpoints. [Phone setup](phone.md#https-and-installation)
owns HTTPS and adding a phone; [server deployment](server.md) owns host
reachability.

## Two views

The sidebar's Display options panel (the sliders icon) chooses between Projects
and Recent, above its grouping switches. Projects is the default. Projects
appear by recent user activity, using the latest accepted user message among
their visible threads, or creation time when no message exists. Assistant
output and title changes leave that order alone. The panel's Project order
choice switches to Custom; then drag project headers to rearrange them,
with the mouse or, on a phone, after holding a header still for a moment; a
line shows where the project lands and Escape cancels. Their menus also offer Move project up and Move
project down, including on a phone. Switching back to recent activity keeps
the saved custom arrangement. The view and custom order belong to this device.
So do folded projects: a project folded under its header stays folded after a
restart, kept per core in localStorage (`boite.foldedProjects.v1`). A draft
opened in a folded project, or a conversation moved into it, unfolds it.

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
cached for five minutes and the newest 200 PRs for 15 seconds; a failed read is
kept 15 seconds. The merged-PR archive reads the same two caches.
A missing branch gets its own lookup only when that list was full. At most two
commands run at once, each with a ten-second deadline through `procs` as
`pull-request:<threadId>`. Folded projects defer lookups until opened. A client
asks again every 15 seconds while the thread works and once a minute at rest,
not while its page is hidden. These rounds skip a merged PR; a status change, a
remount, a reconnect and Refresh PR still ask, so a newer PR on the same branch
replaces it.

When a machine drops, its cards stay listed, greyed, and still open. The client
asks nothing of the core then: it shows the timeline it last read for that
thread, or an empty one for a thread it never opened. Sending in such a thread
puts the prompt in the thread's outbox, and the composer says the machine is
offline. When the machine is back, the reconnect reopens the thread, reads its
team, workflows and coordination, then sends the outbox.

The outbox is the thread's queue with a request on each entry
(`OutboxRequest` in `store/composer.svelte.ts`), a stable ID and the agent,
account, model, effort and speed chosen when it was written. The device's
IndexedDB journal and text backup retain input until synchronization succeeds.
The owning core then stores the queue and broadcasts its revised record to
owner and paired devices. Once accepted, it runs without the app open. Each
outbox entry starts its own turn, in order; it is never steered into a running
turn. Execution uses the captured selection without replacing the current
picker. Permissions and blocking questions still hold delivery.

Ordinary follow-ups typed during a running turn use the same server storage,
but retain native steering at tool boundaries and Send now. Delivery receipts
prevent a stale cache from replaying consumed entries. A refused or ambiguous
submission pauses the queue with its reason; unconfirmed delivery is never
retried automatically. Taking an entry back into the box and sending it again
creates a new request. A machine offline since the app started has no cards to
open: the client keeps no copy of the thread list.

A new conversation waits the same way. Sending a draft while its core is
offline keeps its first prompt and captured selection on the device. A client
must reconnect to synchronize that input. After the core accepts it, it creates
the conversation and transfers the queue and draft deletion in one transaction;
a restart cannot create a second conversation from that accepted draft. New
text typed while creation was pending remains a draft. The sidebar's clock
and tooltip identify a pending start and its machine. Cancel the start returns
an unsent prompt to the box; an in-flight start remains locked while its result
is unknown.

Incognito drafts and replies stay in client memory, with no durable upload or
cross-device synchronization. Older cores without `composerPersistence` keep
the client-owned outbox and draft launch path
(`packages/ui/src/lib/store/draft-launch.svelte.ts`).

Archiving or restoring a project of a machine that is offline still works: the
project moves at once and the choice is kept on this device, per core, in
localStorage (`boite.pendingArchive.v1`). The machine's next project list is
shown with those choices laid over it, then each is sent with
`projects.archive`. A call lost with the connection waits for the next
reconnect; a refused one, or a project the machine no longer lists, drops the
choice (`store/projects.svelte.ts`).

A lookup the user did not ask for fails quietly, and once `gh` is missing or
signed out the core stops starting it. The thread menu's refresh reads the
repository again, tries `gh` again, and shows a missing `gh`, an
authentication failure or a malformed response in the error notification. A
PR link opens in the system browser.

Older cores that do not implement PR lookup are probed once per connection.
Their cards omit the PR link. A manual refresh explains that the hosting
machine needs an update; other RPC errors still appear in a notification.
Reconnecting clears the capability check so an updated core is detected.

## Back and forward

On a desktop, a mouse's back and forward buttons walk the views this window
showed, in order: a thread, a draft, a settings tab or the Bots page, on
whichever machine each one was. Back from a thread on another machine returns
to that machine as well as to the view. A view opened after going back replaces
what was ahead of it, as in a browser.

The trail lives in memory (`lib/view-history.svelte.ts`), holds the last 100
views and starts empty with each window. A thread or project deleted since, or a
machine removed, is stepped over. A thread still loading is not a view yet, and a
machine switch counts once. The browser's own history is left alone: on a
desktop the app cancels the navigation those buttons would start, so Back at
the first view stays in Boite. Under 720 px the buttons keep the browser's
meaning, which closes the open sheet ([phone](phone.md)).

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
restart, reload, automatic settings copies, a real remote terminal, a phone
reloaded while the machine it paired with answers nothing, and that phone
naming its main machine. Its fake fixture deliberately reuses thread and
project IDs on two hosts and produces desktop and phone captures. Core tests
cover user-message timestamps, origin validation and PR metadata parsing.
`tests/e2e/project-views.test.ts` checks project filtering, draft routing,
recent and custom ordering, drag and menu moves, reloads and phone layouts.
