# A core on a server

A headless core runs agents under its own user account, with that account's
logins and files. Desktop and phone clients connect through
[pairing](phone.md#pairing); they do not execute agents locally.

## Docker

The image includes the built UI, Bun, Node.js, Git, ripgrep and pinned Claude
Code, Codex, OpenCode and pi CLIs. It runs as UID 1000. Grok, Antigravity and
Muse Code are not preinstalled. Antigravity has a managed installer on Linux;
Grok and Muse Code have none there, so they need a custom image. The x64 image carries OpenCode's
baseline build only, which also runs on CPUs without AVX2. Agent
authentication is still required. No login is built into the image.

Release workflows publish `ghcr.io/mtsu-dev/boite/boite-server` for Linux x64 and ARM64.
Images built before the repository moved on 2026-10-26 stay at
`ghcr.io/beboite/boite/boite-server`, which gets no new tags. GHCR does not
redirect a moved package, so a Compose file that names it needs the new path.
Until the first image has been published, build it from this checkout:

```sh
docker build -t boite-server:local .
BOITE_IMAGE=boite-server:local docker compose up -d
```

For a published stable image, download [compose.yaml](../compose.yaml) into an
empty directory, then:

```sh
docker compose pull
docker compose up -d
docker compose exec boite-server boite-server pair --owner
```

Open the printed one-time link. The default listener is
`http://127.0.0.1:7337` on the Docker host. Pairing links are credentials;
keep them out of logs and reports.

| Named volume | Container path | Contents |
| --- | --- | --- |
| `boite-data` | `/data` | Journal, accounts, settings and core token |
| `boite-home` | `/home/node` | Default CLI logins, sessions and user tools |
| `boite-workspace` | `/workspace` | Project repositories and worktrees |

Clone projects into `/workspace` or replace its volume with a bind mount.
Bind-mounted files must be writable by UID 1000. Paths entered in boite refer
to the container. Do not mount the Docker socket or the host's complete home.

The container has no CPU cap and a 4 GB memory cap by default. Set `BOITE_CPUS`
in a local `.env` file to cap its CPUs, for example `BOITE_CPUS=2`; the value
must not exceed the host's CPU count, or Docker refuses to start the container.
`BOITE_MEM` sets the memory cap, for example `BOITE_MEM=2g`.

For a Codex login, for example:

```sh
docker compose exec boite-server codex login --device-auth
```

For isolated accounts, use the Providers page. Default CLI logins persist in
the home volume; isolated accounts persist in the data volume. See
[accounts](accounts.md). Install additional system tools in a derived image,
or user tools under `/home/node/.local`, whose `bin` directory is on `PATH`.

The image ships its agents in `/opt/agents`, owned by root. npm's global prefix
is `/home/node/.local` (`NPM_CONFIG_PREFIX`), and its `bin` comes before
`/opt/agents` on `PATH`. An agent update, from the Providers page or the
agent's own command (`codex update`, `pi update self`), installs there, in the
home volume, and that copy runs from then on. It outlives an image update, so
it is the copy Boite updates next. `npm uninstall -g <package>`
(`npm uninstall -g @openai/codex`) removes its `bin` entry and its
`lib/node_modules` copy, and the image's runs again.

### Updates and rollback

Record the current image digest and stop the core before backing up:

```sh
docker image inspect ghcr.io/mtsu-dev/boite/boite-server:latest --format '{{index .RepoDigests 0}}'
docker compose stop -t 60
```

The [restart handoff](restart-handoff.md) allows up to 30 seconds for active
tool calls and retains resumable threads for an hour. `-t 60` accommodates it;
Docker's default ten-second stop can interrupt that wait. Threads can still
resume after forced shutdown.

Back up all three volumes, including the complete SQLite data directory. Then:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

The image health check polls `/health` on the port and host the running core
wrote to `/data/core.json`, so a `--port` passed in `command:` is followed.
Compose restarts exited containers;
Docker does not automatically restart an unhealthy process.

To pin a release, set `BOITE_IMAGE=ghcr.io/mtsu-dev/boite/boite-server:v<version>` in
a local `.env` file. To roll back, stop the server, restore the matching volume
backup and set `BOITE_IMAGE` to the old recorded digest before starting again.
An older binary may not understand a journal migrated by a newer one.
`docker compose down -v` deletes the named volumes and is not an update command.

Nightlies use the `nightly` image tag after [activation](ci.md). Use a separate
Compose directory and project name, such as `boite-nightly`, with a different
host port and separate volumes. Never share a stable journal with a nightly.

### Remote access

Keep the localhost binding for a local reverse proxy. For a private network or
VPN, set `BOITE_BIND` to the host's private interface address. Change only the
host part of the printed pairing URL to that reachable address.

The core does not terminate TLS. Public access needs an HTTPS reverse proxy
that forwards WebSocket upgrades and preserves `Host` and `Origin`. Serve the
UI and `/rpc` from the same origin. Do not expose plain HTTP to the internet.
Set `BOITE_PUBLIC_URL` or `--public-url` to that exact HTTPS origin so pairing
links and the WebSocket origin check use it. [Phone setup](phone.md) includes
a Caddy example, installation steps and Web Push configuration.

`publicUrl` permits that exact HTTPS origin. A browser connecting to additional
cores needs its page's origin in each core's Machines > Allowed browser origins
([machines](machines.md#browser-and-phone-connections)). The origin includes
scheme, host and optional port. Preserve existing entries still in use.
An unapproved origin receives HTTP 403 on `/rpc`, even with a valid credential;
do not strip `Origin` to bypass the check.

### Image verification

From a Linux checkout with Docker:

```sh
docker build -t boite-server:test .
bash docker/smoke.sh boite-server:test
```

The test creates its own container and data volume. It verifies the built UI,
authentication, installed provider executables, an echo turn, graceful shutdown
and persistence after restart, then removes its container and volume. It makes
no real provider call and uses no existing login directory.

## Updating from the app

Open Settings, Machines and updates. A remote server whose row says Update
available has a signed release waiting: the updates card at the top lists it
under the app's own, with its installed and offered versions, and its Update
button installs it with everything else waiting. While that server downloads
or waits for its agents, its line offers Cancel. A Docker or hand-made server
says on its row how it updates.

The sidebar's update card lists that release too, and its Update all
installs it after the machine's agents
([update everything](updates.md#update-everything)).

Server updates require an owner connection, including on a phone. Ordinary
paired devices cannot stop or update the server. The action always goes to the
machine on the card, even after switching to another machine.

Automatic server installation supports standalone Linux x64 and ARM64 cores
started by a systemd user service. Keep the compiled `boite-core`, `boite` shim
and `ui` folder together in one writable directory, outside the data directory.
The default service name is `boite.service`; set `BOITE_SERVER_SERVICE` in the
service environment for another name. Its `ExecStart` must name that core
directly, and `Restart` must be `on-failure` or `no`. Desktop sidecars, source
runs, symlinked installs and containers keep their own installation method.
When a release is available, a Docker core's row has a tip with the Compose
update command and another unmanaged core's tip points to this guide. A core predating this feature needs one manual update first.

The server checks eight seconds after startup, then every six hours. An owner
client that connects, or whose window is shown again, asks it to check at once
when its last check is more than 15 minutes old; a download, a wait or a
failure is left as it is. It follows
its installed stable or nightly channel, downloads an immutable release's
signed server archive, and verifies the publisher signature and embedded
version before staging the complete core, CLI and UI. The archive is hashed as
it arrives and checked over every byte before anything unpacks; it is then
inflated a chunk at a time, so neither it nor its files sit in memory and other
requests keep being served. The download and idle
wait can be cancelled. An idle server installs through the idle gate. A busy
one hands its turns to the next core at once, as a desktop update does
([restart handoff](restart-handoff.md)): each running turn ends its tool call,
30 seconds at most, queued turns stay queued, and all resume after the
restart. Only an agent install under way holds it, since the restart would
replace the core under a half-written agent. Waiting for idle instead held a
machine with an agent working for hours on "Waiting for work to finish" for
good.

An independent systemd user job survives the core's shutdown. After the core
stops, it backs up the installation and the data directory, switches the
staged installation into place, and restarts the same service. The data
snapshot holds the journal and the state files beside it; checkpoints,
browser profiles, attachments, artifacts, logs and dictation models stay out,
since a release does not rewrite them. Copying them kept a server with 1,300
threads down 2 min 25 s for 8.9 GB, and filled its disk once mid-copy; a
rollback keeps the live ones. Before stopping the service, the job checks that
the disk holds the snapshot plus 1 GB; otherwise it starts the untouched
server again, since the core stops itself once it admits the update, with the
reason in its status. When the data directory sits on another filesystem than
the installation, the same room is checked beside the data directory too,
since a rollback must then copy the snapshot across; the live data already
sits on that disk, so the copy is the only thing added there. A copy cut short is
deleted. Health must report the target version and that service's new PID
within 30 seconds.
Failure restores both the previous installation and its data snapshot before
restarting. The snapshot is renamed back into place, never copied a second
time, so a rollback needs no room beyond what the update checked: a second
copy once failed the rollback of a disk left with only the spare 1 GB and
left the service stopped. Every step is a rename that a resumed rollback
picks up, so the data directory is either the new data or the restored one.
Across filesystems the copy takes its final name only once complete, and its
source is renamed aside before it is deleted, so a half-deleted snapshot never
passes for a backup. The previous installation starts only once the data is
back, or when the new version never ran on it; failing to delete the used
snapshot does not hold it back. If the data cannot be put back (an I/O error, a
disk another process filled) after the new version ran, the service stays
stopped, since the previous core would open data the new one migrated. The
reason goes in `server-update-result.json` in the data directory and the job's
journal, and the recovery below retries the restore. Once the data is back the
server's update status reports the failed update. The rejected data stays beside it as `<data>.failed-<id>`, without the stores
the snapshot left out, which move back with the restored data.
Pairings and conversations survive; clients reconnect normally.
Backups remain private beside the installation as `.boite-backup-<id>`, each
with a `backup.json` naming its installation. A successful update keeps its
own and the newest older one of the same installation that still holds a
complete snapshot, and deletes that installation's older ones. It never
touches a backup another installation in the same folder made, or one without
that marker, older releases' included: remove those by hand.
Failure artifacts also remain for diagnosis; inspect them before removing them.

The job runs under `MemoryHigh=1G`, which throttles it, rather than a hard
memory limit: copying a 19 GB data directory once filled a 512 MB limit with
page cache under writeback, and the kernel killed the job 30 seconds into the
copy, leaving the service stopped. Its unit now has an `ExecStopPost` that
runs `boite-core update-recover` however the job ends, a kill included. It
reads where the update stood from the disk: a job that never stopped the
service only closes the admission, a new version that answers health is kept,
and anything else is rolled back as above before the service starts again.
The recovery runs from a hard link of the job's executable,
`.boite-recover-<id>`, which it deletes when done. If the recovery itself
never ran, as after a power cut, the next update deletes the unfinished
operation directory and the incomplete snapshot it left, a half-deleted
used one (`data.consumed`) included. It only deletes
those of its own installation: each operation directory holds an
`owner.json` naming the installation from the moment it exists, so a second
installation in the same folder never deletes an update another one is
running. An operation or snapshot that names no installation is left alone.
Before the previous installation goes back in place, a rollback publishes
`<data>.rollback.json` beside the data directory, naming its operation and
snapshot: written whole to a temporary name, flushed and renamed in, and left
as it is when a retry finds it valid. It is removed only once the swap is
complete and flushed. A power cut in between leaves no recovery running, and
the service starts the previous version at boot. A start that finds the record
takes `<data>.maintenance.lock`, a kernel `flock` the job and its recovery hold
while they restore, so neither moves the data under the other. The restore
starts no process while it holds it, so the kernel drops it with a killed
holder. Whoever restores also holds the data directory's `core.lock` from its
first look until that data moves aside, and refuses while a live core holds it.
It puts its own `core.lock` in the restored copy before that copy takes the
data directory's name, so a core starting meanwhile finds the data taken or
the record still there, never a directory about to move away. It finishes that
operation's restore before anything opens the data: it uses the
`<data>.restore-<id>` the record names, never the newest one on disk, keeps
the rejected data as `<data>.failed-<id>` (or `<data>.unused-data` when that
name is taken) and reports the interrupted rollback in its update status. The
swap counts as complete only when the data directory holds
`server-update-restored` with the operation's id, written into the restored
copy just before it takes the name; a missing folder never passes for one. The
mark and the restored directory's entries are flushed before the swap, and a
flush that fails on Linux stops it with the record kept, so on a filesystem
that can flush a directory a power cut cannot keep the swap and lose the mark.
One that answers `EINVAL` or `ENOTSUP` to that flush gets the swap without
that guarantee. After a completed swap, every other
`<data>.restore-*` beside the
data directory is renamed to `<data>.unused-restore-*`, so no later start
replays an older copy. A recorded restore that is a file rather than a
directory is set aside the same way and moved again from the snapshot.
Whatever else stops the restore (a failed rename or copy, a missing snapshot,
a record it cannot read) refuses the start and keeps the record, the restored
copy and the data as they are: the data in place may be the rejected
version's, and the previous core must not open it. The next start tries again.
A start that finds no record writes nothing outside the data directory, so the
server image, whose data directory is a mount point in an unwritable `/`, and
a first start that creates the data directory's parents work as before. It
takes `core.lock`, then admits itself only if the record is still absent and
the data directory is still the one it locked (same inode); otherwise it
releases and looks again, and after three tries it takes the maintenance
lock as a start with a record does. A core lock is only removed by the process
that wrote it.

From a terminal on the server, the same owner actions need no thread:

```sh
boite server check
boite server update
boite server cancel
```

Use `--data-dir <directory>` or `--channel dev` when that server uses a different
data directory. An agent's thread token cannot use these owner-only methods.

## Building without Docker

```bash
bun run build:ui
bun run build:core:linux
```

That is `build:core` followed by `bun build --compile --target=bun-linux-x64-baseline --bytecode --format=esm`,
which writes `packages/core/dist/boite-core-linux-x64`: one executable for x64
glibc Linux that carries its own Bun, in the baseline build that also runs on
CPUs without AVX2. The precompiled bytecode cuts its start to ready by about
a third (bench/results/2026-10-15-perf-media.md) and ties the binary to the Bun
that built it, which the build pins. The image's Bun comes from `oven/bun`, whose x64 build is the
baseline one too. Cross-compiling works from Windows. Copy it
to the server with `packages/ui/dist` beside it, renamed `ui`, since a compiled
core looks for the UI next to its own executable. The build also writes
`packages/core/dist/boite`, the shim behind the `boite` command an agent runs
([CLI](cli.md)). Copy it beside the executable too: the core puts that directory
on the PATH of every agent it starts, and warns at start when the shim is
missing, since no agent can then reach the panel or the task list.

```
~/.local/lib/boite/
  boite-core      (the executable, mode 755)
  boite           (the CLI shim, mode 755)
  ui/             (packages/ui/dist)
```

The Job Object and focus guard workers are Windows only and are not needed here.

## Running it

The core binds `127.0.0.1` unless told otherwise. On a server, give it the
address of a private network the other computers share, a VPN interface say, and
a fixed port:

```bash
~/.local/lib/boite/boite-core --host <private address> --port <port>
```

`BOITE_MACHINE_NAME` sets the name the core reports to clients and its group;
otherwise it uses the operating system's hostname (`machineName` in
`packages/core/src/paths.ts`). The value is trimmed and limited to 100
characters. Set it in the core's environment before starting it, for example
with an `Environment=BOITE_MACHINE_NAME=build-server` line in the unit below.
Client-side names and icons in [Machines](machines.md) remain device preferences.

There is no TLS on the socket. Never bind a public address: the key a pairing
link becomes travels in the first frame, and `ws://` carries it in the clear.

Anything on that network can still knock, so the core bounds what an
unauthenticated peer costs it. A socket gets 5 seconds to say hello, and a
frame over 64 KB before hello closes it unread. At most 32 sockets from other
machines may wait for their hello at once, and 8 from any one LAN address; the
next upgrade gets a 503. The address is the TCP peer's, so it cannot be forged.
A socket from this machine that also dialled a loopback name is never counted,
so a flood cannot lock the owner's shell or agents out. Peers behind a tunnel on
this machine arrive from loopback with a public `Host`: they are counted, under
the 32 only. An HTTP connection idle for
60 seconds is closed. An authenticated socket reads frames up to 16 MB, the
limit the attachments of one turn are sized for. The UI page is served with
`frame-ancestors 'self'`, so no other site can frame it.

A systemd user unit keeps it running, with `loginctl enable-linger <account>` so
it starts at boot without a login:

```ini
# ~/.config/systemd/user/boite.service
[Unit]
Description=Boite core
After=network-online.target

[Service]
ExecStart=%h/.local/lib/boite/boite-core --host <private address> --port <port>
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

Each process the core starts leads a process group of its own, and stopping a
thread signals that group: SIGTERM, then SIGKILL two seconds later to a group
that still has members. The core's own shutdown, on SIGTERM, SIGINT or SIGHUP,
does the same to every group and waits for it before it exits. A tool that
leaves the group on purpose (a daemon calling `setsid`) escapes it, and a core
killed hard leaves the groups it started running. Stopping the unit still reaps
them: `KillMode=mixed` sends `SIGTERM` to the core alone, then ends whatever is
left in the service's cgroup once the core exited or `TimeoutStopSec` passed.
Never set `KillMode=process`, which leaves them running.

`systemctl --user restart boite` is how an update is installed: replace the
files, then restart. On `SIGTERM` the core starts a
[restart handoff](restart-handoff.md): running agents finish the tool call
they are in, 30 seconds at most, and their threads resume once the new core is
up. `TimeoutStopSec=60` covers that wait. An agent that restarts the unit from
one of its own commands uses `--no-block`, or its command is the tool call the
core waits 30 seconds for.

The data directory is `~/.local/share/boite2` on the stable channel and
`~/.local/share/boite2-dev` on the dev one, or whatever `--data-dir` or
`BOITE_DATA_DIR` names: the journal, the accounts, `core.json` with the core
token (mode 600) and `core.lock`. `$XDG_DATA_HOME` is not read.

## Pairing the desktop app with it

On the server, as the account that runs the core:

```bash
~/.local/lib/boite/boite-core pair --owner
```

The command reads the port and the core token from `core.json`, asks the running
core for a one-time link over its own socket, and prints it on stdout; stderr
says which role it carries and until when it works. Without `--owner` the link
is a phone's. `--data-dir` and `--channel` name another core, as they do at
start.

`boite-core accounts` asks the running core the same way for the agent
accounts Settings › Providers shows, one line per account with its provider,
status and label, or the list as JSON with `--json`. `--refresh` first reloads
the providers, which adopts a login made with an agent's own CLI, then checks
every account against its agent.

A server that belongs with your other machines joins their [group](groups.md)
instead, with `boite-core group join`, which reads the invitation on its
standard input: the desktop app of every member then drives it, and it needs
no link per desktop.

To reach the core from a phone over HTTPS through Tailscale:

```bash
~/.local/lib/boite/boite-core tailscale          # status
~/.local/lib/boite/boite-core tailscale on       # serve it on https://<machine>.<tailnet>.ts.net
~/.local/lib/boite/boite-core tailscale off
```

`on` runs `tailscale serve` for this core's port and sets the public URL; it
refuses to take 443 from another target unless given `--replace`. The command
exits 0 when the state is on or off, 2 when Tailscale needs something first
(the line says what, with the page to open), 1 on an error. The account running
it must be allowed to change Tailscale's serve config (on Linux, `sudo tailscale
set --operator=$USER` once). See [phone.md](phone.md#through-tailscale).

Paste the link into Settings, Machines and updates, Add machine. Full control
permits
accounts, projects, settings and further pairing. Removing the local connection
forgets its key; revoking it on the server invalidates it. [Machines](machines.md)
owns routing/reconnection and [phone pairing](phone.md#pairing) owns grant
exchange, roles, hashing and revocation.

## What changes when the core is elsewhere

- Paths are the server's. The native folder picker is hidden while the shell
  drives a core that is not its own, and a project is added by typing the path
  on the server.
- Agent logins happen on the server, for the account running the core. A login
  that opens a browser needs a way to reach that browser, which a headless
  machine does not have; the device-code flows in [accounts.md](accounts.md)
  work.
- Windows Job Objects provide exact descendant tracking and the CPU cap, focus
  guard and audio mute. Linux/macOS register direct children and signal process
  groups, which descendants can leave. Memory protection is cross-platform;
  its eligible-child and sampling limits are in [trace](trace.md).
