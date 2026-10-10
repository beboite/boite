# Network bench

A fresh pairing over the networks a real setup has, on Linux, without root. A
user namespace gives `ip` its powers over private network namespaces, so
nothing on the host changes.

```sh
cd tests/network
unshare -rmnu --propagation private bash netns.sh bash -c 'hostname DESKTOP-W10SRV && bun run.ts .artifacts'
```

`netns.sh` builds the networks, then runs the command inside them:

- `srv` is the server. It has the adapters of a Windows PC with VMware and WSL
  (`vmnet8` 192.168.196.1, `vEthernet` 172.25.112.1) listed before its LAN
  card (`eth0` 192.168.50.10), and a tailnet address (`tailscale0`
  100.80.1.10/32, MTU 1280).
- `lan-phone` and `lan-desk` share the LAN through a bridge. 192.168.50.1 is
  the home router and their default route.
- `ts-phone` and `ts-desk` have a tailnet address and nothing else: they reach
  the server only through 100.64.0.0/10.
- `/etc/hosts` stands in for MagicDNS: `boite-srv` and
  `boite-srv.tail-fake.ts.net` name 100.80.1.10.

`run.ts` starts a core with `--lan` on the server, creates an Echo thread and a
group. Each phone gets a new pairing link, as the pairing card mints it, and
each desktop a group invitation; `client.ts` then runs in the client's
namespace:

- a phone: Chrome at 412x915 with an Android user agent and touch, opening the
  pairing link;
- a desktop shell: Chrome serving the UI from `http://tauri.localhost`, the
  origin WebView2 gives the Windows shell, with the shell's own CSP read from
  `tauri.conf.json`. Its own core joins the server's group with an invitation,
  as Settings, Machines does, then it opens a picture from the server's
  folder in the panel.

Each client sends a prompt and waits for the answer, reloads, loses its link for
20 seconds while reading the thread (a phone also while on its list), and sends again.
Captures and one JSON line per scenario land in the output directory.

Options:

- `BENCH_ONLY=phone-ts,desktop-lan` runs the scenarios whose label contains one
  of the words.
- `BENCH_TS_NETEM="delay 150ms 50ms loss 3%"` turns the tailnet into a slow
  relay. It needs `tc`; without iproute2's `tc` installed, extract it from the
  package (`apt-get download iproute2`, `dpkg-deb -x`) and set `TC=<path>`.

Chrome runs with `--no-sandbox` here, because it is uid 0 inside the user
namespace. The pages it opens are the bench's own.
