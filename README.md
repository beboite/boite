<h1 align="center">boite <sub>[bwat]</sub></h1>
<p align="center">All your work and agents in one place</p>

<p align="center">
  <img src="apps/shell/src-tauri/icons-dev/128x128@2x.png" alt="boite logo" width="96" />
</p>

<p align="center">
  <a href="docs/server.md">Headless server</a> ·
  <a href="docs/updates.md">Updates and nightly</a> ·
  <a href="docs/development.md">Build from source</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="LICENSE">MIT license</a>
</p>

boite is an open-source desktop app and self-hosted server for AI agents.
Run Claude Code, Codex, Muse Code, OpenCode, Antigravity, Grok and pi in one chat interface,
using their own protocols and your existing accounts.

Keep a conversation per task. Switch models or accounts inside it, give it a
Git worktree, and follow the same work from your desktop or a paired phone.
The agents run on the computer that holds your project.

## What you can do

- Manage projects and conversations without keeping an agent process alive for
  every open thread.
- Change providers mid-conversation with bounded context from the journal.
- Read streaming answers, tool calls, reasoning and permission requests together.
- Queue tasks with global and per-account concurrency limits.
- Pair a phone with the web app, or connect the desktop to a headless server.
- Download desktop updates in the background, read their release notes and
  restart when ready. Switch between Boite and boite de nuit in General settings.
- Dictate prompts, attach files, browse project changes and manage tasks beside
  the conversation.
- On Windows, trace agent processes and their resource use, mute their audio and
  stop their windows from taking focus.

## Get started

boite is in beta. Download the Windows x64 installer from
[GitHub Releases](https://github.com/beboite/boite/releases). Choose a regular
release for Boite or a `nightly` prerelease for boite de nuit. The nightly workflow
publishes changed commits daily at 03:23 UTC after its checks pass.

Both update channels keep the same projects, accounts and conversations. General
settings lets you switch channels and shows download progress, release notes and
the installed version. Updates are signed and download automatically; installing
one asks before restarting. [Desktop updates](docs/updates.md) covers the details.

Linux and macOS desktop packages are built and smoke-tested in CI on x64 and
ARM64; their public installers and automatic updates are not published yet.
The headless core runs on Linux and macOS too, with more limited process tracking
than on Windows.

For a local build, install the Bun version named in `package.json`, then:

```sh
bun install --frozen-lockfile
bun run build:ui
bun run dev:core
```

In another terminal, create a one-time pairing link and open it in your browser:

```sh
bun packages/core/src/main.ts pair --owner
```

Install and authenticate the agents you want to use on that computer. Configure
them in Settings, Providers. See [accounts](docs/accounts.md) and
[provider support](docs/providers.md).

For building an installer, see [building and releasing](docs/releasing.md).
For Docker, persistent storage and image updates, see the
[boite-server guide](docs/server.md).

## Development

Built with Bun, TypeScript, Svelte 5 and Tauri 2. The core runs the agents and
owns the journal; the desktop shell and web app use the same RPC contract.

```sh
bun run dev:ui       # append ?fake=1 to the URL for a UI without an agent
bun run check
bun run test
```

[Contributing](CONTRIBUTING.md) covers setup and checks.
[Architecture](docs/architecture.md) explains the boundaries.
[Development](docs/development.md) covers integration tests and hidden captures.

## Thanks

Thanks to [T3 Code](https://github.com/pingdotgg/t3code) for the inspiration behind
boite. We definitely took stuff from there, shoutout to them!

This project also follows
[Boite Legacy](https://github.com/beboite/boite-legacy), the earlier terminal-based app.

## License

[MIT](LICENSE). Copyright © 2026 boite contributors.
