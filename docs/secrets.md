# Secrets

An agent that needs an API key asks for it on a card with a masked field, then
uses it by ref. The value goes from the card to the system vault and from the
vault to a file or a command. It never passes through the chat, the model's
prompt or the agent's output. The code is `packages/core/src/secrets/` for the
store, `platform/secret-vault.ts` for the vaults, `secret-cli.ts` for
`boite secret`, and `SecretCard.svelte` for the card.

## The flow

1. The agent runs `boite secret list`. A key the project already keeps is used
   by its ref, with no card.
2. Otherwise it runs `boite secret ask API_KEY --why "to call the billing API"`.
   A card opens in the conversation with a masked field, the reason, and a
   **Keep for this project** box, unticked.
3. The user pastes the key and saves, or declines. The value is in the vault
   before the card shows "saved".
4. The command prints one line: `saved secret:<ref>`, `declined`, `cancelled`
   or `timed_out`.
5. The agent hands the ref to `boite secret write`, `run` or `pipe`.

```sh
boite secret list
boite secret ask <NAME> --why <reason> [--placeholder <example>] [--timeout <minutes>] [--replace]
boite secret write <ref> --env-file <path> --key <VAR> [--allow-unignored]
boite secret run <ref> --as <VAR> -- <cmd> [args ...]
boite secret pipe <ref> -- <cmd> [args ...]
```

`NAME` is upper case: a letter, then letters, digits and `_`, at most 64. No
command prints a value, and `--json` gives the same fields without one.

- `write` sets `VAR=<value>` in an env file and keeps the file's other lines
  and line endings. A value with spaces, quotes, `$`, `#` or a backslash is
  double-quoted and escaped the way dotenv parsers read it. The file must be inside the conversation's folder,
  not tracked by git, and ignored by git unless `--allow-unignored` is passed.
  A refusal names the field and the expected value.
- `run` starts the command with the value in the environment variable `VAR`.
- `pipe` writes the value to the command's standard input.

`run` and `pipe` go through `procs.spawnPiped`, like every agent process, in
the conversation's folder or a `cwd` inside it. They print the command's output
with the value masked and exit with its code. A command still running after 10
minutes is stopped and exits 124. The output kept is cut at 1 MB per stream.

## Refs

| Ref | Made when | Lasts until |
|---|---|---|
| `secret:<id>` | the box is unticked (the default) | the conversation is archived or removed, 24 hours pass, or a core with a memory vault restarts |
| `secret:project/<NAME>` | the box is ticked | the user deletes it in project settings, or the project is removed |

A transit copy belongs to the conversation that asked and to its project. It
can be used several times until it is erased. A use from another conversation
or another project is refused, and the ref still works in its own.

A kept key serves every conversation of its project. `ask` on a name the
project keeps returns its ref without a card. `ask --replace` shows the card
again, and the old key is replaced only when the user saves the new one;
ticking the box on a name the project keeps is a replace too. Each use updates
the key's `lastUsedAt`, which project settings show.

The core sweeps at startup and when the next transit copy expires: it erases
expired copies and copies whose conversation is archived or gone. The DPAPI and
memory vaults can list their entries, so the sweep also erases the ones no
index line names. The Keychain and Secret Service vaults cannot, so an entry
whose erasure failed stays there.

## The card

Pending secret requests share the question dock above the message box. They
stay visible while the user reads older output, and the timeline keeps a link
back to the request. Answered requests leave a one-line receipt. The dock reads
pending metadata independently of history pages, including after reconnecting;
no secret value enters that snapshot or the ordinary composer.

A card can be answered once, and only while the turn that asked is running. The
turn ending, the user pressing Stop, the agent's command being killed, or the
timeout (10 minutes, `--timeout` up to 60) closes it as `cancelled` or
`timed_out`. A core that stops with a card open closes it as `cancelled` when
it starts again.

Answering with a value needs an encrypted link: the desktop app, loopback, an
HTTPS page or a Tailscale address. A phone on plain HTTP sees the card with
"Answer from the PC or over HTTPS", can decline, and cannot send a value. The
Tailscale check is by the socket's address, and counts only while this machine
is on a tailnet. A phone relayed by another machine of the group counts only
when its hop to that machine was encrypted too: the relaying machine says so in
the `X-Boite-Relayed-Link` header.

## Permissions

| Method | Owner | Agent | Paired device |
|---|---|---|---|
| `secrets.ask`, `secrets.use` | yes | its own conversation | no |
| `secrets.list` | yes | its own project | yes |
| `secrets.answer` with a value | over an encrypted link | no | over an encrypted link |
| `secrets.answer` declining | yes | no | yes |
| `secrets.delete` | yes | no | over an encrypted link |

The reasons are recorded beside `AGENT_METHODS` in `packages/core/src/access.ts`
and `DEVICE_METHODS` in `packages/contracts/src/access.ts`.

## The vault on each OS

| OS | Vault | Where |
|---|---|---|
| Windows | DPAPI (`CryptProtectData`, no prompt) | sealed `<id>.bin` blobs in `<data>/secrets/`, which open only for this Windows user on this machine |
| macOS | Keychain, through `security` | the login keychain, service `boite-secret` |
| Linux | Secret Service, through `secret-tool` | the session's keyring (GNOME Keyring, KWallet) |
| any | memory | this process only |

The vault loads when the first secret is saved or used, and at startup when
`<data>/secrets/index.json` exists: the startup sweep reads every stored value
back to restore the masks, which on macOS and Linux runs `security` or
`secret-tool` once per value. An entry it cannot read is logged and skipped,
not erased. When no system vault answers, Boite keeps values in memory, and `boite secret ask` and
`list` tell the agent that they are lost when Boite stops. On macOS and Linux
the value reaches the tool as hex on its standard input, never as an argument.

`<data>/secrets/index.json` holds names, ids, conversations and dates, never a
value.

Values are `Uint8Array` in the core and are zeroed with `fill(0)` after each
use. Some copies cannot be wiped: the JSON-RPC frame that carries the answer,
the JavaScript string it is parsed into, the environment block given to `run`,
and the buffers of a tool on macOS and Linux. They stay in memory until they
are collected.

## Masking

The exact value and its URL-encoded form become `•••• (<NAME>)` in:

- text, thinking and tool output that the agent's conversation records;
- the thread terminal's output;
- `run` and `pipe` output;
- the command lines of the conversation's processes, which the trace keeps,
  for a shell that expands the variable `run` gave it;
- Boite's own logs, and so diagnostics exports.

A transit copy masks its own conversation. A kept key masks every conversation
of its project. The masks hold a keyed hash of each value, not the value, under
a key drawn for each process, so after a restart the startup sweep reads the
values from the vault to build them again.

Values shorter than 8 bytes are not masked: masking them would hide ordinary
words in the conversation. Streamed text is masked per chunk, and each message
is masked again when it closes, so a value split across two chunks can show
while it streams. A value cut in two by the 1 MB output limit is not masked.

## What this is not

This is not a sandbox. An agent that can run a shell can `cat .env`, print the
variable inside `run`, or send the value anywhere; whatever it reads goes to
its provider like any other output. Masking hides the value in Boite's chat,
logs and exports, not in the provider's copy of the conversation. The card
keeps the key out of the chat; the agent's tools still decide what happens to
it next.
