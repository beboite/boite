# boite-pilot

The runtime behind `runtime = 'pilot'` threads: a child agent process boite
talks to over the agent's own machine protocol, instead of a PTY it watches from
the outside. Design contract: [docs/pilot.md](../../docs/pilot.md).

```
src/lib.rs      Runtime: thread_id -> Session, the drivers, stop_all
src/driver.rs   Driver, Session, Capabilities, OpenSpec, the error type
src/event.rs    PilotEvent and the item / request / usage / status types
src/proc.rs     spawn, the Windows job object, the polite stop, fastpick
src/claude.rs   the stream-json driver
src/scripted.rs a driver that replays a scenario file
tests/          the fake claude binary, the scenarios, the captured wire
```

`boite-core` still takes no async runtime. This crate declares tokio, the host
owns the executor, and the bus stays synchronous.

## The event JSON

`PilotEvent` serializes tagged on `kind`, with the dotted names the store
writes into `pilot_events.kind`:

```json
{"kind":"item.delta","item_id":"msg_01ABC#0","text":"ok"}
{"kind":"turn.completed","turn_id":"turn_...","duration_ms":42,
 "usage":{"input_tokens":7,"output_tokens":4,"cache_read_input_tokens":0,
          "cache_creation_input_tokens":0,"total_cost_usd":0.001,
          "context_window":200000}}
```

The names are written out one by one in `event.rs` rather than derived from the
Rust identifier: renaming a variant would otherwise write a new value into an
old column with nothing failing. `PilotEvent::kind()` is the same list as a
match, so a rename breaks the build.

Two events are live only and `is_journaled()` says so: `item.delta` (one row per
token is the cost the design forbids) and `status.changed` (a reading, not a
fact).

**Fourteen kinds**, the same fourteen `docs/pilot.md` tables:
`session.started`, `session.exited`, `turn.started`, `turn.completed`,
`turn.aborted`, `item.started`, `item.delta`, `item.completed`,
`request.opened`, `request.resolved`, `status.changed`, `model.changed`,
`usage.updated`, `error`.

## What exists

`lib.rs` exports `Runtime`. `driver.rs` exports the two traits a host
implements against, `Driver` and `Session`, the two sinks it hands them,
`EventSink` and `SessionSink`, and the value types the bus builds: `OpenSpec`,
`Opened`, `Instance`, `Options`, `ExecMode`, `McpServer`, `ModelSelection`,
`SwitchKind`, `Capabilities`, `RequestAnswer`, `TurnId`, `TurnInput`,
`PilotError`. `event.rs` has the fourteen `PilotEvent` kinds and `Item`,
`ItemKind`, `Request`, `RequestKind`, `RequestOption`, `RequestOutcome`,
`Usage`, `Status`, `ExitReason`.

Two drivers ship: `claude.rs`, the stream-json one, and `scripted.rs`, which
replays a scenario file and is what every test that does not want a child
process runs against. codex, ACP and opencode are phase 1 and none of them has
a file here yet.

Two names to know outside the crate:

- `ItemKind::Notice`, serialized `notice`. A line boite wrote itself, not an
  agent: which instance and model answer after a restart. Its own kind rather
  than an `assistant_text`, which a pane draws as an answer, and not `error`,
  which is what a failure reads as. `boite_core::pilot::write_notice` is what
  writes one.
- `claude::NATIVE_MODELS`, the models a native claude instance can be asked
  for. A `const` slice to extend per release, never a fetch: the CLI has no
  endpoint that answers what an account may use, and a menu that opened on a
  network call would be empty whenever the network is. `pilot.catalog` reads it
  for the `claude` driver and answers an empty list for a driver that ships
  none.

## Item identity

An item id has to survive the gap between the frame that opens a card and the
frame that finishes it.

- Assistant text and reasoning: `<message id>#<block index>`. One assistant
  message can carry text and several tool calls, and each block is its own card.
- A tool call: the `tool_use` block's own id. The `tool_result` that completes it
  arrives in a later `user` message which names only that id, so an index would
  not find it.

## The claude wire, as pinned

Verified 2026-09-03 on this machine.

| What | Value |
|---|---|
| CLI | `claude 2.1.259 (Claude Code)`, from `claude --version` |
| Supported range | 2.1.259 to 2.1.260 |
| SDK read for the shapes | `@anthropic-ai/claude-agent-sdk` 0.3.259, `sdk.d.ts` and `sdk.mjs` |
| Real CLI run | yes, one turn, captured in `tests/fixtures/claude-2.1.259-hello.jsonl` |

The SDK version tracks the CLI version, which is why 0.3.259 is the one read
against 2.1.259.

**The supported range is 2.1.259 to 2.1.260.** The lower bound is the capture in
`tests/fixtures/`, which is the one CI replays. The upper bound is the CLI
installed on this machine today, and it is inside the range because no line of
`claude.rs` has had to change for it. Neither bound moves without a capture on
the new version: the argv and the two frame tables below are what a release is
free to break, and a fixture is the only thing that notices.

### The argv

`claude.rs::claude_argv` builds, in this order:

```
<bin...>
  --print --verbose
  --output-format stream-json --input-format stream-json
  --permission-prompt-tool stdio
  --include-partial-messages
  (--session-id=<thread id>  |  --resume=<native session id>)
  [--model <model>]
  --permission-mode <default|acceptEdits|bypassPermissions>
  [--allow-dangerously-skip-permissions]        # yolo only
  [--mcp-config <inline json>]
  [--append-system-prompt <text>]
```

- `--session-id` and `--resume` are exclusive: a resume names a conversation
  that exists, and passing both makes the CLI refuse the launch. The `=` form is
  what the SDK writes (`Y.push(\`--session-id=${...}\`)`), so it is what this
  driver writes.
- `--print` is not in the SDK's own argv: the SDK spawns the CLI through a path
  that implies it. It is passed here, `docs/pilot.md` names it, and the CLI takes
  it (the captured run used the argv above verbatim).
- `bypassPermissions` is refused unless the session also carries
  `--allow-dangerously-skip-permissions`, so yolo pushes both flags.
- `--mcp-config` takes the JSON inline, shaped `{"mcpServers": {name: {command,
  args, env}}}`.
- A fastpick instance wraps the whole line:
  `fastpick --harness claude --provider <p> --model <m> -- <the argv above>`.
  Everything the agent takes goes behind the `--`, the same split
  `thread/resume-args.ts` documents for the terminal runtime.
- Environment: `OpenSpec::env` merged onto the inherited environment, plus
  `CLAUDE_CONFIG_DIR` when the instance names a config directory. Never `HOME`:
  moving that would take the shell, git and ssh configuration with the account.

The binary is `OpenSpec::bin` if set, else `BOITE_PILOT_CLAUDE_BIN`, else
`claude` on the PATH. The env var may carry an interpreter
(`node C:\...\fake-claude.mjs`), quotes keeping a path with spaces together.

### Frames the driver reads

One pipe carries two streams. Conversation messages flow down; the control
protocol flows both ways, correlated by a `request_id` its sender mints.

| Frame | Mapped to |
|---|---|
| `{"type":"system","subtype":"init",...}` | `session.started`. Read: `session_id`, `model`, `slash_commands`; `claude_code_version`, `permissionMode`, `tools`, `capabilities`, `cwd` are carried opaquely in `extra`. |
| `{"type":"stream_event","event":{...}}` | `message_start` records the message id; `content_block_start` opens an item (`text`, `thinking`/`redacted_thinking`, `tool_use`); `content_block_delta` with `text_delta` or `thinking_delta` becomes `item.delta`. Emitted only because of `--include-partial-messages`. |
| `{"type":"assistant","message":{...}}` | `item.completed` per `text` and `thinking` block, `item.started` per `tool_use` block. |
| `{"type":"user","message":{...}}` | `item.completed` per `tool_result` block, on the `tool_use_id` it names. |
| `{"type":"result","subtype":"success"\|"error_*",...}` | `turn.completed` with `duration_ms` and `usage`, or `turn.aborted` when `is_error` or the subtype is not `success`, then `usage.updated`. `modelUsage[model].contextWindow` is where the window size comes from. |
| `{"type":"control_request","request_id":..,"request":{"subtype":"can_use_tool",..}}` | `request.opened`. Read: `tool_name`, `input`, `tool_use_id`, `title`, `description`, `permission_suggestions` (kept opaque and echoed back on an always-allow). `suppress_always_allow_rule` removes the always-allow option. |
| `{"type":"control_response","response":{...}}` | resolves one of our own outgoing control requests. |
| `{"type":"control_cancel_request","request_id":..}` | `request.resolved` with `cancelled`. |
| `{"type":"keep_alive"}` | dropped. |
| stdout EOF | `turn.aborted` for a turn still open, then `session.exited`. |

A stdout line that does not parse as JSON is dropped at `debug`, not treated as
an error: a launcher can print a banner.

The captured run also carried `{"type":"system","subtype":"status"}` and
`{"type":"rate_limit_event"}`. Neither is mapped: the first duplicates what the
turn edges already say, and the second belongs to the account rather than to the
thread.

### Frames the driver writes

```json
{"type":"user","message":{"role":"user","content":"<text>"},
 "parent_tool_use_id":null,"session_id":"<native id>"}

{"type":"control_request","request_id":"boite_<uuid>",
 "request":{"subtype":"interrupt"}}
{"type":"control_request","request_id":"boite_<uuid>",
 "request":{"subtype":"set_model","model":"claude-sonnet-4-6"}}
{"type":"control_request","request_id":"boite_<uuid>",
 "request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}

{"type":"control_response",
 "response":{"subtype":"success","request_id":"<the CLI's id>",
             "response":{"behavior":"allow","updatedInput":{...}}}}
{"type":"control_response",
 "response":{"subtype":"success","request_id":"<the CLI's id>",
             "response":{"behavior":"deny","message":"..."}}}
```

The permission answer goes in `response.response` verbatim, which is what the
SDK's own `handleControlRequest` writes. Fail-closed: a `can_use_tool` with no
answer blocks the tool forever, permission prompts having no deadline.

`initialize` is not sent. The SDK uses it to register hooks, SDK-hosted MCP
servers and `appendSystemPrompt`; this driver declares none of those and passes
the system prompt as a flag instead.

### Status

One source, no clock: `busy` while a turn is in flight, `waiting` while a request
is open, `idle` otherwise. `waiting` outranks `busy`, a question asked of the
user being the user's. `status.changed` is emitted only on a real change.

An interrupt emits `turn.aborted` when the control response comes back, and the
`result` that follows is dropped: the turn is taken under the lock, so exactly
one of the two closes it.

### Gaps against `docs/pilot.md`

- Rollback is declared unsupported. The wire has `rewind_files`, which restores
  files rather than the conversation, so declaring it would promise the wrong
  undo.
- `Capabilities::model_switch` is `InSession` for a model on the same account
  and `Restart` the moment the selection names another instance: the credentials
  are read at launch, so another account is another process.
- Everything else the phase-0 section asks of this crate is implemented:
  `--include-partial-messages`, `set_model`, `set_permission_mode` and
  `interrupt` all exist across the supported range and are exercised against
  the fake.

## The fake and the tests

`tests/fake-claude.mjs` speaks the frames above against a scenario file. A
`.mjs` file is not executable on Windows, so it is launched as an explicit argv:

```rust
spec.bin = vec!["node".into(), "<...>/fake-claude.mjs".into(), "<...>/plain.json".into()];
```

The scenario path is the first `.json` argument, or `BOITE_PILOT_SCENARIO`. The
tests pass it in the argv rather than through the env var, an env var being
process-global while the tests run in parallel; the var is the door the dev MCP
and the e2e runner use, and `proc::resolve_bin` covers it in a unit test.

The scenario file is the same JSON `scripted.rs` reads, so one file can be
pointed at either the fake or the scripted driver and the two must agree.
`tests/scenarios/` holds four: `plain.json` (a turn with assistant text),
`approval.json` (a turn that opens a tool request), `crash.json` (a child that
dies mid-turn) and `hang.json` (one that stops answering mid-turn). The
end-to-end run
adds `e2e/fixtures/e2e.json` and looks its scenarios up in that directory
first, then in this one.

```bash
cargo test -p boite-pilot
cargo clippy -p boite-pilot --all-targets -- -D warnings
```

`tests/fixtures/claude-2.1.259-hello.jsonl` is one real turn from the installed
CLI, and `the_captured_cli_turn_reduces_to_the_events_the_timeline_reads` runs
the driver's own reduction over it: a field the vendor renames fails a test
rather than a live session. Redacted in it, and only these: the working
directory, the home path, the messaging socket path, and the local hook,
skill, plugin and slash-command lists, which say nothing about the wire and
everything about one machine. The `system/hook_*` and `rate_limit_event` lines
were dropped whole for the same reason.
