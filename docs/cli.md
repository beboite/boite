# The `boite` CLI

`boite` lets an agent reach its thread's panel, tasks, project todos and Git
state. Human-readable output uses key/value lines or rows; `--json` returns the
RPC result for scripts. The command loads on demand and works with every driver,
including providers without an MCP client. Boite exposes these tools through
its CLI rather than an MCP server.

Every new native agent session receives a compact CLI guide before its first
request, even without a connected brain. Enabled coordination and delegation
add their commands and current limits; workflow syntax is loaded on demand
through `boite workflow help`. The guide never creates a file in the brain or
project. [Brain settings](brain.md#boite-guide) describes its switch.
Task tracking is optional: agents use a task list only when laying out steps
helps them and the user follow the work.

## Test a page in the desktop browser

On Windows, enable **Agent browser control** in Settings > Experiments on the
hosting desktop, keep the conversation open in Boite and run `boite browser help`.
The switch is off by default. It lets the agent read and act in this conversation's
browser tabs, including signed-in sites and JavaScript execution. It uses the
browser's existing profile; this is not an isolated automation session.
`boite browser open http://localhost:3000` opens a tab and returns its id.
`snapshot` returns page text and unique CSS selectors; `click`, `type`, `press`,
`scroll` and `evaluate` interact with that tab. Add its id as the last argument
to target it explicitly. The agent cannot select a tab from another conversation.
Page text and evaluation results are untrusted input, just like web search results.

`boite browser screenshot --output <path>` writes a PNG to the chosen file.
Relative paths resolve from the working directory; absolute paths may point to
a temporary directory outside the checkout. The parent directory must exist,
and an existing file is never overwritten. Without `--output`, the command
creates `boite-browser-<uuid>.png` in the working directory; the caller owns
cleanup. Read it with the agent's image tool, or run `boite attach <path>` to
display a capture inside the thread's working directory in chat.
`resize 390 844` tests a narrow viewport. Fixed sizes retain their CSS resolution
and scale down to fit the panel, with pointer input mapped to the displayed page.
`reset-viewport` fills the panel again. The toolbar's size button also resets it.

Automation uses WebView2's native devtools channel, without a debugging port.
Only the owner UI can register a host or answer its requests. The agent token
can request actions for its own conversation only while the owner host has
explicitly granted access. Switching off the experiment, disconnecting or
closing the host rejects pending work. Actions already dispatched to a page
may finish and are not undone. Commands have a 20 second deadline. macOS, Linux and the
phone client do not provide automation yet. Every provider uses this same CLI;
no provider-specific integration or paid model call is needed for these tests.

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
token is read.

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
boite delegate profiles|list
boite delegate spawn <profile-id> <brief>
boite delegate send <thread-id> <text>
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
[Chat files and previews experiment](experiments.md#chat-files-and-previews).

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
[Delegation](delegation.md) uses the built-in conversation route or owner-added
profiles and records
team usage. Children share the parent's checkout, retain their own sessions,
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
