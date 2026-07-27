# Agent and contributor guidelines

Read this before changing UI code. `README.md` covers the stack and the build
commands; this file covers the rules that are easy to break without noticing.

## Internationalization

Every user-facing string goes through the translation layer. No literal text in
a `.svelte` file, including `title`, `placeholder` and `aria-label`.

The dictionaries are TypeScript, not JSON, and the keys are flat:

- `src/lib/i18n/messages.ts` holds `EN_MESSAGES` and derives
  `MessageKey = keyof typeof EN_MESSAGES`.
- `src/lib/i18n/messages.fr.ts` is annotated `Record<MessageKey, string>`, which
  is the completeness check: adding an English key without a French one fails
  `bun run check`.

Both properties depend on the key being a literal at the call site:

```svelte
<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
</script>

<p>{t("setup.title")}</p>
<p>{t("setup.stepCount", { current: 1, total: 3 })}</p>
```

A template literal (`` t(`setup.${id}Desc`) ``) defeats both, and the typecheck
rejects it. When a key has to vary, put a `MessageKey` on the data instead:

```ts
export interface SetupRecommendation {
  descKey: MessageKey;
}
```

Key names are camelCase after the dot, matching what is already there
(`common.chooseFolder`, `setup.stepCount`). English doubles as the runtime
fallback for any key a locale is missing.

No third-party i18n library. The runes layer is a few dozen lines and the French
dictionary is loaded on demand, so it costs nothing on the boot path.

## Talking to the machine

Components never call `invoke` directly. Everything goes through `backend()`
(`src/lib/backend/`), which is `TauriBackend` locally and `RemoteBackend` over a
WebSocket when the boite is a server. A direct `invoke` silently does the wrong
thing on remote: it answers about the device holding the UI rather than the
machine actually running the agents, and in the browser PWA it just throws.

Adding a capability means four edits: the method on the interface in
`backend/types.ts`, the Tauri implementation, the remote implementation, and the
matching arm in `crates/boite-server/src/rpc.rs`.

## Before pushing

```bash
bun run check     # svelte-check + oxlint, must be clean
bun run test      # vitest
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
