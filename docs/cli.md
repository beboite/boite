# The `boite` CLI

`boite` is the command an agent runs inside a thread to reach Boite: where it
is, what to show in the thread's panel, its task list, the project's todo list,
the state of the working tree. It answers in a few `key: value` lines or one
row per item, so a model reads the result at the lowest cost. `--json` on any
command prints the raw RPC result instead, for a script.

Boite 2 has no MCP server, on purpose. A CLI on the PATH costs the agent
nothing until it is called, needs no tool schema in the prompt, and works the
same for every provider, including one that has no MCP client.

## How an agent finds the core

Every process a thread launches, the agent and whatever it spawns, carries
three variables and one PATH entry, put there by `packages/core/src/threads.ts`
around the driver's spawn:

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

Outside a thread, `boite --thread <id>` reads the owner token out of
`core.json` like `boite-core pair` does (`--data-dir`, `--channel dev`) and
drives that thread as the owner. That is for a person at a terminal, not for an
agent: inside a thread, `--thread` naming another thread is refused before any
token is read.

## Commands

```
boite where                      thread, title, project, cwd, branch, worktree, agent
boite show <file>[:line]         open the file in the panel, at that line
boite diff [file]                open the changes surface, or one file's diff
boite browse <url>               open the url in the panel's browser (http, https)
boite open trace|tasks|changes|files [dir]
boite status                     git status: branch, upstream, one row per change
boite task list|add <text>|start <id>|done <id>|remove <id>|clear
boite todo list|add <text>|claim <id>
boite help
```

Paths are resolved against the current directory and must stay inside the
thread's working directory; the core refuses the rest by name. `show src/a.ts:12`
opens the file at line 12. A `show`, `diff`, `browse` or `open` answers
`shown: yes` when a client subscribed to the thread received the request, and
`shown: no ...` when nobody was watching: the request still lands on the
thread's panel and is there when the thread is next opened.

Task ids are `t1`, `t2` and so on, allocated by the CLI; `start 2` and
`start t2` mean the same. `task` rows print as `t1 [ ] text`, `[>]` in
progress, `[x]` completed. A todo is a card of the project's list, shared by
every thread of the project: an agent adds one or claims one, which marks it
finished and awaiting the user's confirmation; `done` and removal are the user's
in the Tasks surface.

Exit codes: 0, 1 on a refusal or a failure (`error: ...` on stderr), 2 on a
usage error (the usage text on stderr).

## Where the command lives

`boite` is `boite-core cli`: the same executable, one more subcommand, so the
installer carries no second Bun binary. Two shims put it on the PATH,
`packages/core/shims/boite` for a POSIX shell (Git Bash included) and
`packages/core/shims/boite.cmd` for cmd and PowerShell; `stage-sidecar.ts`
copies both beside `boite-core.exe` and the bundle overlay lists them as
resources. From the sources, `packages/core/bin/boite` and `boite.cmd` run the
same subcommand through `bun`, and the core puts that directory on the PATH
when it runs from the sources. `BOITE_CLI_DIR` overrides the directory in both
cases, and a core refuses to start on one that holds no shim.

The `panel.open` request becomes a `panel.requested` event on every client
subscribed to the thread; [panel.md](panel.md) says what the UI does with it.
