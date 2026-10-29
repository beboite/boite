#!/data/data/com.termux/files/usr/bin/bash
# Installs Boite server in Termux (docs/android-server.md). The Boite Server
# app shows the command that runs it:
#
#   curl -fsSL https://raw.githubusercontent.com/mtsu-dev/boite/main/apps/android-server/termux/install.sh | bash -s -- --channel stable
#
# It installs the Termux packages the agents need, the Bun build for Android
# pinned below, and the `boite-server` command. That command then downloads the
# signed release and Claude Code, and starts the core. Running it again
# updates everything and keeps the conversations.
set -euo pipefail

# The Bun every release runs on: android-server-bundle.ts copies this pin into
# server-release.json, so an update downloads the same build.
BUN_VERSION=1.4.4
BUN_SHA256=d72e42c60e895ccbc16144bb1e0e0ad7ee384841c35b5501a7ec28b4d6d759c9

REPOSITORY=mtsu-dev/boite
REF=main
CHANNEL=stable
BUNDLE=
CLAUDE=1

fail() { printf 'boite-server install: %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL=${2:-}; shift 2 ;;
    --ref) REF=${2:-}; shift 2 ;;
    --bundle) BUNDLE=${2:-}; shift 2 ;;
    --no-claude) CLAUDE=0; shift ;;
    *) fail "unknown option $1 (expected --channel stable|nightly, --ref <git ref>, --bundle <zip> or --no-claude)" ;;
  esac
done
case "$CHANNEL" in stable|nightly) ;; *) fail "--channel must be stable or nightly, got '$CHANNEL'" ;; esac
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "--ref must be a branch, tag or commit, got '$REF'"
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || fail "--bundle $BUNDLE is not a file"
  BUNDLE=$(realpath "$BUNDLE")
fi

[ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ] && [ -n "${TERMUX_VERSION:-}" ] \
  || fail "run this in the Termux app (https://termux.dev), not in adb shell or another terminal"
[ "$PREFIX" = /data/data/com.termux/files/usr ] \
  || fail "Termux must run as the phone's main user with its usual prefix /data/data/com.termux/files/usr, found $PREFIX"
[ "$(uname -m)" = aarch64 ] \
  || fail "this phone's processor is $(uname -m); Boite server needs a 64-bit ARM phone (aarch64)"
sdk=$(getprop ro.build.version.sdk 2>/dev/null || echo 0)
[ "$sdk" -ge 24 ] || fail "Android 7.0 or later is required, this phone runs API level $sdk"

ROOT="$HOME/.boite-server"
mkdir -p "$ROOT/bin" "$ROOT/runtime" "$ROOT/downloads"
chmod 700 "$ROOT"

step "Termux packages"
export DEBIAN_FRONTEND=noninteractive
# Termux supports no partial upgrade: packages installed onto an older system
# can miss the libraries they were built against. A changed configuration file
# keeps the person's version.
apt=(apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
"${apt[@]}" update </dev/null
"${apt[@]}" full-upgrade </dev/null
"${apt[@]}" install git ripgrep curl unzip glibc-repo </dev/null
"${apt[@]}" update </dev/null
# glibc-runner provides the loader Claude Code's Linux build runs on.
"${apt[@]}" install glibc-runner </dev/null
if ! "${apt[@]}" install codex </dev/null; then
  printf 'Codex is not in this Termux repository; Boite runs without it.\n' >&2
fi

step "Bun $BUN_VERSION for Android"
runtime="$ROOT/runtime/bun-$BUN_VERSION"
if [ ! -x "$runtime/bun" ]; then
  work=$(mktemp -d "$ROOT/downloads/bun.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  curl -fL --retry 3 --progress-bar -o "$work/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-aarch64-android.zip"
  digest=$(sha256sum "$work/bun.zip" | cut -d' ' -f1)
  [ "$digest" = "$BUN_SHA256" ] || fail "bun-linux-aarch64-android.zip $BUN_VERSION hashes to $digest, expected $BUN_SHA256"
  unzip -q "$work/bun.zip" -d "$work"
  mkdir -p "$runtime"
  install -m 755 "$work/bun-linux-aarch64-android/bun" "$runtime/bun"
  rm -rf "$work"
  trap - EXIT
fi
ln -sfn "$runtime/bun" "$ROOT/bin/bun"
"$ROOT/bin/bun" --version >/dev/null || fail "Bun $BUN_VERSION does not start on this phone"

step "The boite-server command"
controller="$ROOT/boite-server.ts"
if [ -n "$BUNDLE" ]; then
  unzip -p "$BUNDLE" boite-server.ts >"$controller.tmp"
else
  curl -fsSL --retry 3 -o "$controller.tmp" "https://raw.githubusercontent.com/$REPOSITORY/$REF/apps/android-server/termux/boite-server.ts"
fi
[ -s "$controller.tmp" ] || fail "could not get boite-server.ts"
mv -f "$controller.tmp" "$controller"
cat >"$PREFIX/bin/boite-server" <<EOF
#!$PREFIX/bin/sh
# Written by the Boite server installer.
exec "$ROOT/bin/bun" "$controller" "\$@"
EOF
chmod 755 "$PREFIX/bin/boite-server"

# The Boite Server app starts and stops the server through Termux's RUN_COMMAND
# intent, which Termux refuses until this property is set.
properties="$HOME/.termux/termux.properties"
mkdir -p "$HOME/.termux"
touch "$properties"
if grep -Eq '^[[:space:]]*allow-external-apps[[:space:]]*=' "$properties"; then
  sed -i -E 's/^[[:space:]]*allow-external-apps[[:space:]]*=.*/allow-external-apps = true/' "$properties"
else
  printf '\n# Lets the Boite Server app run boite-server.\nallow-external-apps = true\n' >>"$properties"
fi
termux-reload-settings 2>/dev/null || true

step "Boite"
args=(install --channel "$CHANNEL")
[ -n "$BUNDLE" ] && args+=(--bundle "$BUNDLE")
[ "$CLAUDE" = 1 ] || args+=(--no-claude)
"$PREFIX/bin/boite-server" "${args[@]}"

step "Done"
printf 'Open the Boite Server app to pair a computer, or run: boite-server pair --owner\n'
