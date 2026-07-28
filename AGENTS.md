# AGENTS.md

The rules that are easy to break without noticing. `README.md` has the stack and
the build commands, `docs/development.md` the isolated dev window and the MCP
bridge, `docs/releasing.md` the release process.

## Translations

No literal user-facing string in a `.svelte` file. `title`, `placeholder` and
`aria-label` included. Everything goes through `t()`.

The key has to be a literal at the call site: `MessageKey` is derived from
`EN_MESSAGES`, and `messages.fr.ts` is annotated `Record<MessageKey, string>`,
so an English key with no French twin fails `bun run check`. A template literal
defeats both checks at once. When a key must vary, put a `MessageKey` on the
data instead.

## Talking to the machine

Components never call `invoke`. Everything goes through `backend()`, which is
Tauri locally and a WebSocket when the boite is a server. A new capability is
four edits: `backend/types.ts`, the Tauri implementation, the remote one, and
the matching arm in `crates/boite-server/src/rpc.rs`. Miss one and it works on
this machine and fails on a remote boite, silently.

## Before pushing

```bash
bun run check
bun run test
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
