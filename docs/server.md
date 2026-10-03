# A core on a server

A headless core runs agents under its own user account, with that account's
logins and files. Desktop and phone clients connect through
[pairing](phone.md#pairing); they do not execute agents locally.

## Docker

The image includes the built UI, Bun, Node.js, Git, ripgrep and pinned Claude
Code, Codex, OpenCode and pi CLIs. It runs as UID 1000. Grok, Antigravity and
Muse Code are not preinstalled, and neither is the Antigravity CLI. Antigravity
has a managed installer on Linux; Grok, Muse Code and the Antigravity CLI have
none there, so they need a custom image. The x64 image carries OpenCode's
baseline build only, which also runs on CPUs without AVX2. Agent
authentication is still required. No login is built into the image.

Release workflows publish `ghcr.io/beboite/boite/boite-server` for Linux x64 and ARM64.
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

### Updates and rollback

Record the current image digest and stop the core before backing up:

```sh
docker image inspect ghcr.io/beboite/boite/boite-server:latest --format '{{index .RepoDigests 0}}'
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

To pin a release, set `BOITE_IMAGE=ghcr.io/beboite/boite/boite-server:v<version>` in
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

Open Settings, Machines and updates. In Updates, each remote server shows its
installed version and a Check for updates action. When a signed server release
is available, Update appears on that machine's card. The desktop app's own
manual check and channel choices appear in the same Updates section.
Cards show the installed and offered versions together. Details expands the
idle wait, backup and recovery behavior without adding it to the confirmation.

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
Docker cards show the Compose update command; other unmanaged or older cores
link to this guide. A core predating this feature needs one manual update first.

The server checks eight seconds after startup, then every six hours. It follows
its installed stable or nightly channel, downloads an immutable release's
signed server archive, and verifies the publisher signature and embedded
version before staging the complete core, CLI and UI. No update stops a running
turn. The download and idle wait can be cancelled. Running and queued turns,
terminals, warm sessions, background tasks and authenticated requests must
finish before the existing idle-shutdown gate admits installation.

An independent systemd user job survives the core's shutdown. After the core
stops, it backs up the complete data directory and installation, switches the
staged installation into place, and restarts the same service. Health must
report the target version and that service's new PID within 30 seconds.
Failure restores both the previous installation and its data snapshot before
restarting. Pairings and conversations survive; clients reconnect normally.
Backups remain private beside the installation as `.boite-backup-<id>`.
Failure artifacts also remain for diagnosis; inspect them before removing them.

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

That is `build:core` followed by `bun build --compile --target=bun-linux-x64-baseline`,
which writes `packages/core/dist/boite-core-linux-x64`: one executable for x64
glibc Linux that carries its own Bun, in the baseline build that also runs on
CPUs without AVX2. The image's Bun comes from `oven/bun`, whose x64 build is the
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
