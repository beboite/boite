# A core on a server

The core is a Bun program with no window, so it runs as well on a Linux machine
nobody sits at as it does beside the desktop shell. The agents it starts run on
that machine too, under the account that runs the core, with that account's
logins and that machine's files. The desktop app on another computer drives it
through a pairing key; the phone reaches it the same way it reaches any core.

## Building it

```bash
bun run build:core:linux
```

That is `build:core` followed by `bun build --compile --target=bun-linux-x64`,
which writes `packages/core/dist/boite-core-linux-x64`: one executable for x64
glibc Linux that carries its own Bun. Cross-compiling works from Windows. Copy it
to the server with `packages/ui/dist` beside it, renamed `ui`, since a compiled
core looks for the UI next to its own executable:

```
~/.local/lib/boite/
  boite-core      (the executable, mode 755)
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

The data directory is `~/.local/share/boite2`, or `$XDG_DATA_HOME/boite2`: the
journal, the accounts, `core.json` with the core token (mode 600) and `core.lock`.

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
