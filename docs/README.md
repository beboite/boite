# Docs

One page per subject, each written from the code it describes. The rules
themselves live in [../AGENTS.md](../AGENTS.md), and what Boite 2 is plus the
build commands in [../README.md](../README.md).

- [development.md](development.md): running the core and the UI, the in-memory
  fake client, the echo provider, the checks, the tests, the capture route, the
  opt-in live tests, and the worktree trap that eats doc edits.
- [providers.md](providers.md): the descriptor format field by field, the
  load-time tokens, the OS profiles, the managed install block, the shipped
  providers, the models probe, and how each protocol takes a permission mode.
- [accounts.md](accounts.md): isolation directories, the default account that is
  the user's own login, the login flow and what the core refuses.
- [model-switching.md](model-switching.md): model, provider and account changes
  within a conversation, historical context limits and execution snapshots.
- [keybindings.md](keybindings.md): the chord grammar, every command and its
  default, the `keybindings.json` file the core watches, and what it refuses.
- [titles.md](titles.md): the three sources of a thread's title, the call the
  agent gets after the first turn, `Regenerate title`, and what is refused.
- [imports.md](imports.md): a Claude Code session brought in as a thread, where
  the transcripts are read from, what is kept, and the resume that follows.
- [context.md](context.md): the context meter in the header, where each
  agent's reading comes from, and the divider a compaction draws.
- [phone.md](phone.md): listening on the LAN, the one-time pairing link and the
  session it becomes, revoking a device, the service worker, what is cached and
  what never is, and the limits.
- [server.md](server.md): a core on a Linux machine with no window, the build,
  a systemd user unit, `boite-core pair --owner`, and the desktop app driving it.
- [trace.md](trace.md): Job Objects and exact process events, what the trace
  shows, the load, the CPU and memory caps, the focus guard, the audio mute, the
  settings that turn them off, and what Linux and macOS get today.
- [releasing.md](releasing.md): the build chain from the UI to the NSIS
  installer, what the installer holds, where it installs, and the order the
  shell looks for a core in.
- [releases/](releases/): one page per build handed to someone, what is inside,
  the known gaps and the resource tables of that build.
  [2.0.0-beta.1](releases/2.0.0-beta.1.md) is the first.
