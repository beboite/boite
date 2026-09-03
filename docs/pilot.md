# Pilot: threads driven by protocol

The design for the second thread runtime. A `terminal` thread is a PTY that
boite watches from the outside; a `pilot` thread is an agent process boite
talks to over the agent's own machine protocol. Same thread row, same worktree,
same sidebar, a chat pane instead of a terminal pane. This file is the contract
every part is built against; the phase list at the end says what lands when.

Words. In code, everywhere: `pilot` (the crate `boite-pilot`, the bus domain
`pilot.*`, the column `threads.runtime = 'pilot'`). In the interface: "Chat".
The launcher offers Terminal or Chat on every preset, the experiment is called
"Chat threads" with a "new" badge. Not "agent": `thread.agent` already names the
CLI (claude, codex, ...). Not "SDK": true for claude only.

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
| cursor, grok, antigravity, copilot | ACP (Agent Client Protocol, the Zed spec), JSON-RPC on stdio | `cursor-agent acp`, `grok` in acp mode, `agy-acp-server`, `copilot --acp` | `session/new`, `session/load` | `session/set_model` | `session/request_permission` |
| opencode | HTTP + SSE, or ACP where `opencode acp` exists | `opencode serve` per thread | session | per message | session ruleset |
| hermes, pi, muse | none | terminal only, the launcher greys the Chat button and says why | | | |

Phase 0 ships claude. The others follow the same trait.

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
                                    claude      codex      4 agents  opencode

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
- Events are canonical (sixteen kinds, below), journaled once, projected once.
  A text delta is never written to the database.

### The crate

```
crates/boite-pilot/
  src/lib.rs        Runtime: Map<thread_id, Session>, one tokio task per session
  src/driver.rs     trait Driver, trait Session, Capabilities
  src/event.rs      PilotEvent, Item, Request, Usage, Status
  src/claude.rs     the stream-json driver
  src/scripted.rs   a driver that replays a scenario file, for tests and e2e
  src/proc.rs       spawn, Windows job object, polite kill, the fastpick wrapper
  tests/            the fake claude binary (a Node script) and the wire tests
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
    async fn interrupt(&self) -> Result<(), PilotError>;
    async fn respond(&self, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError>;
    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError>;
    async fn set_mode(&self, mode: ExecMode) -> Result<(), PilotError>;
    async fn stop(&self) -> Result<(), PilotError>;
    fn native_session_id(&self) -> Option<String>;
}
```

### Sixteen events

| Kind | Carries | Stored |
|---|---|---|
| `session.started`, `session.exited` | native session id, effective model, slash commands, exit reason | yes, and `threads.session_id` |
| `turn.started`, `turn.completed`, `turn.aborted` | turn id, duration, usage, diff summary | yes, one turn item |
| `item.started`, `item.delta`, `item.completed` | item kinds: `assistant_text`, `reasoning`, `tool_call`, `command`, `file_change`, `plan`, `user_message`, `error` | started and completed yes, delta never |
| `request.opened`, `request.resolved` | tool approval, question, plan to confirm, with the options exactly as the driver offers them | yes, and a row in `approvals` of kind `pilot` |
| `status.changed` | `busy`, `waiting`, `idle` | no, live only |
| `model.changed`, `usage.updated` | what actually answers, tokens and context left | `model.changed` yes |
| `error` | a driver or process error the timeline shows | yes |

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

### Modes, requests, status, checkpoints

| Boite mode | claude | codex | ACP |
|---|---|---|---|
| ask | `--permission-mode default` | on-request, workspace-write | the agent's default |
| edit alone | `acceptEdits` | on-failure, workspace-write | `auto_edit` where declared |
| yolo | `bypassPermissions` | never, danger-full-access | `yolo`, native requests still get an answer |

A request is an item with a state. `request.opened` also writes an `approvals`
row of kind `pilot` carrying the options the driver offered, opaque. The
existing dock draws them next to MCP approvals, the notification takes the same
path, `pilot.request.respond` sends the chosen option back.

For `runtime = pilot`, `statusEngine.ts` has one source: `status.changed`. No
pid registry, no screen rows, no clock. `waiting` is an open request, `running`
a turn in flight, `ready` the rest. Auto-sleep stops the process politely and
keeps `session_id`; waking is `pilot.thread.open` with resume.

`turn.started` captures the `start` edge, `turn.completed` captures `end` and
writes what `checkpoint.diff` answers onto the turn item: files, additions,
deletions. The timeline shows that summary under every answer, a click opens the
editor pane on `fileVersions`.

### The chat pane

A composer, a timeline, a model picker. Nothing else: git, explorer, editor and
terminal are panes to open beside it, and a pilot thread has no shell of its
own, which is the point.

- Composer: multi-line, Enter sends, Escape interrupts. During a turn, sending
  steers the turn instead of queuing. Slash commands declared at init pass
  through untouched.
- Picker: driver, instance, model, effort, mode in one menu, the fastpick menu
  extended, with the model tint the sidebar already uses.
- Timeline: virtualized list. Assistant text in light markdown, reasoning
  folded, tool card with the command and the tail of its output, file card that
  opens the diff, request card answerable in place, turn footer with duration,
  tokens and diff.
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

The bridge between the runtimes is the native session. A pilot claude thread
opens with `--session-id <threadId>`, so "open in a terminal" launches
`claude --resume <id>` through the terminal runtime, and a terminal thread
reopens as a chat on its captured session. Codex has the same pair.

In Experiments: "Chat threads", badge "new". Turning it off hides the Chat
button of the launcher and leaves open chat threads alive.

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
database. It never touches `com.boite.desktop`.

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
`e2e/fake-claude.mjs`, a Node script that speaks stream-json and replays a
scenario; the dev window is started with `BOITE_PILOT_CLAUDE_BIN` pointing at
it, so no scenario spends tokens or needs a credential. First scenarios: the
window boots and lists no project; a project is created; a chat thread on claude
opens, receives a prompt, shows the assistant text, opens a tool request that
is approved from the dock, shows the turn diff; the window restarts and the
thread resumes on the same session; the same turn from a remote client against
a `boite-server`.

## The orchestrator on the pilot

The orchestrator becomes a chat thread. When "Chat threads" is on and the
orchestrator agent has a driver, the orchestrator thread is created with
`runtime = pilot`. `orchestrator.post` becomes `pilot.turn.start` on it, the
answer is an assistant item, `OrchestratorChat.svelte` reads `pilot_items`
through the pilot store. The `say` route of the agent API stays only for
terminal orchestrators. A dispatch to a pilot worker is a `pilot.turn.start`
with the briefing instead of a line typed into a prompt; `dispatch.drain` stays
for terminal workers.

## Phases

Each phase ships behind the experiment, on both hosts, with a proof that opens
and can be looked at.

0. Spike claude: the crate with the claude and scripted drivers, the fake claude,
   the `pilot.*` domain, the migration, `Host::pilot()` in both hosts, a minimal
   chat pane, the toggle. Proof: a turn with a tool approval answered from the
   dock, the app closed and reopened, the thread resumed on the same session,
   the exact status in the sidebar, the same from the PWA on a boite-server.
   Logging and the dev MCP land in this phase too, since the proof runs on them.
1. Drivers: codex app-server, generic ACP with its four files of particulars,
   opencode. A fake binary per protocol in CI replays a turn, a request, a
   switch, a resume.
2. Models: catalog, picker, instances, fastpick routes, in-session and restart
   switch, modes, checkpoints and diff per turn, `thread_spawn` with runtime.
3. Phone and orchestrator: approval from the notification, buffered delivery,
   push on `request.opened`, the orchestrator as a chat thread.
4. Graft: cross-driver switch, conversation rollback where declared, generated
   titles, the terminal to chat bridge and back.

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
  control messages are pinned against the installed CLI version, replayed by
  the fake in CI, and the supported range is written in the crate README. The
  fallback if the wire moves too much: a compiled sidecar embedding the SDK
  behind the same `Driver`.
- fastpick has to pass stdio through to the harness.
- Three ACP modes to confirm on installed versions: `opencode acp`,
  `copilot --acp`, an acp mode of antigravity. Each has a fallback.
- Windows: stdio pipes and process trees. `pty.rs` already has job objects and
  the 1.5 s grace; `proc.rs` reuses them.
- A pilot thread has no shell. Opening a terminal beside it is the existing
  split, one click.
