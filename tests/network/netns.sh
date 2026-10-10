#!/usr/bin/env bash
# Fake home network and fake Tailscale tailnet in unprivileged namespaces.
# Usage: unshare -rmnu --propagation private bash netns.sh <command...>
set -euo pipefail
mount -t tmpfs none /run
mkdir -p /run/netns
for ns in srv lan-phone lan-desk ts-phone ts-desk; do ip netns add "$ns"; done
ip link set lo up
ip link add br-lan type bridge forward_delay 0; ip link set br-lan up
ip link add br-ts mtu 1280 type bridge forward_delay 0; ip link set br-ts up

# The server first gets the adapters a Windows PC with VMware and WSL has,
# so they come before the real LAN in interface order.
ip -n srv link add vmnet8 type dummy
ip -n srv addr add 192.168.196.1/24 dev vmnet8
ip -n srv link set vmnet8 up
ip -n srv link add vEthernet type dummy
ip -n srv addr add 172.25.112.1/20 dev vEthernet
ip -n srv link set vEthernet up

attach_lan() { # ns ip
  ip link add "l-$1" type veth peer name eth0 netns "$1"
  ip link set "l-$1" master br-lan up
  ip -n "$1" addr add "$2/24" dev eth0
  ip -n "$1" link set eth0 up
  ip -n "$1" link set lo up
}
attach_ts() { # ns ip
  ip link add "t-$1" mtu 1280 type veth peer name tailscale0 netns "$1"
  ip link set "t-$1" master br-ts up
  ip -n "$1" link set tailscale0 mtu 1280 up
  ip -n "$1" addr add "$2/32" dev tailscale0
  ip -n "$1" route add 100.64.0.0/10 dev tailscale0
  ip -n "$1" link set lo up
}
attach_lan srv 192.168.50.10
attach_ts srv 100.80.1.10
attach_lan lan-phone 192.168.50.20
attach_lan lan-desk 192.168.50.30
attach_ts ts-phone 100.80.1.20
attach_ts ts-desk 100.80.1.30

# The home router: every LAN host routes the internet through it.
ip addr add 192.168.50.1/24 dev br-lan
for ns in srv lan-phone lan-desk; do ip -n "$ns" route add default via 192.168.50.1; done

# MagicDNS: the tailnet name of the server.
cp /etc/hosts /run/hosts
printf '100.80.1.10 boite-srv.tail-fake.ts.net boite-srv\n' >> /run/hosts
mount --bind /run/hosts /etc/hosts
# A tailnet through a DERP relay: BENCH_TS_NETEM="delay 150ms 50ms loss 3%" say.
if [ -n "${BENCH_TS_NETEM:-}" ]; then
  for dev in t-srv t-ts-phone t-ts-desk; do "${TC:-tc}" qdisc add dev "$dev" root netem $BENCH_TS_NETEM; done
fi

# Wait for every veth to carry: an address on a link still coming up is not listed.
for ns in srv lan-phone lan-desk ts-phone ts-desk; do
  for _ in $(seq 50); do
    ip -n "$ns" -br link | awk '$2 == "DOWN" { down = 1 } END { exit down }' && break
    sleep 0.1
  done
done
exec "$@"
