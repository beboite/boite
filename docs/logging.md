# Logging

One log, four hosts, one clock. This is how to read it, and what it costs to
write to it.

The point of the whole thing is that "what happened to thread X" is one
question with one answer. Before it, the desktop wrote a flat file with no
thread in it, `boite-server` printed to a stderr nobody keeps, and `boite-mcp`
wrote nothing at all.

## Reading it as an agent

The `logs` MCP tool. Two actions:

- `action: "tail"` reads the last records the host still has in memory (2000 of
  them). Instant, no file read, and it only ever has this host's own records.
- `action: "query"` reads the files of every host in the log directory, current
  and rotated, and merges them on `ts`. The only way back past a restart.

Filters, the same on both the tool and the bus:

| Filter | What it does |
|---|---|
| `level` | This level and worse. `warn` answers warnings and errors. |
| `host` | `desktop`, `server`, `mcp` or `webview`. Omit for all four. |
| `thread` | One terminal, by thread id. Exact match. |
| `turn` | One agent turn. |
| `target` | A prefix of the Rust module path, so `boite_core` catches its children. |
| `text` | Case-insensitive, matched against the message and the fields. |
| `since`, `until` | Unix milliseconds, inclusive. |
| `limit` | Default 100, max 1000. `tail` is capped by the ring at 2000. |

### Three questions, worked

**What happened to thread X.** Everything any host said about that terminal, in
order, whichever host said it:

```
logs action=query thread=8f3a1c92-... limit=200
```

**Every warning of the last ten minutes.** `since` is a unix millisecond stamp;
`workspace_snapshot` carries a `takenAtMs` you can subtract from.

```
logs action=query level=warn since=<now - 600000>
```

**The spawn and the exit of every child.** Both are logged from
`boite_core::pty`, at `info`, with the pid:

```
logs action=query target=boite_core::pty text=pty. limit=200
```

A spawn reads `pty.spawned [thread=<id> pty=<id> pid=<pid> cwd=<dir> cmd=<argv>]`
and its exit reads `pty.exited [thread=<id> pty=<id> pid=<pid> code=<code>]`. The
`pty` id is what pairs the two.

## The record

One JSON object per line. The field names are single words and are the same in
the file, on the wire and in the tool's output:

```json
{"ts":1756000000000,"seq":12,"host":"server","level":"warn",
 "target":"boite_server::ws","msg":"rpc.failed",
 "thread":"t-7","device":"phone-1","span":"rpc",
 "fields":{"method":"git.commit","reason":"not a repository"}}
```

`ts` is unix milliseconds and `seq` is a per-process counter, so two records in
the same millisecond keep their order. `thread`, `turn`, `request` and `device`
are top level on purpose: a filter never has to parse `fields`.

Absent fields are absent rather than null, so a record with no ids is five keys
long.

## Where the files are

`<log dir>/<host>.jsonl`, rotated at **8 MB**, keeping **two** previous
generations (`<host>.1.jsonl`, `<host>.2.jsonl`). So one host costs at most
24 MB and always has at least 8 MB of history.

| Host | Log directory |
|---|---|
| `desktop` | The Tauri app log dir: `%LOCALAPPDATA%\com.boite.desktop\logs` on Windows, `~/Library/Logs/com.boite.desktop` on macOS, `$XDG_DATA_HOME/com.boite.desktop/logs` elsewhere. |
| `server` | `--log-dir`, else `BOITE_LOG_DIR`, else the desktop directory above. |
| `mcp` | The same three, in the same order. A machine with no such directory logs nowhere rather than failing the sidecar. |
| `webview` | No file of its own: its records go through the bus (`logs.write`) and land in whichever host answered. |

They all default to one directory on purpose. That is what makes `query` a
merge rather than four separate reads.

## Writing to it, from Rust

The `tracing` macros, with the ids as fields:

```rust
tracing::info!(thread = %id, pid, "pty.spawned");
```

`thread`, `turn`, `request` and `device` are lifted to the top level of the
record, from the event or from any span around it, innermost span first. So a
caller that opens `bus.call{method, thread}` never repeats the thread on the
events inside it. Everything else lands in `fields`. The innermost span's name
lands in `span`.

The message is the first positional argument and reads best as an event name
(`pty.spawned`, `rpc.failed`) rather than a sentence: it is what `text=` matches
on, and a sentence with a path in it matches nothing twice.

## Level

`BOITE_LOG`, in `EnvFilter` syntax:

```
BOITE_LOG=warn                          everything at warn and worse
BOITE_LOG=info,boite_core::pty=debug     info, plus one target louder
BOITE_LOG=boite_server=debug,warn        one crate at debug, the rest at warn
```

With `BOITE_LOG` unset the default is `info`, plus `boite_pilot=debug` and
`boite_core::command=debug` in a debug build. A release build never turns those
on by itself.

`logs.level` on the bus reads it with no argument and sets it with
`directives`, without a restart. The whole directive, not one target:
`EnvFilter` cannot amend itself.

## Redaction

Applied on the way in, to `msg` and to every string field, so what is in the
file is already safe to paste into an issue:

- anything shaped like an address becomes `<email>`, the local part included:
  `firstname.lastname@` is a person;
- a directory that is the user's becomes the name of the variable that holds it
  (`%USERPROFILE%`, `%LOCALAPPDATA%`, `$HOME` and the others), so a reader still
  sees which directory it was without seeing whose.

## The bus

`logs.tail`, `logs.query`, `logs.level`, `logs.write`, `logs.subscribe`. The
reads and `logs.subscribe` need `read`; `logs.write` and `logs.level` need
`write`: a read-only device turning on `trace` costs every other device the
bytes.

`logs.subscribe` makes the server push `log.record` events at that device,
coalesced into batches of up to 50 records or every 250 ms. One event per record
would put a broadcast on the log's own write path.

## What is logged today

Deliberately little. The sweep over the rest of the code is its own job.

- Every command the bus refuses or fails, once, at the codec, at `warn`, with
  the method, plus the thread and the device on the server, which knows both.
- Every RPC handler that fails on the server, at `warn`, with the device.
- Every PTY spawned and every PTY that exited, at `info`, with the thread and
  the pid.
- Everything the desktop already wrote through `logging::append_app_log`, and
  every panic.
