# The `boite` CLI

`boite` lets an agent reach its thread's panel, tasks, project todos and Git
state. Human-readable output uses key/value lines or rows; `--json` returns the
RPC result for scripts. The command loads on demand and works with every driver,
including providers without an MCP client. The CLI also exposes a bounded set of thread-scoped tools through
`boite mcp` for providers with an MCP client.

Every new native agent session receives a compact CLI guide before its first
request, even without a connected brain. Enabled coordination and delegation
add their commands and current limits; workflow syntax is loaded on demand
through `boite workflow help`. The guide never creates a file in the brain or
project. [Brain settings](brain.md#boite-guide) describes its switch.
Task tracking is optional: agents use a task list only when laying out steps
helps them and the user follow the work.

## MCP stdio

Run `boite mcp` from an agent process inside a Boite thread. The command reuses
`BOITE_CORE_URL`, `BOITE_AGENT_TOKEN` and `BOITE_THREAD_ID`, performs the normal
RPC hello, and requires the authenticated agent identity to match that thread.
It refuses owner credential fallback and owner/session tokens. Configure the
host to launch command `boite` with argument `mcp` and inherit that agent
environment. No global MCP configuration or provider setting is written.

The official MCP TypeScript server SDK loads only for this subcommand. It owns
stdio framing, initialization, JSON Schema argument validation and request
cancellation. stdout contains protocol messages only; diagnostics use stderr.
Closing stdin or sending SIGINT/SIGTERM closes the MCP transport and its Boite
connection. It never stops a delegated child as part of transport teardown or
call cancellation. A submitted action may continue after cancellation; use the
explicit stop tool when that is intended.

The fixed tools expose this thread's location, projects, runtime capabilities,
authorized contact directory/search/read/send, delegation get/spawn/send/stop/wait/result,
fork summary merge-back, plan get/set and asynchronous questions. Every call injects the authenticated
source thread and reaches the existing RPC access and relationship checks.
Arguments cannot select an arbitrary RPC method or another source thread.
There are no command execution, file access or diagnostic log tools. Mutation
tools that support request IDs require a stable caller-supplied `requestId`,
so retrying the same request does not silently create another child or letter.
`boite_merge_back` sends a supplied summary (maximum 4000 characters) to the
fork's recorded source under coordination policy; it does not merge files.
Tool-output disclosure is omitted because the agent RPC policy does not grant
`messages.toolOutput` or `messages.toolPart` access.

`boite_delegate_wait` waits for direct children for 10 minutes by default,
with `timeoutMs` from 0 to 3600000. Each wait owns a separate authenticated RPC
connection; cancelling it closes that connection and releases the core waiter
without stopping the child or disconnecting other tools. Use a returned
`resultRef` with `boite_delegate_result`, which accepts `offset` and `limit`
(maximum 16000). Continue with `nextOffset` until it is null. Offsets count
Unicode code points; returned pages also stay within 16000 UTF-16 units.

`boite_projects`, `boite_contacts` and `boite_contact_search` accept `offset`
and `limit` (1 to 100, default 20). Their result has `items` and `page`, including
`nextOffset`. `boite_contact_read` accepts a limit and `before`; when its result
has `more: true`, use the oldest returned entry's `at` to read older messages.
Results include both text and `structuredContent`. The complete result is
bounded to 256 KiB; larger values return `truncated: true`, measured bytes and
an explicit preview instead of pretending the output is complete. Read smaller
pages to recover transcript output. Do not repeat a mutation to recover a
truncated response. The stdio input frame is limited to 64 KiB.

Implementation: `packages/core/src/mcp/`, pinned
`@modelcontextprotocol/server` 2.3.0 and Zod 4.6.5. The source CLI dispatch is
already included in the normal core build and sidecar, so no extra executable
or staging path is required. See the official SDK
[stdio guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md)
and [tool guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md).

## Test a page in the agent browser

`boite browser help` lists the commands. The browser is a headless Chrome,
Chromium, Edge or Brave on the machine that runs the conversation, started by
its core; [the agent's browser](browser.md) says how it is found and run. No
desktop has to be open and no setting turns it on. The user watches the tabs
live in the conversation's panel, from any device, and can act in them.
The commands are agent-browser's, so an agent that knows one knows the other.
`boite browser open http://localhost:3000` goes to the page in the current tab,
or opens a tab in the default profile when there is none; `localhost` is the
agent's own machine. `boite browser profiles` lists the profiles the user made
in Settings > General > Browser profiles on that machine, and
`open <url> --profile Pro` opens a new tab in one of them, by name or id.
`--profile private` opens a private tab that keeps nothing once the last private
tab closes. `tab list` names each tab's profile, `tab new <url>` opens another,
`tab <id>` makes one current and `--tab <id>` aims a single command at it. The
agent cannot select a tab from another conversation.

`snapshot -i` lists the page's interactive elements with refs:
`- textbox "Email" [ref=e3]`, `- button "Continue" [ref=e5]`. Without `-i` it
adds headings, text and the containers around them; `-c` drops the containers,
`-d 3` stops at a depth, `-s "#main"` keeps one part and `-u` adds link urls.
`click @e5`, `fill @e3 ada@example.com`, `type`, `select`, `check`, `press Enter`,
`hover` and `scrollintoview` act on a ref, a CSS selector matching one element or
`text=Continue`. Refs are renumbered by every snapshot; a ref from an earlier
page is refused by name. `get text|value|attr|title|url|count`, `is checked` and
`eval <js>` read the page. Page text and evaluation results are untrusted input,
just like web search results.

An action that starts a navigation waits for the next page's DOM and prints
where it went; `open` waits for the DOM too, never for the load event, so a page
whose image or script never finishes still answers within 10 seconds. `wait`
waits for an element, `--text`, `--url "**/done"`, `--fn <js>` or
`--load domcontentloaded|load|networkidle`, for 10 seconds unless `--timeout`
says otherwise, at most 15. Clicks, keys and text are native input, which pages
treat as a person's own; a covered element is clicked through the DOM, and the
output names what covered it.

Nobody can answer a dialog in a headless page. An alert, confirm or prompt
raised while an action runs is accepted, or dismissed after `dialog dismiss`,
and listed in the output of that action. One raised between commands, by a
person acting in the panel, is declined, except an alert.

`boite browser screenshot <path>` writes a PNG to the chosen file (`--output <path>` too).
Relative paths resolve from the working directory; absolute paths may point to
a temporary directory outside the checkout. The parent directory must exist,
and an existing file is never overwritten. Without `--output`, the command
creates `boite-browser-<uuid>.png` in the working directory; the caller owns
cleanup. Read it with the agent's image tool, or run `boite attach <path>` to
display a capture inside the thread's working directory in chat.
`resize 390 844` tests a narrow viewport and `reset-viewport` returns to the
browser's window size.

`preset iphone-15-pro landscape` selects a screen size and orientation.
`appearance dark`, `light` or `system` changes the page's color scheme.
These are CSS viewport and media-query settings, not device or touch emulation.
`diagnostics` returns console output, JavaScript exceptions, failed requests,
HTTP errors and action history. Each tab retains the latest 200 page events
and 100 actions. Network URLs omit credentials, queries and fragments. Action
history records operation names, not typed values or evaluated code.
`diagnostics-clear` clears both buffers.

`recording-start` and `recording-stop` save a silent MP4 in the working
directory, made in the browser itself ([recording](browser.md#recording)), up to
1920 × 1080. `recording-start --fps 60 --codec av1` chooses the rate and codec;
the defaults are 30 and H.264. A codec the browser cannot encode into MP4 is
refused with the codecs it can; nothing records in another one. The result's
`codec` names the codec written.

There is no time limit; a recording stops by itself at 100 MB (about 12 minutes
at 30 fps, 6 at 60), which the browser keeps in memory and the CLI reads in
4 MB chunks. The saved video is complete up to that point, and the result's
`note` says why it ended. There is no sound, as in T3 Code. Run
`boite attach <video.mp4>` to show it in chat. Closing the tab discards an
unfinished recording.

The agent stops its own recording within the turn that started it. When that
turn ends, however it ends, the core stops any recording the agent left
running and throws it away; a later `recording-stop` or `recording-read` fails
with an error that says the recording was discarded. Archiving or removing the
conversation closes its tabs, recordings included.

Commands of one conversation run one at a time, in order. `open` and
`navigate` answer `loading: true` for a page that has not loaded within 15
seconds. Every provider uses this same CLI; no provider-specific integration or
paid model call is needed for these tests.

## Simulators and emulators

`boite device help` lists the commands. `boite device list` shows the iOS
Simulators and Android emulators or phones on the machine that runs the core,
and why a platform is missing. `open` boots one, shows it in the user's Device
panel, waits until it is ready and prints the `adb -s <serial>` or
`xcrun simctl` prefix that drives it. `screenshot`, `tap`, `swipe`, `type`,
`key` and `close [--shutdown]` act on it. Details and limits are in
[devices.md](devices.md).

## Pull requests linked to a conversation

`boite pr link <url>` verifies a GitHub pull request and saves its link in the
current conversation. Link each PR in a stack. `boite pr list` returns them
in dependency order; `boite pr refresh` updates titles and states from GitHub.
`boite pr unlink <url>` removes the saved link without changing the PR.
An agent can manage links only in its own conversation. Paired devices can
read the list. Lookup uses the local `gh` login and the configured `GH_HOST`.
At most 20 PRs can be linked to one conversation.

## How an agent finds the core

Every process a thread launches, the agent and whatever it spawns, carries
three variables and one PATH entry, put there by
`packages/core/src/threads/turn-context.ts` around the driver's spawn:

| Variable           | Value                                            |
| ------------------ | ------------------------------------------------ |
| `BOITE_THREAD_ID`  | the thread                                       |
| `BOITE_CORE_URL`   | the core's HTTP address                          |
| `BOITE_AGENT_TOKEN`| a token minted for this thread, in memory only   |
| `PATH`             | the directory holding `boite` and `boite.cmd`, first |

The CLI says hello with that token and becomes the `agent` principal of that
one thread. `AGENT_METHODS` in `packages/core/src/access.ts` lists its allowed
calls and reasons. Each call is bound to that authenticated thread; delegation
and coordination additionally check relationships and authorized contacts.
An owner-only method such as `files.write`, `trace.get` or `core.logs` is refused. The
token is forgotten when the thread is
archived or removed, a socket an agent already opened with it is closed at the
same moment, and the token is never written to disk.

Events follow the same access boundary as calls. An agent can receive its own
thread's activity and its project's task cards. Account login output, process
traces, diagnostics and other conversations' updates are owner-only for an
agent connection. New event types are denied until explicitly allowed in
`access.ts`.

Outside a thread, `boite --thread <id>` reads the owner token out of
`core.json` like `boite-core pair` does (`--data-dir`, `--channel dev`) and
drives that thread as the owner. That is for a person at a terminal, not for an
agent: inside a thread, `--thread` naming another thread is refused before any
token is read. `--core <url>` reaches another machine's core with its token in
`BOITE_TOKEN` (an owner token or a paired device's session token), never on the
command line, where a process listing would show it. The URL must be https, or
http on loopback or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48),
since the first frame carries the token.

The commands that drive other threads (`threads`, `thread show|send|stop|
archive|unarchive|remove|rename`, `thread move <project> <id>`, `questions`,
`answer`, `permissions`, `allow`, `deny`, `stewards`, `projects
archive|unarchive|remove`) and `thread new` need no `--thread` from a terminal.
There they use the owner methods: `thread send` is the owner's own prompt,
queued behind a running turn, and `thread new` copies the agent of `--thread`,
else of the project's most recent thread (`--model` replaces the model). Inside
a thread the same words act as the [steward](stewards.md) the owner made that
thread, held to its projects and capabilities, and its messages reach other
threads as the steward's letters, never as the user's.

## Commands

```
boite where                      thread, title, project, cwd, branch, worktree, agent
boite thread move <project>      move this thread to another project (name, id or
                                 folder) when this turn ends
boite thread new <project> <brief> [--worktree] [--title <title>]
                                 start a thread in a project; its first answer
                                 comes back as an agent message
boite projects                   the projects added to Boite
boite projects add <folder> [--name <name>]
                                 add an existing folder as a project
boite projects archive|unarchive|remove <project>
                                 the owner's; removing leaves the folder on disk
boite threads [--project <p>] [--archived]
                                 every thread as the owner, a steward's own
boite thread show <id>           state, pending questions and permissions, last answer
boite thread send <id> <text>    the owner's prompt, or the steward's letter
boite thread stop|archive|unarchive|remove <id>
boite thread rename <id> <title>
boite thread move <project> <id> move another thread
boite questions [<id>]           pending questions
boite answer <id> <question-id> <option|text ...> [--skip]
boite permissions [<id>]         pending tool permissions
boite allow|deny <id> <request-id>
boite stewards [set <thread> <project ...> [--all] [--can <a,b>] [--quiet] | revoke <thread>]
boite steward                    this thread's steward grant
boite attach <file>               publish a file snapshot in chat, at most 512 MB
boite preview <file.html>          open a local HTML artifact and its neighbouring assets
boite preview-close <file.html>    stop serving that preview
boite show <file>[:line]         open the file in the panel, at that line
boite diff [file]                open the changes surface, or one file's diff
boite browse <url>               open the url in the panel's browser (http, https)
boite open trace|tasks|changes|files [dir]
boite status                     git status: branch, upstream, one row per change
boite ask <question> [option ...] [--multiple]
boite task list|add <text>|start <id>|done <id>|remove <id>|clear
boite todo list|add <text>|claim <id>
boite agents list|inbox
boite agents find <words>
boite agents read <agent> [--last <n>] [--before <ms>]
boite agents send <agent> <text> [--wait] [--timeout <s>]
boite agents reply <message-id> <text> [--wait] [--timeout <s>]
boite agents log <agent>
boite agents wait [agent] [--timeout <s>]
boite agent context|inbox|missions
boite agent send <recipient-ids|-> <text>
boite agent reply <message-id> <text>
boite agent acquire <task-id>
boite agent submit <task-id> <assignment-generation> <result>
boite agent artifact <json>
boite agent decide <json>
boite agent memory [query]
boite agent remember <json>
boite agent routines
boite agent schedule <json>
boite delegate models|profiles|list
boite delegate spawn <brief> [--model <provider/model>] [--effort <level>] [--profile <id>] [--title <t>]
boite delegate send <thread-id> <text>
boite delegate wait [thread-id] [--timeout <s>]
boite delegate result <thread-id> <turn-id> [offset]
boite delegate stop [thread-id]
boite workflow help|check|run|list|show|extend|pause|resume|stop|retry
boite workflow output|templates|save|start
boite help
```

Coordination commands are documented in [coordination](coordination.md#agent-commands),
child controls in [delegation](delegation.md#agent-commands), and plan/output
commands in [workflows](workflows.md#commands).

Persistent agents with the `routines` tool enabled can schedule work from their
direct conversation. `agent schedule` accepts `name`, `prompt`, and `schedule`,
for example `{"kind":"daily","time":"09:00","timezone":"Europe/Paris"}`.
Other schedules use `{"kind":"interval","everyMinutes":60}` or
`{"kind":"once","at":1790240400000}` with a Unix timestamp in milliseconds.
To edit or pause a routine, include its `id`, `expectedRevision` and `enabled`.
The host enqueues occurrences even when clients are closed. An unfinished
occurrence blocks overlap and missed intervals never create a catch-up burst.

Paths are resolved against the current directory and must stay inside the
thread's working directory; the core refuses the rest by name. `show src/a.ts:12`
opens the file at line 12. A `show`, `diff`, `browse` or `open` answers
`shown: yes` when a client subscribed to the thread received the request, and
`shown: no ...` when nobody was watching: the request still lands on the
thread's panel and is there when the thread is next opened.

`thread move` accepts a project ID, unique name or absolute registered folder.
Ambiguous names are refused with matching IDs. It moves only the authenticated
root when its current turn ends, or immediately when idle, and stops background
work because the agent asked to leave. Existing files and worktrees stay in
place. A pending move can be cancelled by the user and is lost on core restart.
[Moving a thread](development.md#moving-a-thread) owns the full lifecycle,
working-directory, session and child restrictions.

`thread new` starts an ordinary top-level thread in a project the owner
added, named like `thread move` does, and sends the brief as its first
message. It is the same thread the user would start from the sidebar: it
appears there, keeps its own session and can be opened, answered, moved or
archived like any other. It is not a delegated child. The new thread runs on
the caller's provider, account, model, effort and permission mode, in the
project folder or, with `--worktree`, on a new `boite/` branch of its own.
The title is `--title` or the brief's first line. The CLI prints its thread ID, title,
project, working directory, provider/model
and coordination address. Its first answer returns automatically; later steering
uses `agents send`.

The agent there reads a note before the brief: which thread's agent started
it, that the user did not type it, and that it grants no approval the user
did not give. When that first turn ends, its final answer, or its failure,
goes back to the starter as an [agent coordination](coordination.md) message
from the new thread, capped at 4,000 characters, and wakes an idle starter. Later turns
report nothing by themselves; the two agents
use `agents send` and `agents reply` like any pair of conversations. Both
timelines show a line linking the other thread: "Started by the agent of ..."
above the first prompt, "The agent started ..." in the starter.

The owner's Communication settings of the calling thread decide: Off refuses,
Pause refuses, and a thread restricted to its own project cannot start one
elsewhere. There is no hourly limit. A thread an agent started cannot start another
until the user has
written in it, so agents cannot chain threads on their own. Delegated
children, workflow steps and persistent agent sessions are refused. A retry
with the same `--request-id` returns the thread already started.

`projects` prints one row per project: its id, name and folder, `(this
thread)` on the caller's own, `no-git` on a folder `--worktree` cannot use and
`drafts` on the drafts project. Archived projects are left out, although
`thread new` and `thread move` still accept them by name.

`projects add` registers an existing folder as a project, as the owner does
from the sidebar, so `thread new` and `thread move` can name it. A relative
folder is read from the agent's working directory; `--name` replaces the
folder's name. The project appears in the sidebar at once, the calling
thread's timeline gets a line naming it, and the owner removes it like any
other. A folder that is already a project, an archived one included, is
printed as it is with "Already a project; nothing changed." and costs nothing.
Registering a folder gives the agent no file access its process lacked. It
reaches outside the thread's project, so the Communication settings decide as
they do for `thread new` elsewhere: Off, Pause and a thread restricted to its
own project refuse it. There is no hourly limit. A thread an agent started
adds none until the user has written in it, and delegated children, workflow steps and persistent agent
sessions are refused.

`attach` saves a snapshot referenced by an assistant message, so it remains downloadable from
desktop and paired phones after the original changes or disappears. The thread
must have a turn and must not be archived. Images, videos and audio appear
inline by default. PDF and local file previews are under the
[Chat files and previews](chat-files.md) switch, on by default.
When the agent continues working after publishing, new text and tool cards
appear below the files. Updates to tools already running stay on their original
cards. Publishing a file does not end the turn.
Folding an earlier card keeps a reader following the newest output at the bottom.
Scrolling up or navigating with the keyboard releases that follow.

Clicking an image opens the zoomable viewer. For other files in the desktop app,
clicking the name or icon saves it in the system's Downloads folder and opens it.
The shell's attachment commands open only
pictures, PDF, text, audio, video and office documents. It shows any other type
selected in its folder, so an agent cannot run a program through that click.
The download button saves the file without opening it. Files above 5 MB stream
directly into Downloads and receive a numbered name if that name is taken.
Smaller inline files with the same name and bytes reuse the existing copy. In a browser the name
opens a picture full size and downloads anything else. A picture's preview also
opens it full size.

Task ids are `t1`, `t2` and so on, allocated by the CLI; `start 2` and
`start t2` mean the same. `task` rows print as `t1 [ ] text`, `[>]` in
progress, `[x]` completed. A todo is a card of the project's list, shared by
every thread of the project: an agent adds one or claims one, which marks it
finished and awaiting the user's confirmation; `done` and removal are the user's
in the Tasks surface. An agent's add is refused once the project holds 200 open
or claimed cards, with the count in the refusal; the user's adds have no limit.

`ask` draws a question card in the thread without stopping the agent: the
thread does not turn `waiting` and the card stays open after the turn ends.
A core restart keeps it too: an open card is read back from the journal at
startup, for as long as events are kept (30 days).
Each extra argument is an option label; with none the question takes free
text, and `--multiple` lets the user pick several. The answer reaches the agent
as a message that quotes the question, `> question` then the answer: steered
into the running turn when the agent takes steering (Codex, pi, Muse, Grok),
handed to Claude at the main agent's next tool call through the PostToolUse
hook, otherwise sent as the next prompt once the thread is idle. A prompt the
user queued meanwhile goes out after that turn, not in its place. Agents
without asynchronous questions of their own are told about the command once per session,
unless the "Asynchronous
questions" setting is off. Codex asks natively (`delivery: "async"`), and
Boite draws those cards the same way.

Exit codes: 0, 1 on a refusal or a failure (`error: ...` on stderr), 2 on a
usage error (the usage text on stderr).

[Agent coordination](coordination.md) is on by default for ordinary
conversations, across projects and linked machines. The owner can turn it off
or restrict it to one project. `agents find`, `agents read` and the directory
reach only those contacts. Replies preserve their message reference and
authenticated sender identity.

The singular `agent` commands belong to [persistent agents](agents.md), not
ordinary thread coordination. They use the calling session's current scope.
Pass `--request-id <stable-id>` when retrying a send, artifact or decision after
a lost response. The same flag covers `agents send`, `agents reply`,
`delegate spawn` and `delegate send`: a retry with the id of a call that already
landed returns that letter or child instead of making a second one. Without the
flag each call gets a fresh id. An artifact object contains `missionId`, `taskId`, `title`,
`summary`, `paths`, `commit` and `verification`. A decision contains `prompt`
and `options`; it yields execution until the user answers. A memory contains
`title` and `text`, with `id` and `expectedRevision` for an edit. The core adds
the source context. Use `--json` to preserve the structured result.
[Delegation](delegation.md) runs each child on the model and reasoning level
the agent names (`delegate models` lists them), else on the conversation's own
route or an owner-added profile, and records team usage. Children share the parent's checkout, retain their own sessions,
and return bounded results automatically. `delegate stop` pauses the whole team;
only the owner can change profiles or resume a paused team.
[Workflows](workflows.md) run a JSON plan of such children: `workflow help`
prints the whole format, `workflow run` starts it and opens it in the panel,
and the results come back as one message when the run ends.

## Owner diagnostics

Outside a thread, an owner can read recent structured diagnostics without
selecting a conversation:

```sh
boite logs --limit 50 --level error
boite logs --thread <thread-id> --limit 100 --json
boite logs --data-dir <data-directory> --level warn
```

The CLI reads the owner credential from that core's `core.json`. `--thread`
filters the history; it is optional. Each text row carries timestamp, level,
source/event and available thread, turn and request correlation. `--json` keeps
the record fields. [Trace](trace.md#structured-diagnostics) owns rotation,
redaction, output exclusions and query bounds. Inside a thread the CLI remains
an agent and cannot gain this access by changing a data-directory flag.

## Where the command lives

`boite` invokes `boite-core cli`, sharing the installed executable. Packaged
runtime and resource paths are described in [releasing](releasing.md).
`packages/core/shims/boite` and `boite.cmd` provide POSIX and Windows launchers;
source runs use the equivalents under `packages/core/bin/` through Bun.
The shell supplies `BOITE_CORE_EXECUTABLE` and a resource `BOITE_CLI_DIR` for
packaged launches. Standalone cores resolve their executable beside the shim.
Paths with spaces are quoted. An explicit `BOITE_CLI_DIR` overrides lookup;
a directory without the expected shim refuses startup.

The `panel.open` request becomes a `panel.requested` event on every client
subscribed to the thread; [panel.md](panel.md) says what the UI does with it.
