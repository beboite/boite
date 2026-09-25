# A core on a server

The core is a Bun program with no window, so it runs as well on a Linux machine
nobody sits at as it does beside the desktop shell. The agents it starts run on
that machine too, under the account that runs the core, with that account's
logins and that machine's files. The desktop app on another computer drives it
through a pairing key; the phone reaches it the same way it reaches any core.

## Docker

The image includes the built UI, Bun, Node.js, Git, ripgrep and pinned Claude
Code, Codex, OpenCode and pi CLIs. It runs as UID 1000. Grok, Antigravity and
Muse Code are not preinstalled, and neither is the Antigravity CLI. Antigravity
has a managed installer on Linux; Grok, Muse Code and the Antigravity CLI have
none there, so they need a custom image. Agent
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
docker compose stop
```

Back up all three volumes, including the complete SQLite data directory. Then:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

The image health check polls `/health`. Compose restarts exited containers;
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

Before connecting through the proxy, add its exact browser origin, such as
`https://boite.example.com`, to the core's `browserOrigins` setting. Connect the
desktop shell directly as an owner, select that machine, open Machines > Allowed
browser origins, and configure the origins there. Keep any existing origins that are
still needed. Origins contain a scheme, hostname and optional port, with no
path or trailing slash. See [machine connections](machines.md).

Preserving the proxy headers alone is not enough: an HTTPS origin on port 443
differs from the core listening on port 7337. An origin that is not allowed gets
HTTP 403 on `/rpc`, even when the pairing token is valid. Keep the allowlist
explicit; do not strip the `Origin` header to bypass this check.

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

## Building without Docker

```bash
bun run build:ui
bun run build:core:linux
```

That is `build:core` followed by `bun build --compile --target=bun-linux-x64`,
which writes `packages/core/dist/boite-core-linux-x64`: one executable for x64
glibc Linux that carries its own Bun. Cross-compiling works from Windows. Copy it
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

[Install]
WantedBy=default.target
```

Each process the core starts leads a process group of its own, and stopping a
thread signals that group: SIGTERM, then SIGKILL two seconds later to a group
that still has members. The core's own shutdown, on SIGTERM, SIGINT or SIGHUP,
does the same to every group and waits for it before it exits. A tool that
leaves the group on purpose (a daemon calling `setsid`) escapes it, and a core
killed hard leaves the groups it started running. Stopping the unit still reaps
them: systemd's default `KillMode=control-group` stops everything in the
service's cgroup, so keep that default and never set `KillMode=process`.

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

On the desktop, open Settings, Machines, and paste the link under Add machine.
The grant is spent on the first hello and the resulting key is stored in that
app. The server's projects join those of the local core and any other connected
machines. Disconnect forgets that host locally; Revoke on its paired-device list
invalidates the key. [machines.md](machines.md) covers the two thread views,
reconnection and the origins needed by a browser or phone.

A key paired with `--owner` says hello as the owner, so it reaches every method:
accounts, projects, settings, minting more links. The server lists it among the
paired devices tagged full control, and revokes it like any other.

## What changes when the core is elsewhere

- Paths are the server's. The native folder picker is hidden while the shell
  drives a core that is not its own, and a project is added by typing the path
  on the server.
- Agent logins happen on the server, for the account running the core. A login
  that opens a browser needs a way to reach that browser, which a headless
  machine does not have; the device-code flows in [accounts.md](accounts.md)
  work.
- The trace, the CPU and memory caps, the focus guard and the audio mute are
  Windows work today. [trace.md](trace.md) says what Linux gets.
