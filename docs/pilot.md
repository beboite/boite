# Pilot: threads driven by protocol

Implementation status and remaining T3 parity work: [audit](t3code-audit.md).

The design for the second thread runtime. A `terminal` thread is a PTY that
boite watches from the outside; a `pilot` thread is an agent process boite
talks to over the agent's own machine protocol. Same thread row, same worktree,
same sidebar, a chat pane instead of a terminal pane. This file is the contract
every part is built against; the phase list at the end says what lands when.

Words. In code, everywhere: `pilot` (the crate `boite-pilot`, the bus domain
`pilot.*`, the column `threads.runtime = 'pilot'`). In the interface: "Chat".
The launcher offers Terminal or Chat on every preset, the experiment is called
"Chat threads" with a "new" badge. Not "agent": `thread.agent` already names the
CLI (claude, codex, ...). Not "SDK": the drivers use several machine protocols.

## Why

Today boite guesses. The status of a thread is read off the bottom rows of its
screen and expires on a clock. The session id is guessed from the mtime of a
transcript file for nine agents out of ten. A tool approval is a question drawn
inside a TUI that neither the dock nor a phone can see. The orchestrator gets
its messages typed into its prompt and answers through a separate HTTP route.
Every fragile paragraph in the status section of `AGENTS.md` comes from this.

Six of the ten agents already speak a machine protocol:

| Agent | Protocol | Launch | Native session | Model switch | Requests |
|---|---|---|---|---|---|
| claude | stream-json, the wire the official Agent SDK consumes | `claude --print --verbose --output-format stream-json --input-format stream-json --permission-prompt-tool stdio` | `--session-id`, `--resume` | `set_model` control request, in session | `can_use_tool` control request |
| codex | app-server, JSON-RPC on stdio | `codex app-server` | `thread/start`, `thread/resume` | per turn | approval requests from the server |
| cursor, grok, antigravity | ACP (Agent Client Protocol, the Zed spec), JSON-RPC on stdio | `cursor-agent acp`, `grok agent stdio`, `agy-acp-server` | `session/new`, `session/load` or `session/resume` | model config or `session/set_model` | `session/request_permission`, `session/elicitation` |
| opencode | HTTP + SSE, or ACP where `opencode acp` exists | `opencode serve` per thread | session | per message | session ruleset |
| copilot, hermes, pi, muse | not connected to the pilot runtime | terminal only, the launcher greys the Chat button and says why | | | |

Claude, Codex, OpenCode and the three ACP variants ship behind the experiment.

## Architecture

```
webview (desktop and PWA, same pages)
  pane terminal (xterm, untouched)        pane chat (DOM, new)
          |                                       |
          v                                       v
backend(): Tauri invoke locally, WebSocket to a boite-server
          |                                       |
          v                                       v
boite_core::command, one bus:   pty.* (existing)   pilot.* (new)
          |                                       |
          v                                       v
      PtyManager                          boite-pilot (Rust, tokio)
          |                                       |
          v                                       v
   ten CLIs in a TTY              stream-json | app-server | ACP | HTTP
                                    claude      codex      3 agents  opencode

shared, and unaware of which runtime sits above it:
  the threads row, the worktree and its grace, checkpoints, boite-mcp at launch,
  the approvals dock, the sidebar, settle, the orchestrator role, thread_spawn
```

- `boite-pilot` is a workspace crate with tokio. `boite-core` still takes no
  async runtime: the bus validates the command, checks the grant and the roots,
  and hands a `Ready` to the host, which owns the runtime through one more
  method on `Host`, `fn pilot(&self) -> Option<Arc<boite_pilot::Runtime>>`, the
  same shape as `pulse_waiters` and `child_pid`. A host with no pilot says so.
- Both hosts mount it: the desktop and `boite-server`. A phone reaches it
  through the WebSocket door it already uses for terminals.
- Events are canonical (fourteen kinds, below), journaled once, projected once.
  A text delta is never written to the database.

### The crate

```
crates/boite-pilot/
  src/lib.rs        Runtime: Map<thread_id, Session>, one tokio task per session
  src/driver.rs     trait Driver, trait Session, Capabilities
  src/event.rs      PilotEvent, Item, Request, Usage, Status
  src/claude.rs     the stream-json driver
  src/codex/        Codex App Server transport and reducer
  src/acp/          ACP transport, reducer and provider launch mappings
  src/opencode/     OpenCode HTTP transport, SSE reducer and launch mapping
  src/scripted.rs   a driver that replays a scenario file, for tests and e2e
  src/proc.rs       spawn, Windows job object, polite kill, the fastpick wrapper
  tests/            local fake binaries and wire tests
  README.md         the stream-json wire as pinned against the installed CLI
```

```rust
pub struct Runtime { /* sessions, sink */ }
impl Runtime {
    pub fn new(sink: Arc<dyn EventSink>) -> Self;
    pub async fn open(&self, spec: OpenSpec) -> Result<Opened, PilotError>;
    pub async fn prompt(&self, thread_id: &str, input: TurnInput) -> Result<TurnId, PilotError>;
    pub async fn interrupt(&self, thread_id: &str) -> Result<(), PilotError>;
    pub async fn respond(&self, thread_id: &str, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError>;
    pub async fn set_model(&self, thread_id: &str, selection: ModelSelection) -> Result<SwitchKind, PilotError>;
    pub async fn set_mode(&self, thread_id: &str, mode: ExecMode) -> Result<(), PilotError>;
    pub async fn stop(&self, thread_id: &str) -> Result<(), PilotError>;
    pub async fn stop_all(&self);
    pub fn status(&self, thread_id: &str) -> Option<Status>;
}

pub trait EventSink: Send + Sync {
    fn emit(&self, thread_id: &str, event: PilotEvent);
}

pub struct OpenSpec {
    pub thread_id: String,          // a uuid; claude gets it as --session-id
    pub cwd: PathBuf,               // the worktree
    pub driver: String,             // "claude", later "codex", "acp:cursor", ...
    pub instance: Instance,         // native config dir, or a fastpick route
    pub model: Option<String>,
    pub options: Options,           // effort, mode
    pub resume: Option<String>,     // native session id to resume
    pub mcp_servers: Vec<McpServer>,// boite-mcp first
    pub system_prompt_append: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities; // model_switch: InSession | Restart | Unsupported, rollback, modes it maps
    async fn open(&self, spec: OpenSpec, sink: SessionSink) -> Result<Box<dyn Session>, PilotError>;
}

#[async_trait]
pub trait Session: Send + Sync {
    async fn prompt(&self, input: TurnInput) -> Result<TurnId, PilotError>;
    async fn compact(&self, input: TurnInput) -> Result<TurnId, PilotError>;
    async fn interrupt(&self) -> Result<(), PilotError>;
    async fn respond(&self, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError>;
    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError>;
    async fn set_mode(&self, mode: ExecMode) -> Result<(), PilotError>;
    async fn stop(&self) -> Result<(), PilotError>;
    fn native_session_id(&self) -> Option<String>;
    fn model(&self) -> Option<String>;
}
```

### Fourteen events

| Kind | Carries | Stored |
|---|---|---|
| `session.started`, `session.exited` | native session id, effective model, slash commands, exit reason | yes, and `threads.session_id` |
| `turn.started`, `turn.completed`, `turn.aborted` | turn id, duration, usage, diff summary | yes, one turn item |
| `item.started`, `item.delta`, `item.completed` | item kinds: `assistant_text`, `reasoning`, `tool_call`, `command`, `file_change`, `plan`, `user_message`, `error` | started and completed yes, delta never |
| `request.opened`, `request.resolved` | tool approval, question, plan to confirm, with the options exactly as the driver offers them | yes, and a row in `approvals` of kind `pilot` |
| `status.changed` | `busy`, `waiting`, `idle` | no, live only |
| `model.changed`, `usage.updated` | what actually answers, tokens and context left | `model.changed` yes |
| `error` | a driver or process error the timeline shows | yes |

**What exists.** `boite-pilot` is the crate above. `lib.rs` holds `Runtime` with
`open`, `prompt`, `compact`, `interrupt`, `respond`,
`set_model`, `set_mode`, `stop`, `stop_all`, `stop_detached`, `status`,
`drivers`, `capabilities`, `native_session_id`, `pid`, `open_threads` and
`emit`, the door boite writes its own events through (the user's own message
today); `driver.rs` holds
`Driver`, `Session`, `OpenSpec`, `Opened`, `Instance`, `Options`, `ExecMode`,
`ModelSelection`, `SwitchKind`, `Capabilities`, `RequestAnswer` and
`PilotError`, with `TurnInput::turn_id` carrying the id the host minted so the
user's own message can be filed under a turn the driver has not named yet; `event.rs` holds `PilotEvent` and its fourteen kinds, `Item`,
`ItemKind` (with `notice`, boite's own line), `Request`, `Usage` and `Status`;
`claude.rs` is the stream-json driver, `codex/` is the App Server driver,
`acp/` is shared by Cursor, Grok and Antigravity, and `opencode/` owns the
HTTP/SSE driver. `scripted.rs` replays a scenario file. `proc.rs` owns the
spawn, Windows job object, Windows command-shim resolution and fastpick wrapper.

### Store

Two tables, five columns.

```sql
ALTER TABLE threads ADD COLUMN runtime TEXT NOT NULL DEFAULT 'terminal';
ALTER TABLE threads ADD COLUMN pilot_driver TEXT;
ALTER TABLE threads ADD COLUMN pilot_instance TEXT;
ALTER TABLE threads ADD COLUMN pilot_model TEXT;
ALTER TABLE threads ADD COLUMN pilot_options TEXT;   -- json: effort, mode

CREATE TABLE pilot_events (
  thread_id TEXT NOT NULL, seq INTEGER NOT NULL, ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE TABLE pilot_items (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
  turn_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL,
  body TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE INDEX pilot_items_thread ON pilot_items(thread_id, seq);
```

`pilot_events` is the journal, purged with the thread like the transcript.
`pilot_items` is what the timeline reads: one row per message, tool call,
request, turn, with its final text and state. A client arriving mid-turn reads
items by cursor, then subscribes. The text transcript for `terminal_transcript`
and search is rendered from items, not a third store.

**What exists.** `boite_core::store` holds `pilot_append_event`,
`pilot_upsert_item`, `pilot_item`, `pilot_items`, `pilot_events`,
`pilot_counts` and `pilot_approval_of_request`, and `delete_thread` purges both
tables. `boite_core::pilot` is the projection: `project`, `Projection`,
`DeltaBuffer`, `status_word`, `answer_of_option`, `request_item_id`,
`turn_item_id`, `user_message_item_id` and `write_notice`. `status.changed`
writes the thread's own status column there too, so the sidebar reads a chat
row's dot whether or not its pane is mounted, and `request.resolved` merges the
outcome onto the request's body rather than replacing it, or a reload would draw
an answered tool call as a bare "Question". The five columns are on
`boite_core::model::Thread` as `runtime`, `pilot_driver`, `pilot_instance`,
`pilot_model` and `pilot_options`, with `RUNTIME_TERMINAL` and `RUNTIME_PILOT`
beside them.

### The `pilot.*` domain

| Method | Does | Device scope |
|---|---|---|
| `pilot.catalog` | drivers installed, instances configured, models per instance, fastpick routes merged. Short cache, explicit `refresh` | `read` |
| `pilot.thread.open` | start or resume the native session of a `runtime = pilot` row. Answers with the native session id | `terminal` |
| `pilot.turn.start` | text, attachments, optional model selection. A turn already running receives the message as steering, not queued | `terminal` |
| `pilot.turn.interrupt` | Escape | `terminal` |
| `pilot.request.respond` | answer to a tool approval, a question, a plan. Closed vocabulary, checked on the machine that holds the process | `approve`, reachable from a locked screen like `reply` |
| `pilot.model.set`, `pilot.mode.set` | model, effort, execution mode. The driver says whether it is in-session or a restart | `write` |
| `pilot.session.stop` | polite stop, the native session stays resumable | `terminal` |
| `pilot.items`, `pilot.events` | cursor reads of the projected timeline, or of the raw journal | `read` |
| `pilot.subscribe` | a device receives deltas only for the threads it watches | `read` |

Push follows the two existing doors. Desktop: a Tauri channel per open pane.
Server: an event `pilot.event` next to `thread.updated`, sent to subscribers
only, text deltas coalesced per thread every 30 ms. Complete items and
requests go out at once.

**What exists.** `boite_core::command::pilot` decodes the twelve methods of
`ALL_METHODS` into `Pilot` and hands the host a `PilotReady`;
`boite_core::pilot_host::execute` runs it, with `Coalescer` holding deltas for
the 30 ms tick. The desktop's door is `src-tauri/src/commands/pilot.rs`
(`pilot_catalog`, `pilot_thread_open`, `pilot_turn_start`,
`pilot_turn_interrupt`, `pilot_request_respond`, `pilot_model_set`,
`pilot_mode_set`, `pilot_session_stop`, `pilot_items`, `pilot_events`,
`pilot_subscribe`, `pilot_unsubscribe`, pushing `pilot://event` and, for the
sidebar, `boite://thread-status`, which `features/pilot/threadStatus.ts` applies;
the server's
is `crates/boite-server/src/pilot.rs`, pushing `AppEvent::PilotEvent` as
`pilot.event`. The webview reaches both through `backend().pilot`
(`src/lib/backend/types.ts`), implemented in `backend/tauri/rpc.ts` as
`tauriPilot` and in `backend/remote/index.ts`; the JSON types are
`src/lib/features/pilot/types.ts`, the reduction is
`src/lib/features/pilot/reduce.ts` and the live store is
`src/lib/features/pilot/store.svelte.ts`. Both transports are tested on the
mapping the way the logs domain is: `backend/tauri/pilot.test.ts` for the twelve
Tauri commands and their bare answers, `backend/remote/pilot.test.ts` for the
twelve bus methods, the `items` and `events` envelopes, and one subscribe per
thread with the fan-out reaching only the thread an event names. The coalescing
itself is asserted in `pilot_host`: two hundred deltas over two items leave as
two frames, and one thread flushes without touching another's.

### Model selection, instances, fastpick

A selection is `{ driver, instance, model, options }`. An instance is a native
account (a driver plus a config directory, `CLAUDE_CONFIG_DIR` for claude, never
`HOME`) in the settings blob, `pilotInstances`, or a fastpick route, virtual,
read from `fastpick --list --json` and never stored. `proc.rs` launches
`fastpick --harness claude --provider <p> --model <m> -- claude --print ...` and
speaks stdio to the child, so every route the fastpick menu offers works in the
pilot with no new secret handling.

Three ways to switch inside a thread, and the picker says which one will happen
before the click:

1. Same instance: `set_model` in session, nothing stops. claude, codex, ACP.
2. Same driver, other instance: polite stop, then `--resume <id>` with the new
   environment, same transcript on disk, a second of silence.
3. Other driver: a graft. A new native session opens in the same worktree with
   a brief written from `pilot_items` (the goal as the user wrote it, the last
   turns, the files touched). An item `provider.changed` marks the timeline.
   Native context does not travel and the interface says so. Phase 4.

**What exists.** `pilot.catalog` answers `{ drivers: [{ id, capabilities,
models }], instances: [{ name, driver, kind, configDir?, provider?, model?,
label }] }`, built by `command::pilot::catalog` and cached for `CATALOG_TTL_MS`,
which `refresh: true` walks past. Claude native models are
`boite_pilot::claude::NATIVE_MODELS`, a list to extend per release: the four
aliases the CLI documents (`fable`, `opus`, `sonnet`, `haiku`) and the full ids
of the families it still offers. Not from the SDK, which carries no model union
at all and answers the real list at runtime over the network, but from
`claude --help` for the alias form and the CLI's own baked catalogue for the
ids; the crate's comment names both. Codex has the pinned fallback from the T3
manifest. ACP reads the account's models from session setup after
authentication. OpenCode reads its connected providers through `/provider`.
Both send the result in `session.started.extra.availableModels`, so the picker
fills without a second frontend API.

fastpick routes come from `boite_core::fastpick::list_blocking`, one call per
provider, merged as `kind: "fastpick"` instances named
`fastpick:<provider>:<model>`, the same string `fastpick/combo.ts` parses. The
label is what `comboLabel` composes for the fastpick menu, `<model> ·
<provider>`, with the credential named as `<provider>.<key>` when a provider
holds several and the model row says which one answers. Two documents an
installed fastpick printed are kept as fixtures under
`crates/boite-core/tests/fixtures/`, so a schema move fails a test rather than
an open menu.

A selection naming another instance answers `SwitchKind::Restart`, and
`pilot_host::restart` stops politely, reopens on `threads.session_id`, writes
`pilot_instance` and `pilot_model` and leaves an `ItemKind::Notice` on the
timeline; `SwitchKind::Unsupported` is an error the picker shows. The whole
path is driven end to end in `pilot_host`'s own tests against the scripted
driver: the notice, the two columns, the resume onto the same native session,
and one polite exit for the session that was replaced.

### Modes, requests, status, checkpoints

| Boite mode | claude | codex | Cursor ACP | Grok ACP | Antigravity ACP | OpenCode |
|---|---|---|---|---|---|---|
| ask | `--permission-mode default` | untrusted, read-only | default | `--permission-mode default` | `default` | read allowed, edits and commands ask |
| edit alone | `acceptEdits` | on-request, workspace-write | unsupported | `acceptEdits` | `auto_edit` | edits allowed, commands ask |
| yolo | `bypassPermissions` | never, danger-full-access | `--force` | `--always-approve` | `yolo` | all permissions allowed |

A request is an item with a state. `request.opened` also writes an `approvals`
row of kind `pilot` carrying the options the driver offered, opaque. The
existing dock draws them next to MCP approvals, the notification takes the same
path, `pilot.request.respond` sends the chosen option back.

For `runtime = pilot`, the status has one source: `status.changed`. No pid
registry, no screen rows, no clock. `waiting` is an open request, `running` a
turn in flight, `ready` the rest. The projection writes it onto the row and each
host pushes it (`boite://thread-status`, `thread.status`), so a thread working
in a group nobody is drawing still lights its dot; `statusEngine.ts` skips these
rows rather than measuring them. Auto-sleep is the one thing it keeps for them:
past the idle timeout it stops the process politely through `pilot.session.stop`
and keeps `session_id`, and waking is `pilot.thread.open` with resume, which the
chat pane calls itself when it opens on a row whose session is gone.

`turn.started` captures the `start` edge, `turn.completed` captures `end` and
writes what `checkpoint.diff` answers onto the turn item: files, additions,
deletions. The timeline shows that summary under every answer, a click opens the
editor pane on `fileVersions`.

**What exists.** `boite_core::pilot::project` takes the `start` edge at
`turn.started` and the `end` edge at `turn.completed`, both through
`checkpoint::capture_blocking` on the thread's own worktree, and writes
`checkpointStart`, `checkpointEnd` and a `diff` of `{ files, additions,
deletions, fileList }` from `checkpoint::diff_blocking` onto the turn item. A
capture never blocks a turn: a directory that is not a repository writes the
item without a summary. Modes, requests and status are `pilot.mode.set`,
`PilotEvent::RequestOpened` mirrored into `approvals` with
`PILOT_APPROVAL_ACTION`, and `status.changed` alone.

### The chat pane

A composer, a timeline, a model picker. Nothing else: git, explorer, editor and
terminal are panes to open beside it, and a pilot thread has no shell of its
own, which is the point.

- Composer: one rounded surface, the box growing from one row to six and then
  scrolling, with the model chip and the mode on the left of its bottom row and
  send and stop on the right. Enter sends, Shift+Enter breaks the line, Escape
  interrupts, Ctrl+M opens the chip, Ctrl+Up recalls the last sent line. During
  a turn, sending steers the turn instead of queuing, and a quiet line above the
  row says so rather than a dialog asking. Slash commands declared at init pass
  through untouched; typing `/name` filters them into a hint row Tab takes from
  (`slash.ts`), and boite never runs one itself.
- Picker: one component (`ModelPicker.svelte`) drawn by the header compact and
  by the composer at rest, so there is one idea of what the thread runs on. A
  search field, the accounts grouped native first and fastpick routes after with
  the labels the fastpick menu uses, the model tint the sidebar uses, and on
  every row what `selection.ts` says the click will do. Arrows walk it, Enter
  takes one, Escape closes. Effort draws the level in force until a driver
  declares a list; mode is a segmented control with a line saying what each one
  means.
- Timeline: virtualized list, the column capped at 72ch and centred. The user's
  line is the one row that leaves it, right-aligned as a bubble with no avatar.
  Assistant text is `ChatText` with a caret while it grows, reasoning is a
  folded "Thought for 3s", a tool call is one row (icon by kind, name, the
  command or the path, a status dot) opening to the input and the tail with a
  copy button, a file change is a chip that opens the diff, the request card is
  answerable in place, and the footer carries duration, tokens and the files
  behind a toggle. Scrolling up raises a "jump to latest" pill.
- Nothing empty is drawn. `item.started` mints a row before the driver has said
  anything and a driver's echo of the user's line often carries no body, so
  `present.ts` gates every row on having something to show; without it the pane
  draws a bordered bar of surface colour between two real cards.
- Rendering: deltas accumulate in one string per item and paint on the next
  frame, never a render per token. A hidden pane or a phone receives buffered
  text, flushed at request boundaries. No CodeMirror on the boot path: the chat
  chunk loads on first open.
- Phone: the Terminal tab of the bottom bar shows the chat for a pilot row.

`PaneContent` gains `{ kind: "chat", threadId }`, pane identity stays pane =
thread, `PaneContentView` has one more branch, `Terminal.svelte` is untouched.

### One thread, two runtimes

The `threads` row gains the five columns above and loses nothing:
`worktree_path` and its grace, `settled_at`, `role`, `orchestrator_scope`,
`parent_thread_id`, `accept_dispatch` apply unchanged. The sidebar draws the
same row with the same model tint, `thread_spawn` takes a `runtime` and replays
the caller's like it replays the fastpick combo, `thread_wait` reads an exact
status instead of a TTL.

**What exists.** `thread.create` refuses a chat row that names no driver, one
this build does not have, or an instance or options blob that will not parse
(`command::records::check_runtime`): all three used to land as a row in the
sidebar nothing could open, with the failure arriving one click later and
somewhere else. `POST /v1/threads` and the `thread_spawn` tool take an optional
`runtime` of `terminal` or `pilot`, defaulting to the caller's own row, and
carry it in the `thread.spawn` request the device mints from. The device decides
what to do with it in `pilot/launch.ts::chatSpawnDecision`, which is a pure
function so the branch is testable: a pilot spawn writes the five columns off
the worker's own argv (the driver from the agent, the instance native or the
fastpick route it carries, the mode from the yolo flag the spawn added),
`handleSpawn` then opens the session and sends the briefing as the first turn
rather than typing it, and a runtime no driver here can serve is answered with
the sentence the agent reads instead of a row nothing can open.
`Store::delete_thread` and `thread.settle` stop the native session through
`Host::pilot` on their way, so a settled or deleted chat row never leaves a
child running. `thread_wait`
reads a pilot row's status off the runtime through `Workspace::pilot_status`,
which both hosts implement: `busy` is a turn in flight, `waiting` an open
request, `idle` a session that is stopped, never opened or between turns. The
row's `running` mark and the PTY list are the terminal branch and are not
consulted for a chat thread. `Store::delete_thread` purges `pilot_events` and
`pilot_items` with the row, asserted against a neighbouring thread that keeps
its own. Both hosts stop every session on the way out: the desktop through
`commands::pilot::stop_all` on exit, the server through `Runtime::stop_all` in
its graceful shutdown, before the PTYs.

The bridge between the runtimes is the native session. A pilot claude thread
opens with `--session-id <threadId>`, so "open in a terminal" launches
`claude --resume <id>` through the terminal runtime, and a terminal thread
reopens as a chat on its captured session. Codex has the same pair.

In Experiments: "Chat threads", badge "new". Turning it off hides the Chat
button of the launcher and leaves open chat threads alive.

The Chat button is offered wherever a launch is: the shortcut bar, the home
card, the phone's sheet and the fastpick menu, all through
`pilot/catalog.svelte.ts` (`chatChoice`, `chatChoiceArgv`, `chatChoiceHarness`)
so the four agree. A fastpick route asks by its harness, and `claude-code` is
read as the `claude` driver (`driverOfHarness`): fastpick names the harness after
the program, the catalog names the driver after the wire.

## Logging

One log an agent can read, across the three hosts and the webview, with the
ids that let it answer "what happened to thread X".

- `boite_core::log` owns the format and the file. Records are JSON lines:
  `{ts, seq, host, level, target, msg, thread, turn, request, device, span, fields}`.
  `host` is `desktop`, `server`, `mcp` or `webview`. `thread`, `turn`,
  `request` and `device` are top-level so a filter never parses `fields`.
- Rust code logs through `tracing` macros with those names as fields
  (`tracing::info!(thread = %id, turn = %turn, "pilot.turn.started")`). A
  `tracing_subscriber` layer in `boite_core::log` writes the file, keeps a ring
  of the last 2000 records in memory, and forwards to live subscribers. Spans:
  `bus.call{method, thread}`, `pilot.turn{thread, turn}`, `pty.spawn{thread}`,
  `mcp.call{tool, request}`, `rpc{device, method}`.
- Files: `<log dir>/<host>.jsonl`, rotated at 8 MB, two previous kept
  (`<host>.1.jsonl`, `<host>.2.jsonl`). The desktop log dir is the Tauri app log
  dir; `boite-server` and `boite-mcp` take `--log-dir`, defaulting to the same
  place on the same machine. Redaction stays what `src-tauri/src/logging.rs`
  does today: addresses become `<email>`, user directories become their
  variable name.
- Level: `BOITE_LOG` in `EnvFilter` syntax, default `info`, `boite_pilot=debug`
  and `boite_core::command=debug` in dev builds. `logs.level` on the bus changes
  it at runtime.
- The webview logs through `backend().logs.write(records)`, batched every
  500 ms. The remote backend sends them as `logs.write` so a phone's records
  land on the server it is connected to, tagged `host: webview` plus the device.
- Bus: `logs.tail {limit, level, host}` from the ring; `logs.query {since,
  until, level, host, thread, turn, target, text, limit}` merges the files of
  every host by `ts`; `logs.subscribe` pushes `log.record` events to the device.
  The Logs section in settings reads these three and nothing else.
- Agent access: a `logs` tool in `boite-mcp` (`action: tail | query`, the same
  filters), rendered like the other tools. The dev MCP below points the same
  tool at the dev instance.
- What gets logged, as a rule: every command the bus refuses, once, at the
  codec, with the method and the thread; every child spawned or exited, with
  its pid; every pilot event kind at debug with thread and turn, requests and
  errors at info; every session binding and status change of a terminal thread
  at debug; every RPC that fails at warn with the device.

## The dev MCP and end-to-end tests

`boite-mcp --dev` replaces `@hypothesi/tauri-mcp-server`. It ships with the app,
speaks stdio MCP, and drives the isolated dev window (`bun run dev:isolated`,
identifier `dev.boite.dev`, port 1430) through the `mcp-bridge` WebSocket that
window already opens on `127.0.0.1`, plus the dev instance's log dir and
database. It never touches `com.boite.legacy`.

| Tool | Actions |
|---|---|
| `dev_window` | `start` (spawns `bun run dev:isolated`, pid captured, job object, waits for the port and the bridge), `stop` (that pid only), `status`, `restart`, `fresh: true` wipes the dev database first |
| `dev_inspect` | `overview`, `projects`, `threads`, `thread`, `read` (a terminal as text), `toasts`, `panes`, `settings`, through `window.__boite` |
| `dev_drive` | `click`, `type`, `press`, `screenshot`, `eval` |
| `dev_logs` | the `logs` tool on the dev instance's dir |
| `dev_db` | read-only SQL on the dev instance's SQLite |
| `dev_scenario` | `list`, `run <name>`: the e2e scenarios below, with their report |

End-to-end scenarios live in `e2e/`, run by `bun run e2e` (vitest, one dev
window per run, reused). A `DevApp` client in `e2e/lib/` talks to the same
three doors. The pilot scenarios run the real claude driver against
`crates/boite-pilot/tests/fake-claude.mjs`, the same Node script the crate's
own tests use: it speaks stream-json and replays a scenario file. The dev
window is started with `BOITE_PILOT_CLAUDE_BIN` set to `node <that path>`, so
no scenario spends a token or needs a credential. A scenario name is looked up
in `e2e/fixtures/` first and in `crates/boite-pilot/tests/scenarios/` second,
and `e2e.json` is the one every test runs against unless it asks for another.

Five scenario files today: `boot` (the window comes up and lists no project),
`project` (one is created), `chat` (a chat thread on claude opens, takes a
prompt and shows the assistant text), `dock` (a tool request answered from the
approval dock) and `resume` (the window restarts and the thread comes back on
the same session). The same turn from a remote client against a `boite-server`
is not written yet.

## The orchestrator on the pilot

The orchestrator becomes a chat thread. When "Chat threads" is on and the
orchestrator agent has a driver, the orchestrator thread is created with
`runtime = pilot`. `orchestrator.post` becomes `pilot.turn.start` on it, the
answer is an assistant item, `OrchestratorChat.svelte` reads `pilot_items`
through the pilot store. The `say` route of the agent API stays only for
terminal orchestrators. A dispatch to a pilot worker is a `pilot.turn.start`
with the briefing instead of a line typed into a prompt; `dispatch.drain` stays
for terminal workers.

**What exists.** `orchestrator.start` writes the five pilot columns when both
experiments are on and the orchestrator agent has a driver, native or through a
fastpick route whose harness `driverOfHarness` reads as `claude`
(`orchestrator/api.ts::orchestratorChatLaunch`, a pure function so the branch is
testable). A chat orchestrator gets no activation and no pane: it has no PTY,
its conversation is the Home card, and `home` is not a pane an agent may open,
so `ensureOrchestrator` awaits `pilot.thread.open` instead of mounting a group.
The session opens on the briefing `boite_core::orchestrator::briefing` builds,
passed as `system_prompt_append` and only for the row carrying the role: it is
instructions plus a snapshot, so it goes in front of the conversation rather
than spending a turn on a message the user never wrote.

`orchestrator.post` and `thread.dispatch` change shape in `Conduct::prepare`
(`as_pilot_turn`): each is converted into a prepared `pilot.turn.start`, so the
roots check, the driver check and the refusals are the pilot domain's own rather
than a second copy, and a host with no pilot runtime falls through to the
terminal path unchanged. The static guards run before the conversion, so a
dispatch that lands as a turn still refuses with `MUTED`, `OUT_OF_SCOPE`,
`SCOPE_TAKEN` and `NO_ORCHESTRATOR_TO_ORCHESTRATOR`. `orchestrator.messages`
answers the `user_message` and `assistant_text` items of `pilot_items` in the
shape the Home chat already read, on the host so a phone reads the same list;
its cursor is an item id resolved back to a sequence. `orchestrator.status`
carries `runtime` and, for a chat row, the exact status column the projection
writes. `say` refuses a chat orchestrator by name (`PILOT_ORCHESTRATOR`): its
answer is already an item, and a second copy in `orchestrator_messages` would
draw it twice. `orchestrator.undo` and `orchestrator.actions` are unchanged and
tested over a chat orchestrator, because nothing they touch is a PTY.

`OrchestratorChat.svelte` draws `pilot/Conversation.svelte` for a chat
orchestrator, which is `load` on mount, `release` on unmount and the pane's own
`Timeline`, so one conversation does not look like two things depending on where
it is read. Behind `import()` like the pane and the dock's request card: Home is
drawn before first paint, and a static import of the timeline is the regression
`bundle-budget.json`'s eager ceiling exists to catch. The composer stays what it
was, voice included. `e2e/orchestrator.e2e.ts` drives the whole path against the
fake claude.

## Phases

Each phase ships behind the experiment, on both hosts, with a proof that opens
and can be looked at.

0. **Done.** Spike claude: the crate with the claude and scripted drivers, the
   fake claude, the `pilot.*` domain, the migration, `Host::pilot()` in both
   hosts, the chat pane, the toggle. Proof: a turn with a tool approval
   answered from the dock, the app closed and reopened, the thread resumed on
   the same session, the exact status in the sidebar, the same from the PWA on
   a boite-server. Logging and the dev MCP landed with it, since the proof runs
   on them.
1. **Done.** Drivers: Codex App Server, generic ACP with provider particulars,
   and OpenCode HTTP/SSE.
   A fake binary per protocol in CI replays a turn, a request, a switch and a
   resume. `codex/` handles current and legacy approval
   wires, structured questions, native compaction and App Server items. `acp/`
   handles Cursor, Grok and Antigravity, including account model discovery,
   load replay suppression, form elicitation and opaque permission ids.
   `opencode/` owns one loopback server per thread, checks version 1.14.19,
   resumes or creates a native session, consumes SSE, recovers pending requests,
   and drives prompts, permissions, questions, models, modes and compaction over
   HTTP.
2. Models: catalog, picker, instances, fastpick routes, in-session and restart
   switch, modes, checkpoints and diff per turn, `thread_spawn` with runtime.
   **Mostly here already**, because phase 0's proof needed it: `pilot.catalog`
   with `claude::NATIVE_MODELS` and the fastpick routes, `ModelPicker.svelte`
   and `ModeControl.svelte`, `pilot.model.set` on both switch kinds,
   `pilot.mode.set`, a checkpoint and a diff per turn, and `thread_spawn`
   taking a runtime. ACP and OpenCode add their live, account-specific model
   lists after the session opens.
3. Phone and orchestrator: approval from the notification, buffered delivery,
   push on `request.opened`, the orchestrator as a chat thread. **Not started**;
   the dock and the PWA path are phase 0's, the notification and the push are
   not.
4. Graft: cross-driver switch, conversation rollback where declared, generated
   titles, the terminal to chat bridge and back. **Not started.**

## Budgets

| Measure | Target | Where it is written |
|---|---|---|
| spawn to first token | under 2 s cold, under 500 ms on resume | `spawn-timing.ts`, phases `worktree`, `open`, `first-event` |
| WebSocket bytes per turn | deltas coalesced, a complete item once | a counter in `pilot.subscribe` |
| SQLite writes per turn | items only, zero per delta | a test in `store.rs` counting statements |
| bundle | the chat off the boot path | `bundle-budget.json`, one line for the chat chunk |
| render | a 200-item turn without a dropped frame | `render-budget.ts` |

## Risks

- The stream-json wire of claude is documented only through the SDK. The
  control messages are pinned against a captured CLI turn, replayed by the fake
  in CI, and the supported range is what
  [the crate README](../crates/boite-pilot/README.md) declares: 2.1.259, which
  is the capture, through 2.1.260, which is what is installed today. Moving the
  upper bound means capturing a turn on the new version. The fallback if the
  wire moves too much: a compiled sidecar embedding the SDK behind the same
  `Driver`.
- fastpick has to pass stdio through to the harness.
- Antigravity needs the managed `agy-acp-server`, harness and profile. T3 Code
  downloads and prepares them. Boite currently expects an external install and
  accepts `BOITE_PILOT_ANTIGRAVITY_BIN`.
- Copilot ACP still uses the terminal runtime.
- Windows: stdio pipes and process trees. `pty.rs` already has job objects and
  the 1.5 s grace; `proc.rs` reuses them.
- A pilot thread has no shell. Opening a terminal beside it is the existing
  split, one click.
