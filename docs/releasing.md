# Releasing

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
on a pushed `v*` tag, one job per platform. It signs the update payloads and
opens a **draft** release: clients see nothing until you publish it.

## Cutting a release

Bump the version in the nine places that carry it:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- every `crates/*/Cargo.toml`: `boite-core`, `boite-identity`,
  `boite-agent-api`, `boite-server`, `boite-mcp`, `boite-pilot`

Commit, then tag `vX.Y.Z` and push the tag. The `verify` job checks all of them
against each other and against the tag before a single runner starts building.
It globs the Cargo manifests rather than listing them, so a crate added to the
workspace is covered the day it lands.

## The test suite, once

Nothing gets signed without a green ci on that exact tree, and nothing runs it
twice for the privilege. A `preflight` job asks the API whether ci has already
succeeded on the tagged sha, which it has whenever the bump commit went through
master first, and the `tests` job is skipped when the answer is yes. Tag a
commit no branch ever carried and the whole suite runs on the tag instead.

## Signing

No key is needed on your machine. The keypair already exists: its public half is
in `plugins.updater.pubkey`, its private half is the `TAURI_SIGNING_PRIVATE_KEY`
repository secret, with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Anyone who can
push a tag can ship a signed release. **Never sign locally.**

That keypair is permanent from 1.0.0 on, and there is one for the whole project
rather than one per maintainer: the public key is compiled into every binary in
the wild, so a second key would orphan every existing install. There is no
revocation and GitHub secrets cannot be read back, so losing the private key
ends updates forever. An offline copy is held outside GitHub.

A `prune` job removes the `.sig` assets once every platform has uploaded. They
are duplicates: `latest.json` carries each signature inline and is the only file
the updater fetches.

## Android

The `android` job builds `mobile/` after every platform has uploaded and puts
`boite-X.Y.Z.apk` on the same release. Three repository secrets sign it:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE` | the release keystore, base64: `base64 -w0 android.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | its password |
| `ANDROID_KEY_PASSWORD` | the key's own password, only when it differs |

The alias is read from `mobile/twa-manifest.json`. With no keystore secret the
job uploads `boite-X.Y.Z-unsigned.apk` and says so as a warning, so a release
is not held back for it.

A release that leaves `mobile/` untouched does not rebuild: the job takes the
signed APK from the newest published release that carries one, under its
original name, since the version gradle baked into it names the tag it was
built from. `boite-1.3.1.apk` sitting on a later release page is that reuse,
not a mistake. Touch anything under `mobile/`, or publish no signed APK yet,
and it builds.

The job compares the certificate it just signed with against the fingerprint
in `mobile/assetlinks.json` and fails on a mismatch. That file is what
`boite-server` publishes at `/.well-known/assetlinks.json`, and an APK signed
with any other key opens in a Custom Tab with a URL bar on every phone, with
nothing else to say why.

## Telemetry

The desktop jobs and the GHCR image both compile `BOITE_TELEMETRY_URL` into
the binary (`option_env!` in `boite-core`). The value is the Worker base URL,
no `/track`. It lives in the `BOITE_TELEMETRY_URL` repository secret, the
same one `release.yml` and `image.yml` inject. Empty or unset compiles
against `https://telemetry.invalid`: the host sends nothing, and export or
deletion fail instead of returning empty success.

A local `docker compose build` without `--build-arg BOITE_TELEMETRY_URL`
is that inert image on purpose. Do not bake a Worker URL into a laptop
build you will then push.

## Sidecar

`scripts/build-sidecar.mjs` builds `boite-mcp` before every bundle and names it
for the triple being built *for*, not the host triple. The macOS release jobs
cross-compile, so using the host triple there would fail the bundle.
