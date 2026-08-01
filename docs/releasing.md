# Releasing

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
on a pushed `v*` tag, one job per platform. It signs the update payloads and
opens a **draft** release: clients see nothing until you publish it.

## Cutting a release

Bump the version in the six places that carry it:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `crates/boite-core/Cargo.toml`
- `crates/boite-server/Cargo.toml`
- `crates/boite-mcp/Cargo.toml`

Commit, then tag `vX.Y.Z` and push the tag. The `verify` job checks all six
against each other and against the tag before a single runner starts building.

## Signing

No key is needed on your machine. The keypair already exists: its public half is
in `plugins.updater.pubkey`, its private half is the `TAURI_SIGNING_PRIVATE_KEY`
repository secret, with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Anyone who can
push a tag can ship a signed release. **Never sign locally.**

That keypair is permanent from 1.0.0 on, and there is one for the whole project
rather than one per maintainer: the public key is compiled into every binary in
the wild, so a second key would orphan every existing install. Replacing it was
free only while no release existed. GitHub secrets cannot be read back and there
is no revocation, so losing the private key ends updates forever and leaking it
cannot be undone. An offline copy is held outside GitHub.

## Sidecar

`scripts/build-sidecar.mjs` builds `boite-mcp` before every bundle and names it
for the triple being built *for*, not the host triple. The macOS release jobs
cross-compile, so using the host triple there would fail the bundle.
