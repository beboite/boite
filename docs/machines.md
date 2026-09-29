# Machines and thread views

Boite connects to several cores at once. Each machine owns its projects, files,
accounts and execution. Opening a thread selects its machine for the chat,
composer and settings. It does not move the thread or its processes.

## Connecting a machine

Open Machines from Settings. On the machine to add,
mint a full-control pairing link in General, or run `boite-core pair --owner`.
Paste the link into Add machine, optionally name it, then connect. A manual URL
and token form is available under the pairing form.

Each successful pairing saves its session key locally. The one-time grant is
discarded. Existing remembered cores are loaded on startup. The desktop restores its selected connection and connects remembered machines beside it. A fresh local core with no threads yields to a remembered core on the same computer that already holds threads.

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

A link can die without closing the socket: a phone's NAT mapping expires, the
core's host sleeps, a tunnel changes path. The client notices by itself
(`packages/ui/src/lib/client.ts`). On a remote host, 25 seconds without any
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
composer clears as for any sent prompt. Only a refused retry, or a connection
that does not come back in time, shows the error and keeps the text.

Retries wait 1, 2, 4, 8, then 10 seconds, each 20 % longer or shorter at random
so the clients of a restarted core do not all return at once. An attempt gets
10 seconds to open and say hello, the next one 20, then 30, so a slow, lossy
link is not cut off every time. While the browser reports itself offline, a
remote host is not retried at all: the `online` event starts the next attempt.
A loopback core is retried regardless, since it is on the same machine.

## Automatic settings synchronization

Each card of another machine has a checkbox to keep its settings synchronized
with the machine currently selected in Settings. Checking it copies settings
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

- limits, process guards, agent updates and question mode;
- keybindings where the two differ, including unbound commands and restored
  defaults. A failed or canceled copy attempts to restore entries already changed;
- the brain's Use with agents, instructions, guide and automatic pull switches
  when both machines have a brain folder. The target keeps its own folder.

Network access, public URLs, browser origins and provider sign-ins stay on their
own machine. The report names providers that still need signing in on the target
and opens that machine's Providers page. Methods absent on an older core are
skipped for that part. Automatic brain changes require the source core's
`brain.configured` event. A failure names its stage; earlier changes stay copied,
and the next source change or reconnect tries again.

## Remote terminals

The terminal in a conversation runs on the machine that owns that conversation,
in its working directory. Reloading the same conversation preserves the keyboard
focus in the terminal; only opening a different conversation or draft moves it
to the composer. Refused keystrokes report their error rather than being
silently discarded. Its output events can arrive while the opening or
reattachment response is still in flight. The client buffers those events and
uses the snapshot's output sequence to append only events the snapshot has not
already included. Older cores without sequence numbers keep the buffered output
but cannot remove overlap with the snapshot.

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

The origin permission does not replace authentication. Every socket still needs
its own valid token or one-time grant. HTTPS pages need secure WebSocket endpoints;
network reachability and TLS configuration belong to the host deployment.

## Two views

Projects is the default. Projects appear by recent user activity, using the
latest accepted user message among their visible threads, or creation time
when no message exists. Assistant output and title changes leave that order
alone. Click Projects again to switch to Custom order, then drag project
headers to rearrange them. Their menus also offer Move project up and Move
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

With several machines connected, cards show the machine icon beside the title.
The machine name remains in the tooltip and accessible label. A second row
appears only for the project or an associated PR, shown as a green underlined
number. Connecting another machine leaves cards without project or PR metadata
at their single-machine height. No placeholder appears when there is no PR. PR
metadata comes from the execution machine's `gh pr list`, using the worktree
branch or the current branch of the working directory. Non-repositories and
detached checkouts have no PR. The core asks once per repository, not per
thread: one `git remote -v` kept five minutes, and one `gh pr list` of the 200
latest pull requests with their head branches, kept one minute with its errors,
which every thread of that repository reads its branch from. The worktrees of
one repository count as that repository: the core finds it from the common git
directory each checkout's `.git` file points to. Only when gh returned a full
page of 200 and a branch is missing from it does the core ask for that branch
alone, even if two of those 200 came from one branch. At most two commands run at once. Each has a ten-second deadline and
runs through the process registry under `pull-request:<threadId>`. Cards in a
folded project wait for the unfold before they ask.

A lookup the user did not ask for fails quietly, and once `gh` is missing or
signed out the core stops starting it. The thread menu's refresh reads the
repository again, tries `gh` again, and shows a missing `gh`, an
authentication failure or a malformed response in the error notification. A
PR link opens in the system browser.

Older cores that do not implement PR lookup are probed once per connection.
Their cards omit the PR link. A manual refresh explains that the hosting
machine needs an update; other RPC errors still appear in a notification.
Reconnecting clears the capability check so an updated core is detected.

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
