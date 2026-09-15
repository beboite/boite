# Contributing

Read [AGENTS.md](AGENTS.md) for the code boundaries and
[development.md](docs/development.md) for the test setup.

Use the Bun version in `package.json` and install with
`bun install --frozen-lockfile`. Windows desktop builds also need Rust and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Keep a change focused on one problem. Explain what happens before and after it,
and include the commands you ran. UI changes need desktop and phone captures.
Do not include credentials, pairing links, personal paths or provider transcripts
in reports or fixtures.

Before submitting:

```sh
bun run check
bun run test
```

For a desktop or integration change, build and test the complete app:

```sh
bun run test:shell
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
bun run e2e
```

Tests use temporary data directories and the echo provider. Live-provider tests
are opt-in because they use real accounts and spend tokens. Never point a test
at an existing installation's data directory.

For server packaging, run the Docker smoke test described in
[server.md](docs/server.md). For CI and release behavior, see [ci.md](docs/ci.md).
