# Secrets

Secret Drop is a temporary tunnel from a masked card to one file operation or
command. The core holds the value in process memory only. It never saves it in
DPAPI, Keychain, Secret Service, the journal or logs, and never sends the value
to the agent as a result. There is no project key store or keep option.

The implementation is `packages/core/src/secrets/`, `secret-cli.ts`, and the UI
component `SecretCard.svelte`.

## The flow

1. The agent runs `boite secret ask API_KEY --why "to call the billing API"`.
2. The user enters a value on the masked card and sends it, or declines.
3. The command prints `saved secret:<id>`, `declined`, `cancelled` or `timed_out`.
4. The agent passes the ref to one `write`, `run` or `pipe` operation.

```sh
boite secret ask <NAME> --why <reason> [--placeholder <example>] [--timeout <minutes>]
boite secret write <ref> --env-file <path> --key <VAR> [--allow-unignored]
boite secret run <ref> --as <VAR> -- <cmd> [args ...]
boite secret pipe <ref> -- <cmd> [args ...]
```

Names are uppercase letters, digits and `_`, starting with a letter, at most
64 characters. Values are 1 to 16,384 UTF-8 bytes. No CLI result includes one.

## Lifetime

Every fresh request opens a card. A ref belongs only to the conversation,
project and running turn that requested it. It is consumed atomically when a
use begins, including an operation that subsequently fails; concurrent calls
cannot reuse it. A new operation needs a new card and ref.

Unused values are wiped after ten minutes, when the requesting turn ends,
when the conversation is archived or removed, when its project is removed,
or when the core stops, whichever comes first. A restart loses every ref.
The timer erases expired values automatically; `use` also checks the deadline
before handing anything to a command. The buffer held during an operation is
wiped when that operation finishes.

The pending card waits ten minutes by default, with `--timeout` from 1 to 60
minutes. This deadline covers answering the card, not the value's lifetime.
Stop, turn completion, disconnecting the last waiting `ask` client, and timeout
close an unanswered card. A retried request with the same request ID gets its
original card or receipt; a consumed or expired receipt cannot revive a value.

Only pending card locations are persisted in `<data>/secrets/index.json`, so
startup can close cards left open by a crash. New transit values and their
metadata never enter that index.

## Destinations

- `run` gives the value to one command as the environment variable `VAR`.
- `pipe` gives it to one command on standard input.
- `write` sets `VAR=<value>` in an env file, preserving other lines and line
  endings. The destination must be inside the conversation's folder, untracked
  by git and ignored unless `--allow-unignored` is explicit. Special characters
  are quoted for dotenv parsers. The destination file remains after delivery:
  it is a file the operation requested, not a Boite secret store.

Commands use `procs.spawnPiped`, run inside the conversation's folder, and
return output with the value masked. Their default deadline is ten minutes,
an hour at most; a timed out command exits 124. Output is capped at 1 MB per
stream.

## Transport and card

Pending requests stay in the question dock above the composer, independently
of history paging. The timeline keeps only metadata and a receipt. The field
never becomes a composer draft. A value can travel only over loopback,
Tailscale or an HTTPS link; a phone on plain HTTP can decline but cannot send a
value. A group relay must also attest to its client's encrypted hop.

Agents can ask for and use refs only in their own conversation. Owners and
paired devices can read pending metadata and answer cards, with the encrypted
link requirement enforced by the real core.

## Migration from the project key store

Startup erases all legacy kept keys and transit copies without reading or
decrypting them. On Windows it deletes the sealed blob files, including
orphaned blobs it can enumerate. On macOS and Linux it deletes indexed entries
through the system tool; those backends cannot enumerate unindexed entries.
A failed deletion retains its cleanup metadata, logs a warning and retries
once a minute. An unavailable vault is never treated as successful deletion.
Legacy entries are never listed or usable, even while cleanup is pending.

The old `keep: true`, `replace: true` and project refs are refused. The legacy
`secrets.list` RPC and `boite secret list` remain compatible with older clients
and guides but always report no stored keys and memory-only storage.

## Masking and limits

The core retains keyed hashes, not values, for masking the conversation's
text, thinking, tools, terminal, process command lines, logs and diagnostic
exports. Hashes remain available after delivery until the core stops, so late
output is still masked. The exact and URL-encoded forms become `•••• (<NAME>)`.
Values shorter than eight bytes are not masked. Streamed chunks are masked
individually and completed messages are masked again; a value split across
chunks can appear while streaming, or when cut at an output limit.

Core-owned byte buffers are wiped. JavaScript strings from the received frame,
JSON parsing and environment blocks cannot be reliably zeroed and remain until
garbage collection. Memory-only storage does not protect against swap, crash
dumps or a compromised host.

The tunnel does not sandbox the receiving command. A shell can read a file it
was given, print an environment variable or transmit the value. Boite masks its
own recorded output, but tools that send a value to a model provider expose it
to that provider. Secret Drop does not erase a requested destination file or
control what the receiving command stores.
