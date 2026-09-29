# The `boite` CLI

`boite` is the command an agent runs inside a thread to reach Boite: where it
is, what to show in the thread's panel, its task list, the project's todo list,
the state of the working tree. It answers in a few `key: value` lines or one
row per item, so a model reads the result at the lowest cost. `--json` on any
command prints the raw RPC result instead, for a script.

Boite 2 has no MCP server, on purpose. A CLI on the PATH costs the agent
nothing until it is called, needs no tool schema in the prompt, and works the
same for every provider, including one that has no MCP client.

Every new native agent session receives a compact CLI guide before its first
request, even without a connected brain. Enabled coordination and delegation
add their commands and current limits; workflow syntax is loaded on demand
through `boite workflow help`. The guide never creates a file in the brain or
project. [Brain settings](brain.md#boite-guide) describes its switch.

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
one thread. An agent reaches the methods listed in `AGENT_METHODS`
(`packages/core/src/access.ts`) on its own thread and nothing else: a call that
names another thread, or an owner-only method such as `files.write` or
`trace.get`, is refused by name. The token is forgotten when the thread is
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
boite attach <file>               publish a file snapshot in chat, at most 5 MB
boite show <file>[:line]         open the file in the panel, at that line
boite diff [file]                open the changes surface, or one file's diff
boite browse <url>               open the url in the panel's browser (http, https)
boite browser run <request.json> delegate a bounded Jev browser task
boite browser list               task progress and results for this thread
boite browser cancel <id>        stop one browser task
boite open trace|tasks|changes|files [dir]
boite status                     git status: branch, upstream, one row per change
boite ask <question> [option ...] [--multiple]
boite task list|add <text>|start <id>|done <id>|remove <id>|clear
boite todo list|add <text>|claim <id>
boite agents list|inbox
boite agents send <core-id>/<thread-id> <text>
boite agents reply <message-id> <text>
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

The browser request file is read locally by the CLI. Its schema and the
owner's setup are in [browser automation](browser-automation.md).

Persistent agents with the `routines` tool enabled can schedule work from their
direct conversation. `agent schedule` accepts `name`, `prompt`, and `schedule`,
for example `{"kind":"daily","time":"09:00","timezone":"Europe/Paris"}`.
Other schedules use `{"kind":"interval","everyMinutes":60}` or
`{"kind":"once","at":1790240400000}` with a Unix timestamp in milliseconds.
To edit or pause a routine, include its `id`, `expectedRevision` and `enabled`.
The host enqueues occurrences even when clients are closed. An unfinished
occurrence blocks overlap and missed intervals never create a catch-up burst.

Panel paths are resolved against the current directory and must stay inside the
thread's working directory; the core refuses the rest by name. `show src/a.ts:12`
opens the file at line 12. A `show`, `diff`, `browse` or `open` answers
`shown: yes` when a client subscribed to the thread received the request, and
`shown: no ...` when nobody was watching: the request still lands on the
thread's panel and is there when the thread is next opened.

`thread move` moves the calling thread, and only it, to another project the
owner already added: `agent.move` holds the token to its own thread, and the
project is named by its id, its name in any case, or its absolute folder. A
name two projects share is refused with both ids. The agent's process cannot
change folder in the middle of a turn, so the move waits for the turn to end
and the CLI answers at once with what will happen:

```
Moves to notes (C:\src\notes) when this turn ends; the next turn starts in C:\src\notes.
```

A thread idle at the time (a script outside a turn) moves on the spot. The move
is the same one the user makes from the thread menu (see
[development](development.md#moving-a-thread)): a thread that had a worktree
of its own gets a new one in a target that is a git repository, the old folder
is left as it was, and background work the agent left running stops, since the
agent asked to leave. The agent already knows about the move, so no note is
added to its next prompt; the timeline shows "Moved by the agent to
<project>". Refusals name the field and the expected value: an unknown project
(`project`), the thread's own project (`projectId`), a sub-thread, or a
sub-thread still working. A worktree with uncommitted changes is not refused:
nothing in the old folder is touched. A move that became impossible by the
turn's end (the project removed meanwhile) leaves a system line in the thread
saying why. Until then the thread's row shows "Moves to <project> after this
turn", and the user can cancel it or replace it with a move of their own, which
waits for the same turn end. A pending move lives in memory: a core restart
before the turn ends drops it.

`attach` saves a copy in an assistant message, so it remains downloadable from
desktop and paired phones after the original changes or disappears. The thread
must have a turn and must not be archived. The optional rich preview is under
the [Chat files and previews experiment](experiments.md#chat-files-and-previews).

Task ids are `t1`, `t2` and so on, allocated by the CLI; `start 2` and
`start t2` mean the same. `task` rows print as `t1 [ ] text`, `[>]` in
progress, `[x]` completed. A todo is a card of the project's list, shared by
every thread of the project: an agent adds one or claims one, which marks it
finished and awaiting the user's confirmation; `done` and removal are the user's
in the Tasks surface. An agent's add is refused once the project holds 200 open
or claimed cards, with the count in the refusal; the user's adds have no limit.

`ask` draws a question card in the thread without stopping the agent: the
thread does not turn `waiting` and the card stays open after the turn ends.
Each extra argument is an option label; with none the question takes free
text, and `--multiple` lets the user pick several. The answer reaches the agent
as a message that quotes the question, `> question` then the answer: steered
into the running turn when the agent takes steering (Codex, pi, Muse, Grok),
handed to Claude at the main agent's next tool call through the PostToolUse
hook, otherwise sent as the next prompt once the thread is idle. A prompt the
user queued meanwhile goes out after that turn, not in its place. Agents
without asynchronous questions of their own are told about the command once per session, unless the "Asynchronous
questions" setting is off. Codex asks natively (`delivery: "async"`), and
Boite draws those cards the same way.

Exit codes: 0, 1 on a refusal or a failure (`error: ...` on stderr), 2 on a
usage error (the usage text on stderr).

[Agent coordination](coordination.md) must be enabled by the owner before an
agent can send messages. The directory includes only authorized contacts.
Replies preserve their message reference and authenticated sender identity.

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
[Delegation](delegation.md) uses owner-approved model profiles and records
team usage. Children share the parent's checkout, retain their own sessions,
and return bounded results automatically. `delegate stop` pauses the whole team;
only the owner can change profiles or resume a paused team.
[Workflows](workflows.md) run a JSON plan of such children: `workflow help`
prints the whole format, `workflow run` starts it and opens it in the panel,
and the results come back as one message when the run ends.

## Where the command lives

`boite` is `boite-core cli`: the same executable, one more subcommand, so the
installer carries no second Bun binary. On Windows, where the sidecar is the
runtime and the core a bundle beside it ([releasing.md](releasing.md)), both
shims pass `core/main.js` before the subcommand. Two shims put it on the PATH,
`packages/core/shims/boite` for a POSIX shell (Git Bash included) and
`packages/core/shims/boite.cmd` for cmd and PowerShell; `stage-sidecar.ts`
copies both beside `boite-core.exe` and the bundle overlay lists them as
resources. Linux and macOS packages keep those resources apart from executables.
The shell sets `BOITE_CLI_DIR` to the resource directory unless explicitly
overridden, and `BOITE_CORE_EXECUTABLE` to the installed core's absolute path.
The POSIX shim quotes that path, including spaces in a macOS application name.
Standalone core installs still find the executable beside the shim.
From the sources, `packages/core/bin/boite` and `boite.cmd` run the
same subcommand through `bun`, and the core puts that directory on the PATH
when it runs from the sources. `BOITE_CLI_DIR` overrides the directory in both
cases, and a core refuses to start on one that holds no shim.

The `panel.open` request becomes a `panel.requested` event on every client
subscribed to the thread; [panel.md](panel.md) says what the UI does with it.
