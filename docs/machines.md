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

The machine list shows connection errors and lets you reopen a host or disconnect
it. Disconnect closes that host's socket and forgets its saved key. It does not
stop agents, remove files or revoke the key on the remote host. Use the remote
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
longer drops a healthy connection or reloads the lists. A hidden page is not
checked.

Retries wait 1, 2, 4, 8, then 10 seconds, each 20 % longer or shorter at random
so the clients of a restarted core do not all return at once. An attempt gets
10 seconds to open and say hello, the next one 20, then 30, so a slow, lossy
link is not cut off every time. While the browser reports itself offline, a
remote host is not retried at all: the `online` event starts the next attempt.
A loopback core is retried regardless, since it is on the same machine.

## Browser and phone connections

The desktop shell is an allowed origin on every core. A browser or phone has
the origin of the core serving its page. On each additional machine, add that
exact origin to Machines, Allowed browser origins. Origins contain a scheme,
host and optional port, with no path or wildcard. Save the list on that core.
Removing an origin blocks new connections from it; existing authenticated
connections must be revoked separately if they should lose access immediately.

The origin permission does not replace authentication. Every socket still needs
its own valid token or one-time grant. HTTPS pages need secure WebSocket endpoints;
network reachability and TLS configuration belong to the host deployment.

## Two views

Projects is the default. Every connected machine's projects appear together,
with pinned threads first inside each project. Recent flattens the list and
sorts it by the most recent accepted user message. Assistant output, generated
titles, pins and load events do not move a thread in Recent. Threads without
a user message use their creation time. The view is remembered on this device.

All machines can be narrowed to one machine from the filter button beside Settings at the bottom of the sidebar. Search
matches thread titles, project names and machine names. The command palette and
the draft's project picker also include every connected host.

Cards have a title row and a second row for the project and machine icon. The
machine name remains in the tooltip and accessible label. An associated PR
appears as a green underlined number immediately before the machine icon; no
placeholder appears when there is no PR. PR
metadata comes from the execution machine's `gh pr list`, using the worktree
branch or the current branch of the working directory. Non-repositories and
detached checkouts have no PR. The core caches results and errors for one minute,
coalesces duplicate requests, and runs at most two lookups at once. Each command
has a ten-second deadline and runs through the process registry under
`pull-request:<threadId>`. The thread menu can request a refresh. Missing `gh`,
authentication failures and malformed responses use the error notification. A PR link opens in the system browser.

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
restart, reload and disconnect. Its fake fixture deliberately reuses thread and
project IDs on two hosts and produces desktop and phone captures. Core tests
cover user-message timestamps, origin validation and PR metadata parsing.
