# Releasing

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
on a pushed `v*` tag, one job per platform. It signs the update payloads and
opens a **draft** release: clients see nothing until you publish it.

## Cutting a release

Bump the version in the eight places that carry it:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- every `crates/*/Cargo.toml`: `boite-core`, `boite-identity`,
  `boite-agent-api`, `boite-server`, `boite-mcp`

Commit, then tag `vX.Y.Z` and push the tag. The `verify` job checks all of them
against each other and against the tag before a single runner starts building.
It globs the Cargo manifests rather than listing them, so a crate added to the
workspace is covered the day it lands.

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

## Sidecar

`scripts/build-sidecar.mjs` builds `boite-mcp` before every bundle and names it
for the triple being built *for*, not the host triple. The macOS release jobs
cross-compile, so using the host triple there would fail the bundle.
