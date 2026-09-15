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

The machine list shows connection errors and lets you reopen a host or disconnect
it. Disconnect closes that host's socket and forgets its saved key. It does not
stop agents, remove files or revoke the key on the remote host. Use the remote
core's paired-device list to revoke it. The primary core stays attached.

If a machine goes offline, its known rows remain visible and its machine badge
shows the disconnected state. Other hosts remain usable. WebSocket reconnection
reloads the host's project and thread summaries. An initial connection that does
not answer within twelve seconds can be retried from Machines.

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

Cards have a title row and a second row for the PR, project and machine. PR
metadata comes from the execution machine's `gh pr list`, using the worktree
branch or the current branch of the working directory. Non-repositories and
detached checkouts have no PR. The core caches results and errors for one minute,
coalesces duplicate requests, and runs at most two lookups at once. Each command
has a ten-second deadline and runs through the process registry under
`pull-request:<threadId>`. The thread menu can request a refresh. Missing `gh`,
authentication failures and malformed responses appear as unavailable metadata,
not as a claim that no PR exists. A PR link opens in the system browser.

## Isolation and tests

Each connection has its own Store. IDs remain native to that core and are never
sent to another one. Notifications, panel state and saved composer text include
the machine identity. Only the visible host subscribes to an open conversation;
all hosts continue receiving summaries. Driver protocols remain unchanged.

`tests/e2e/machines.test.ts` covers two real temporary cores, pairing, routing,
restart, reload and disconnect. Its fake fixture deliberately reuses thread and
project IDs on two hosts and produces desktop and phone captures. Core tests
cover user-message timestamps, origin validation and PR metadata parsing.
