# The `boite` CLI

`boite` lets an agent reach its thread's panel, tasks, project todos and Git
state. Human-readable output uses key/value lines or rows; `--json` returns the
RPC result for scripts. The command loads on demand and works with every driver,
including providers without an MCP client. The CLI also exposes a bounded set of thread-scoped tools through
`boite mcp` for providers with an MCP client.

The global flags (`--json`, `--thread`, `--data-dir`, `--core`, `--channel`)
are read anywhere until a command's own text begins. The table `OWNED` in
`packages/core/src/cli-args.ts` names the commands that parse their own flags
and where their text starts: after `boite browser fill <target>`,
`browser run <script>` (`-` for stdin), `browser recipe run <name>`,
`browser recipe save <name> <file|->`, `browser eval` or `secret ... --`,
every word is the command's, so `boite browser fill '#q' --json` types
`--json`. Before that text, `--` ends Boite's flags and hands every later word
to the command: `boite task add -- --json` adds the task `--json`, and
`boite browser run -- batch.js --core x` passes `--core x` to the script.
`secret run|pipe` reads its own `--`, before the child command.

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
fork summary merge-back, plan get/set, asynchronous questions and settings cards. Every call injects the authenticated
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
`@modelcontextprotocol/server` 2.3.1 and Zod 4.6.7 in `packages/core/package.json`.
The source CLI dispatch is included in the normal core build and sidecar, so
no extra executable or staging path is required. See the official SDK
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
tab closes, or once the browser or Boite restarts. A second account the agent
must keep, beside the default profile's, goes in a profile of its own:
`boite browser profiles add "Account B"` adds one to that machine's list (a name
already listed answers that profile), then `open <url> --profile "Account B"`.
An agent can add a profile, never rename or delete one: that stays in Settings.
`tab list` names each tab's profile, `tab new <url>` opens another,
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
just like web search results. A frame from another origin, such as a payment
form, a captcha or a sign-in widget, is listed under its iframe, and its
elements take refs and commands like the page's own
([frames](browser.md#frames-from-other-origins)).

Each separate command waits for the agent's next turn, and that turn takes far
longer than the command (about 40 ms). Steps the agent can foresee go in one
shell call that ends on a snapshot:
`boite browser click @e3 && boite browser wait --load load && boite browser snapshot -i`.
Steps with loops or conditions go in a script: `boite browser run <file>`, or
`run -` with the script on stdin, runs it as the body of an async function
with `page`, `args` (the words after the script), `console` and `sleep(ms)` in
scope. `page` has a method per command (`page.click('@e3')`,
`page.snapshot({ interactive: true })`, `page.wait({ url: '**/done' })`,
`page.eval((a, b) => a + b, 1, 2)`), and `page.command(...words)` runs any
other in the CLI's words. A step that does more than succeed prints what it
did, without the text a `fill` typed; a failed step stops the script, and the
output names it and shows the page's interactive snapshot. What the script
returns is printed. The script runs in the CLI's process with the agent's own
rights and reaches the browser through the same calls as each command
(`packages/core/src/browser-run.ts`).

`boite browser network` lists the calls the page makes to its servers once
capture has started, and `browser network <id>` shows one with its
credentials hidden and the `page.fetch(url, { method, headers, body })` line
that repeats it from a script, with the page's cookies
([network calls](browser.md#network-calls)). A script that works can be kept
as a recipe: `boite browser recipe save <name> <file|-> --about "..."
[--usage "..."] [args...]` keeps it once a run passes, `recipe list` shows
them, `recipe run <name> [args...]` runs one, and a run that fails says how
to repair and save it again ([recipes](browser.md#recipes)).

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

`downloads` lists the files the conversation's pages downloaded, with their
state, size, kind, sha256, source and a warning when the kind calls for one.
They wait in a quarantine of the core ([downloads](browser.md#downloads)) until
`download save <id> [path]` copies one into the working directory without the
execute bit and never over another file; `download wait <id>` waits for one
still running and `download discard <id>` drops it. A command that started a
download lists it in its output.

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
`key` and `close [--shutdown]` act on it. While the user's Device panel plays
the device's live stream (the `deviceStream` setting), `tap`, `swipe`, `type`
and `key` go through scrcpy and `type` accepts any text; `screenshot` stays
an `adb screencap` PNG. With a phone plugged in and the setting off, `list`
ends with one line that gives the `boite settings request deviceStream true`
command. Details and limits are in [devices.md](devices.md).

## Desktop windows

`boite window help` lists the commands. `boite window list` shows the desktop
windows of the machine that runs the core: id, process, PID, size, and whether
a window is minimized or excluded; a title only for an app the project allows.
`screenshot <target>` writes one PNG, `clip <target> --seconds <s>` one
labelled contact sheet (at most 10 s at 4 fps), and `watch <target>` shows the
window in the user's Window panel; `close` empties it. A target is `--id`,
`--process` or `--title`; several matches are refused with the candidates.
The answer gives the path, the size, the tokens the picture costs to read and
the window id. An app the project has not allowed waits up to 10 minutes for
the owner's consent card, so window requests time out after 11 minutes. Details
and limits are in [windows.md](windows.md).

## Pull requests linked to a conversation

`boite pr link <url>` verifies a GitHub pull request and saves its link in the
current conversation. Link each PR in a stack. `boite pr list` returns them
in dependency order; `boite pr refresh` updates titles and states from GitHub.
Without a refresh, a listed PR is read again at most once a minute, and one
saved as merged is kept as saved.
`boite pr unlink <url>` removes the saved link without changing the PR.
An agent can manage links only in its own conversation. Paired devices can
read the list. Lookup uses the local `gh` login and the configured `GH_HOST`.
At most 20 PRs can be linked to one conversation.

### Watching a pull request

`boite pr watch [<url|number>]` asks Boite to babysit a PR for the agent, so
the agent ends its turn instead of polling CI. With nothing named it watches
the conversation's only linked PR, or its only open one; a number names a
linked PR; a URL not linked yet is linked first. It prints what the first
read saw (head, checks running and failed, a conflict) and wakes nothing for
it. `boite pr unwatch [<url|number>]` stops one watch, or all of them.

The core (`packages/core/src/pull-request-watch.ts`) wakes the conversation
with one message, a `pull-request` turn, when:

- the first check of a head fails; failures after it on that head wait until
  no CI job runs and go out together as its verdict, unless only an aggregate
  gate is new (a required job such as `CI required` that started once every
  other job of its workflow ended); a rerun that fails again counts again;
- every check the base branch requires passed and no CI job still runs (every
  job when none is required), once per head; again when a required check
  appears already passed or after one of them failed. The base branch's
  rulesets and classic protection name the required checks in advance: one
  that has not reported on the head yet, such as a job created once its
  dependencies ended, counts as running, as GitHub's "Expected". A draft,
  which cannot merge, waits only for the required checks it reports: a
  repository may keep a required name for its ready run alone. A commit status such as
  CodeRabbit's holds nothing while it stays pending, unless the base branch
  requires it or commit statuses are the only checks;
- someone other than the account `gh` signs in as posts a comment, a review or
  an inline review comment, replies included. From a bot, a review counts
  when it names findings (`Actionable comments posted` above zero, outside
  diff comments, changes requested), and its summary (CodeRabbit's
  walkthrough, mtsu-patrol's) only when rewritten to name findings. A bot's
  other rewrites, an empty review, a reply in a thread that only agrees with
  the agent's answer ("Thanks for the fix", "I withdraw this finding", with no
  "but", "still" or "incomplete") and a notice that it will not review (quota,
  rate limit, review skipped) wake nothing. A body already read, its HTML
  comments and spacing aside, never wakes twice;
- the branch starts to conflict with its base;
- the branch falls behind a base that requires branches up to date before
  merging (GitHub's `BEHIND` merge state), once until an update clears it,
  and never while it waits in the merge queue, which updates it itself;
- it leaves the base branch's merge queue still open: a check of its merge
  group failed, it conflicted there or someone took it out. A merge seen on
  the same read is the only news;
- someone other than that account merges or closes the pull request.

The message names each change with its link. A change waits 20 seconds for
the rest of its burst and for a running turn to end, then everything waiting
goes out together; the same state never wakes twice.

Each watched PR costs one GraphQL query a minute, a fingerprint of its state,
mergeability, merge state, head, place in the merge queue, check counts by state, comment and review counts, edits
and `updatedAt`. Only when it moves does the core read the checks one by one
(with whether each is required) and the comments, reviews and inline comments,
100 a page up to 10 pages each; remarks are read again every 30 minutes
regardless, for edits the fingerprint cannot see. What the base branch
requires costs two REST reads (`rules/branches/<base>` and
`branches/<base>`) per repository and base every 10 minutes, shared by every
watch on it; a 404 means nothing is required. Once they answered, the rules
alone say which checks are required, so a context they drop stops counting at
once; each check's own `isRequired` stands only while they never answered. The rules are not in the
fingerprint: when they expire, the next pass reads them even if the
fingerprint stood still and judges the checks it last read against them, with
no detail read (one detail read after a restart, which keeps no checks). A
failed read is logged, keeps the last answer (or the checks' own `isRequired`
when there is none), is tried again after two minutes and neither pauses nor
ends the watch; a rate-limited one pauses every read like any other. GitHub's rate limit pauses
every read, from two minutes doubling up to 15; an unreachable GitHub or a
missing `gh` pauses that watch the same way. Neither ends it, even when the
failed read is the one that asks who merged or closed it.

A watch ends on merge or close, on Stop, on archive or Mark done, on removal
and on unwatch. It survives a core restart (`pr-watches:<thread>` in the
journal settings). A thread at rest reads as watching, not done, in the
sidebar while a watch waits on GitHub: not read yet, checks running on the
head, or the PR in the merge queue, whose checks run on the merge group and
never show on the head. Its tooltip gives the queue position. Once the checks
settled out of the queue the agent has its answer and the thread reads as
finished, though the watch stays for reviews and conflicts. The thread header carries a chip with the watched numbers;
its menu shows each watch's last status and stops one, on a phone too. The
owner's Tasks panel lists them the same way. A paired phone may stop a watch,
never start one. A delegated agent watches its own PR like a conversation:
each wake is its next turn, and that turn's answer goes to its parent as a
result. Its watches end when it is stopped (its own Stop, `boite delegate
stop`, its turn failing) and when its parent stops, is archived or is
removed. Workflow steps and goal reviewers cannot watch: their run or their
goal owns the work. A bot's thread watches like a conversation.
At most 10 PRs per conversation.

## How an agent finds the core

Every process a thread launches, the agent and whatever it spawns, carries
three variables and one PATH entry, put there by
`packages/core/src/threads/turn-context.ts` around the driver's spawn:

| Variable           | Value                                            |
| ------------------ | ------------------------------------------------ |
| `BOITE_THREAD_ID`  | the thread                                       |
| `BOITE_CORE_URL`   | the core's HTTP address                          |
| `BOITE_AGENT_TOKEN`| a token minted for this thread, in memory only   |
| `PATH`             | the directory holding `boite` and `boite.cmd` (and `boite.exe` in an installed Windows app), first |

The CLI says hello with that token and becomes the `agent` principal of that
one thread. `AGENT_METHODS` in `packages/contracts/src/access.ts` lists its allowed
calls and reasons. Each call is bound to that authenticated thread; delegation
and coordination additionally check relationships and authorized contacts.
An owner-only method such as `files.write`, `trace.get` or `core.logs` is refused;
the anonymized `diagnostics.*` view is the agent's ([diagnostics](#diagnostics)). The
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
`answer`, `permissions`, `allow`, `deny`, `projects archive|unarchive|remove`)
and `thread new` need no `--thread` from a terminal. There they use the owner
methods: `thread send` is the owner's own prompt, queued behind a running turn,
and `thread new` copies the agent of `--thread`, else of the project's most
recent thread (`--model` replaces the model). Inside the thread of
a [bot](bots.md#projects-entrusted-to-a-bot) the same words
reach the threads of the projects the owner entrusted to it and the threads
it started in any project, through `resident.*`, and its messages reach them as that bot's letters, never as the
user's. Deleting a thread and deciding a tool permission stay the owner's.

`boite threads` (or `boite threads list`) is one listing of the threads the
caller may see, with `--project <p>`, `--archived` and the machine of each.
The owner sees every top-level thread of this core. A bot sees the threads of
the projects entrusted to it, then the threads on its desk that are not among
them; each of those desk lines ends with `desk=started` (the bot started it),
`desk=entrusted` (the owner entrusted that thread to it) or `desk=followed`
(it wrote to it, answered for it or watches it). With `--archived`, the owner
and a bot see the archived threads instead of the open ones. Any other thread
sees the open threads coordination lets it reach, here and on linked machines,
and its `--archived` is refused.

The old spellings still work and print nothing more: `boite agents <x>` is
`boite threads <x>`, `boite agent <x>` is `boite bot <x>`, `boite settings
agent` is `boite settings bot` and `--agent <name>` is `--bot <name>`. Bots'
brains and the user's notes name them; `boite help` shows only the new ones
(`canonicalCommand` in `cli-args.ts`).

## Commands

```
boite where                      thread, title, project, cwd, branch, worktree, agent
boite thread move <project>      move this thread to another project (name, id or
                                 folder) when this turn ends
boite thread new <project> <brief> [--worktree] [--title <title>] [--machine <name>] [context flags]
                                 start a thread in a project, on this machine or
                                 another of the group; its first answer comes
                                 back as a message
boite projects                   the projects added to Boite
boite projects add <folder> [--name <name>]
                                 add an existing folder as a project
boite projects archive|unarchive|remove <project>
                                 the owner's; removing leaves the folder on disk
boite threads [list] [--project <p>] [--archived]
                                 the threads you may see and their machine
boite thread show <id>           state, pending questions and permissions, last answer
boite thread send <id> <text>    the owner's prompt, or the agent's letter
boite thread done <id>           put a thread that is not at work in Done
boite thread stop|archive|unarchive|remove <id>
boite thread rename <id> <title>
boite thread move <project> <id> move another thread
boite questions [<id>]           pending questions
boite answer <id> <question-id> <option|text ...> [--skip]
boite permissions [<id>]         pending tool permissions
boite allow|deny <id> <request-id>
boite attach <file>               publish a file snapshot in chat, at most 512 MB
boite view <file.html>            draw the page where a line ![title](file.html) of the answer places it, else at its end (--title <text>)
boite view check <file.html>      check without publishing; save PNGs at desktop/phone widths (--script checks.js, --scheme dark|light)
boite view help                   the rules of a page: layout, the app's look, theme, motion, checks
boite view example                a complete page in the app's look, to start from
boite preview <file.html>          open a local HTML artifact and its neighbouring assets
boite preview-close <file.html>    stop serving that preview
boite show <file>[:line]         open the file in the panel, at that line
boite diff [file]                open the changes surface, or one file's diff
boite browse <url>               open the url in a new tab of this conversation's browser (http, https)
boite open trace|tasks|changes|files [dir]
boite status                     git status: branch, upstream, one row per change
boite ask <question> [option ...] [--multiple] [--open <url>]
boite secret list
boite secret ask <NAME> --why <reason> [--placeholder <example>] [--timeout <minutes>]
boite secret write <ref> --env-file <path> --key <VAR> [--allow-unignored]
boite secret run <ref> --as <VAR> -- <cmd> [args ...]
boite secret pipe <ref> -- <cmd> [args ...]
boite task list|add <text>|start <id>|done <id>|remove <id>|clear
boite todo list|add <text>|claim <id>
boite threads inbox
boite threads find <words>
boite threads read <thread> [--last <n>] [--before <ms>]
boite threads send <thread> <text> [--wait] [--timeout <s>]
boite threads reply <message-id> <text> [--wait] [--timeout <s>]
boite threads log <thread>
boite threads wait [thread] [--timeout <s>]
boite threads contacts
boite threads ask <contact> <text> [--wait] [--timeout <s>]
boite bot memory
boite bot remember <fact>
boite bot routines
boite bot schedule <json>
boite bot unschedule <routine-id>
boite bot watch|unwatch <thread-id>
boite bot event <bot> [--key <key>] <text>
boite delegate models|profiles|list
boite delegate spawn <brief> [--model <provider/model>] [--effort <level>] [--speed <tier>] [--profile <id>] [--title <t>] [--worktree] [context flags]
boite delegate send <thread-id> <text>
boite delegate wait [thread-id] [--timeout <s>]
boite delegate result <thread-id> <turn-id> [offset]
boite delegate stop [thread-id]
boite delegate resume [thread-id]
boite workflow help|check|run|list|show|extend|pause|resume|stop|retry
boite workflow output|templates|save|start
boite help
```

The context flags, `--context light|neutral`, `--keep|--drop <parts>`,
`--tools <Tool,...>` and `--rules <text>` or `--rules-file <path>`, start the
thread without part of the user's setup ([context modes](context-modes.md)).
`--worktree` runs the child in a git worktree of its own instead of the
parent's checkout ([delegation](delegation.md#children-in-their-own-worktree)).
`delegate send` to a child that waits on a question answers that question, and
`delegate wait` returns `needs_input` as soon as a child asks something
([delegation](delegation.md#questions-from-a-child)).

Coordination commands are documented in [coordination](coordination.md#agent-commands),
child controls in [delegation](delegation.md#agent-commands), and plan/output
commands in [workflows](workflows.md#commands).

Bots schedule work from their own conversation. `bot schedule` accepts `name`, `prompt`, and `schedule`,
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
thread's panel and is there when the thread is next opened. `browse` opens its
page as a new tab of the conversation's browser instead, which becomes the
active tab of `boite browser`. A client watching the conversation brings it
forward; one that opens the conversation later finds it among the tabs without
the panel opening on it.

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
uses `threads send`.

The agent there reads a note before the brief: which thread's agent started
it, that the user did not type it, and that it grants no approval the user
did not give. When that first turn ends, its final answer, or its failure,
goes back to the starter as an [agent coordination](coordination.md) message
from the new thread, capped at 4,000 characters, and wakes an idle starter. Later turns
report nothing by themselves; the two agents
use `threads send` and `threads reply` like any pair of conversations. Both
timelines show a line linking the other thread: "Started by the agent of ..."
above the first prompt, "The agent started ..." in the starter.

The owner's Communication settings of the calling thread decide: Off refuses,
Pause refuses, and a thread restricted to its own project cannot start one
elsewhere. There is no hourly limit. A thread an agent started cannot start another
until the user has
written in it, so agents cannot chain threads on their own. Delegated
children and workflow steps are refused. A bot's thread is not bound by
these settings: Off, Pause and the own-project restriction do not refuse it,
so it starts threads in any project, where they land on its
[desk](bots.md#the-desk) and stay its own to drive; an archived bot starts
none. A retry
with the same `--request-id` returns the thread already started.

`--machine <name>` starts it on another machine of the same group, by its
name as Settings lists it, case and spaces aside (a core id prefix of six characters or more works too),
in a project of that machine named as it names its own. The thread there is
an ordinary one of that machine: its owner sees it in that machine's sidebar,
and the starter's line and the new thread's note name the other machine. It
runs on the caller's provider when that machine has an account signed in for
it, else it is refused; the model, effort and speed follow when that machine
lists the model, else its defaults apply. The first answer comes back the same
way, as a letter between the two machines, and `threads send <machine>/<id>`
steers it after. The caller's Communication settings decide as for a project
of its own machine, except that another machine is always "elsewhere": a thread
restricted to its own project cannot use it. The started thread obeys its own
machine's rule: it starts nothing until the user writes in it. A bot's thread
starts threads on its own machine only.

The machine that would hold the thread decides whether it accepts them: its
**Threads from the other machines** switch (`groupThreads`), on its row of the
group card, is off by default. While it is off the CLI is refused with
`<machine> does not let the other machines of its group start threads there;
propose the switch to the user with boite settings request groupThreads true
--machine <machine> --why "<what the thread is for>"`. Only a member of the
group can ask: a contact or a paired device has no such operation. From a
terminal, `--machine` is refused; `--core` reaches the other machine instead.

In a bot's thread, `threads`, `thread show|send|done|archive|unarchive|rename|stop|move`,
`questions` and `answer` also reach the projects of another machine of the
group entrusted to the bot ([bots](bots.md#projects-of-the-other-machines-of-the-group)).
Their threads are `<machine>/<thread-id>`, their rows end with
`machine=<name>`, and `--project <machine>/<name>` narrows the list to one of
them. A machine whose `groupBots` switch is off, or that does not answer, adds
an `unavailable: <machine> ...` line saying which, and a command on one of its
threads is refused with the same reason. With `--json` and no thread named, a
bot's `questions` and `permissions` print `{ questions|permissions, unavailable }`
rather than a bare list, so an empty list is not taken for nothing pending. The owner's own terminal does not
take `<machine>/<thread-id>`.

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
adds none until the user has written in it, and delegated children, workflow steps and bots'
threads are refused.

`view` publishes one HTML page as an [inline view](chat-files.md#inline-views):
its local files are embedded, a remote resource or a script error refuses it
with the line to fix, and it is drawn under the answer when the turn ends.
Run `view check <file.html>` first. It loads the embedded page with the view's
kit and sandbox at 816 px and 330 px content widths, saves PNGs with unique
names in the CLI's current directory, and creates no message, artifact,
browser tab or panel. Open both captures before publishing. The check uses
the app's fallback palettes and fonts, rather than a connected client's
custom theme or chosen fonts. `--scheme light` selects the light palette and
`prefers-color-scheme`; dark is the default.

`view check <file.html> --script checks.js` reads a local JavaScript file as
the body of an async function, without a function wrapper. It runs in the
page on a fresh load at each width. Use DOM clicks and input/change events,
await updates, throw when an assertion fails and return JSON results. The
command prints those results and saves captures after the script, even when
it throws. Any error or an unavailable browser returns a nonzero exit code
after available captures are saved. `--json` returns `checked`, `errors`,
`advice` and `captures` with `width`, `height`, local `path` and optional
script `value`; PNG bytes are omitted. Existing captures are never overwritten.
Fix errors and advice, rerun, open the captures and publish with
`view <file.html>`.

`preview` is for a site of several files the user browses in the panel.

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
in the Tasks surface and on the project board ([board.md](board.md)). An agent's add is refused once the project holds 200 open
or claimed cards, with the count in the refusal; the user's adds have no limit.

`ask` draws a question card in the thread without stopping the agent: the
thread does not turn `waiting` and the card stays open after the turn ends.
`ask list` lists the calling thread's pending questions without creating a
card, like `questions <thread-id>` for that same thread. `ask help` shows usage.
A core restart keeps it too: an open card is read back from the journal at
startup, for as long as events are kept (30 days).
Each extra argument is an option label; with none the question takes free
text, and `--multiple` lets the user pick several. `--open <url>` adds an Open
button for a page the user must sign in to (docs/browser.md). The answer reaches the agent
as a message that quotes the question, `> question` then the answer: steered
into the running turn when the agent takes steering (Codex, pi, Muse, Grok),
handed to Claude at the main agent's next tool call through the PostToolUse
hook, otherwise sent as the next prompt once the thread is idle. A prompt the
user queued meanwhile goes out after that turn, not in its place. Agents
without asynchronous questions of their own are told about the command once per session,
unless the "Asynchronous
questions" setting is off. Codex asks natively (`delivery: "async"`), and
Boite draws those cards the same way.

`settings` helps a lost user set Boite up. Bare, it starts with the app the
user last used and the language it speaks (`app: the desktop app on "PC"
speaks French; ...`), then lists the settings an agent may ask about, one row
each: key, value as JSON, the page and card it sits on and, quoted, the name
that app shows (`agentCpuCapPercent 75 resources#limits "Plafond CPU de tous
les agents"`). The list is `REQUESTABLE_SETTINGS` in
`packages/contracts/src/setting-requests.ts`, then that app's experiments as
`experiment.<id>` (`experiment.resident-agents true experiments#resident-agents
"Agents"`); credentials, account ids and browser profiles are not in it.

Language, experiments and names come from the apps: each says them after every
hello and on every change (`client.preferences`, a paired phone included), with
an id it keeps on the device (`boite.appId`). The core keeps them in memory
only, and reads the app that last sent a prompt or changed one of them; once
that app's socket closes, the next app to report takes its place. The language also rides on each prompt
(`SentFrom.language`), so the one-line note on where a prompt came from says
`which shows Boite in French` when a session starts and when the language
changes. Before any app reported, the first line says so and no experiment is
listed. A phone that follows the desktop app ([experiments](experiments.md))
reports the desktop app's switches as its own.

`settings request <key> <value> --why <text>` draws a settings card the same
way `ask` draws a question: the agent keeps working and the card outlives the
turn and a restart. The value is JSON when it parses (`60`, `false`, `null`,
`["https://a.example"]`) and the bare word otherwise. It is refused when the
key is not in the list (the refusal lists them), when `settings.set` would
refuse the value, when the setting already holds it (`experiment.resident-agents
is already true`: the agent learns the state before the user has to say it),
when a card on that key is already open in the thread, and for an experiment
when the value is not true or false or no app has reported yet.

`--machine <name>` asks about another machine of the group, for the settings
that machine holds about the others: `groupThreads` and `groupBots`. The card reads the
value there, names the machine, and its switch changes that machine's setting
when this window is connected to it with full control; otherwise it says to
change it from that machine. It settles when that machine reports the change to
the group; a `groupThreads` card also settles when a `thread new --machine`
there succeeds.

The card makes the change in the chat. A true-or-false setting, an experiment
included, draws its switch showing the value now; any other value shows the
current value struck through, the proposed one and Apply. The switch and Apply
call `settings.set`, the call the Settings page makes, so only the owner can
use them; an experiment's switch flips the device's own experiment, which any
of the user's devices may do, and stays free while the core has not heard it.
An experiment's card settles when an app flips that switch since its last
report, compared by the app's id so a reconnect still counts, or when the app
it was asked from reports another value, a flip made offline or across a
restart. Another app that merely has a different value, a language change or a
core setting moving settles nothing.
Show in Settings stays as a secondary button for whoever can apply. A paired
device answers a core setting's card with Refuse only. An open card's Open
Settings is offered to any client whose Settings draws that card. No button to Settings appears where the card is
missing: a paired device's Settings lacks the owner pages (Providers,
Plugins, Protection, Brain) and the owner's cards on shared pages (worktrees,
privacy, execution, browser origins, auto-compact), and a phone browser's
Settings lacks some cards of the computer's. The card never answers "applied"
itself: the core closes every open card whose setting left the value it was
asked from, whoever moved it, from the card or from the page. The agent then
reads `applied: <key> is now <value>` or `changed: the user set <key> to
<value>, not <proposed>`. Refuse sends `refused: <key> stays <value>`. A
sensitive setting (the network ones, the guards that keep agents quiet and
their memory protection, history retention and where worktrees go) is changed
in the card too, under a red shield, its heading "Sensitive setting" and a
line asking the user to check it first. Show in Settings opens the setting's
card, which rings once in the accent colour.

`settings open <page>[#<card>] --why <text>` points at a page for what is not
one value, a provider login (`accounts#provider-claude`) or a device to add
(`machines#machines`). Open Settings goes there with the same ring and sends
`opened: the user opened Settings at <page>`; Dismiss sends `dismissed`. The
MCP tools `boite_settings` and `boite_settings_request` do the same.

`settings bot [key]` reads a bot's settings a card may change: `name`,
`domain` (its role), `instructions`, `avatar`, `status` (`active`, `paused`,
`archived`), `projects` (those entrusted to it), `model`, `effort`,
`autoMemory` (the memory pass), `eventWakes` (automatic project and desk wakes),
`subagents` and `dailyBudget` (dollars a day,
or `null` for none). It prints the bot's name, each value and, for status,
projects, models and efforts, the choices; a model reads `<provider>/<model>`,
and its choices span every provider signed in on the machine. The listing cuts
long instructions and choice lists to their start, one key or `--json` prints
them whole. `--bot <name or id>`
names the bot; in a bot's own conversation it defaults to that bot.
`eventWakes` defaults to `false`: a bot wakes at once only for threads it
started, was entrusted or watches, and for outside events, while the other
project and desk facts wait durably for the next admitted routine. Setting it
to `true` wakes the bot for every fact. User messages and routines run either
way. Permission checks run again before delivery. Facts are
journaled with that routine once, including after a restart; failed admission
keeps them queued. Creation and instruction-change wakes keep their behavior.

`settings bot request <key> <value> --why <text>` draws the card. `name`,
`domain`, `instructions`, `avatar` and `status` take the words as typed
(`name Gargouille (Sécurité)`), and `instructions --instructions-file <path>`
reads a file; `projects` takes `+name -name` edits or a whole list
(`Notes,Other`, or JSON), resolved by name or id and stored as ids; a project
of another machine of the group is `<machine>/<name>` (`+skoll/Hearthfall`),
offered once that machine lets bots in (`groupBots`) and stored as
`<core-id>/<project-id>`; `model` takes `<provider>/<model>`
(`codex/gpt-6.1-sol`), or a model id of the bot's own provider; the other
keys read their value as `settings request` does. The refusals are the same, plus an unknown or ambiguous bot
(the refusal lists them) and a model on an account the owner granted only to
other bots. A model outside the bot's allowed routes joins them when the card
is applied ([bots](bots.md#asking-to-change-a-bots-settings)).

The card names the bot and the change; for projects, each project added or
removed has a tick the owner can clear before Apply. Apply calls
`agents.settings.apply`, owner only, which writes through the bot's own
settings checks. Any change to the bot, from the card or from its settings
page, settles every card it answers; a card about a bot that is archived or
removed closes unanswered. The asking thread reads `applied: <bot>'s <key>
is now <value>`, `changed: the user set <bot>'s <key> to <value>, not
<proposed>` or `refused: <bot>'s <key> stays <value>`, projects by name
(`are` and `stay` for them).

`settings bot create <name>` creates a bot at once, for a thread the user told
to set one up; no card asks the user. The bot runs on the calling thread's own
route unless `--model <provider/model>` names another (resolved as `delegate
spawn --model` does, from every installed model), at its model's default
effort unless `--effort` names one, with full access like a bot made on the
Bots page. `--domain <text>` is its role, `--instructions-file <path>` its
instructions (32,000 characters at most) and `--project a,b` the projects
entrusted to it, by name or id. A name a live bot already has, any case, is
refused with that bot's id, as are an unknown model or project. It prints
`created: <name> (<id>)`, its route, its projects and its conversation, to
reach it with `boite threads send`; the bot then introduces itself there. The
MCP tool `boite_bot_create` does the same.

Exit codes: 0, 1 on a refusal or a failure (`error: ...` on stderr), 2 on a
usage error (the usage text on stderr).

[Agent coordination](coordination.md) is on by default for ordinary
conversations and bots, across projects and linked machines. The owner can turn it off
or restrict it to one project. `threads find`, `threads read` and the directory
reach only those contacts. Replies preserve their message reference and
authenticated sender identity.

The `bot` commands belong to [bots](bots.md), not ordinary thread
coordination, and work only from a bot's own thread. `bot memory` prints
MEMORY.md and its path; `bot remember <fact>` adds a dated line to it. `bot
routines` lists its routines, `bot schedule <json>` saves one (`name`,
`prompt`, `schedule`, with `id` to edit one and `enabled`), `bot unschedule
<routine-id>` removes one. `bot watch|unwatch <thread-id>` puts a thread of
its projects on its desk or takes one off; a watched thread wakes the bot at
once, one it only wrote to waits for its routines. Use `--json` to
preserve the structured result.

`bot event <bot> [--key <key>] <text>` is the exception: it is for a service
outside Boite, never a bot's thread, and wakes the named bot (id or name) with
an outside event ([bots](bots.md#outside-events)). On the host it reads the
owner token from `core.json`; from another host it takes `--core <url>` with a
paired device's session token in `BOITE_TOKEN`. A second event with the same
key replaces one the bot has not read yet. Pair one device per service, so
the bot's prompt names it and revoking it cuts that service alone.
Pass `--request-id <stable-id>` when retrying a send after a lost response. The
flag covers `threads send`, `threads reply`, `delegate spawn` and `delegate
send`: a retry with the id of a call that already landed returns that letter
or child instead of making a second one. Without the flag each call gets a
fresh id.
[Delegation](delegation.md) runs each child on the model and reasoning level
the agent names (`boite delegate models` lists them), else on the conversation's own
route or an owner-added profile, and records team usage. `--speed <tier>` puts
the child on one of its model's speed tiers, such as `fast`; without it a
child has none, whatever the parent runs on. Tiers come from `boite delegate models`:
a spawn naming a speed on a model or profile on an agent-owned list not read yet is
refused and says to list the delegation models and spawn again. Children share the parent's checkout, retain their own sessions,
and return bounded results automatically. `delegate stop` pauses the whole team;
`delegate resume` lifts that pause, a crash's, or the owner's Stop once the
owner wrote again, continues the children whose last turn stopped, or only the
one named, and resumes the workflow runs a pause held
([delegation](delegation.md#stop-pause-and-resume)). Only the owner changes
profiles or lifts the pause set in Subagents > Settings.
[Workflows](workflows.md) run a JSON plan of such children: `workflow help`
prints the whole format, `workflow run` starts it and opens it in the panel,
and the results come back as one message when the run ends.

## Diagnostics

`boite logs` reads Boite's own diagnostics: the core, the desktop shell and the
clients. Lines are oldest first, one record each:

```text
2026-10-10 14:03:22.120Z ERROR shell main-thread/shell.main-thread.blocked main thread blocked for 6.2 s, command notify started 6.2 s ago and has not returned {blockedMs=6200, command=notify, commandRunningMs=6200}
2026-10-10 14:03:25.002Z INFO  core  turns/turn.finished [thr_x claude/claude-opus-5-5 <thr_parent turn=trn_y] (41.3 s) Turn finished: done {status=done, outputTokens=812}
```

```sh
boite logs --min-level warn --since 2h        # warnings and errors of the last two hours
boite logs --origin shell --min-level debug   # the desktop window's detail
boite logs --search memory-guard --since 1d
boite logs problems --since 24h               # grouped, with the threads they touched
boite logs export --out report.txt            # the anonymized file a developer reads
boite issue draft --title "Window froze" --description-file what-happened.md
boite issue submit --title "Window froze" --description-file what-happened.md
boite logs help
```

Filters: `--limit` (default 100), `--min-level` (default `info`), `--since`
(`30m`, `2h`, `1d` or a date), `--origin core|shell|ui`, `--search`. A value
that starts with `--` goes after an equals sign: `--search=--verbose`. Owner
only: `--level` (exact), `--turn` and `--anonymize`, plus the global `--thread`
to read one conversation. Agent only:
`--mine`, the thread and the threads it started without the records about no
thread; by default an agent reads those records plus its own family, never
another conversation's. `--json` keeps the records.

From a terminal outside a thread, the CLI reads the owner credential from that
core's `core.json` (`--data-dir` picks another) and prints the stored records,
credentials already removed. Inside a thread the CLI is that thread's agent:
it reads the anonymized `diagnostics.*` view, and only while the owner leaves
agent access on. Changing a data-directory flag does not change that.

`logs export` prints where the core saved the file (`<dataDir>/logs/exports/`)
and, with `--out`, also writes it relative to the working directory.
`issue draft` prints the issue body and a prefilled GitHub link without
sending anything. From the owner's terminal, `issue submit` creates it on
`mtsu-dev/boite` with `gh` when `gh` is signed in, or prints that link and the
export to attach. Inside a thread, `issue submit` publishes nothing: the
issue would be public and signed by the owner's GitHub login, so the agent
gives the user the link and the user submits it, or submits it from
Settings > Diagnostics. [Trace](trace.md#structured-diagnostics)
owns the record format, rotation, anonymization and query bounds.

## Where the command lives

`boite` invokes `boite-core cli`, sharing the installed executable. Packaged
runtime and resource paths are described in [releasing](releasing.md).
`packages/core/shims/boite` and `boite.cmd` provide POSIX and Windows launchers;
source runs use the equivalents under `packages/core/bin/` through Bun.
An installed Windows app also has `boite.exe` (`apps/shell/launcher`), which
Windows finds before `boite.cmd`. A `.cmd` runs through cmd.exe, which ends the
command at an unquoted `&`: from PowerShell, `boite browser open
'https://a.test/?a=1&b=2' --profile private` reached the core as
`browser open https://a.test/?a=1`. The `.exe` hands each argument over as it came;
`scripts/ci/installed-cli-windows.test.ts` checks it from PowerShell and cmd.
The shell supplies `BOITE_CORE_EXECUTABLE` and a resource `BOITE_CLI_DIR` for
packaged launches. Standalone cores resolve their executable beside the shim.
Paths with spaces are quoted. An explicit `BOITE_CLI_DIR` overrides lookup;
a directory without the expected shim refuses startup.

The `panel.open` request becomes a `panel.requested` event on every client
subscribed to the thread, except a url, which opens a browser tab and sends no
event; [panel.md](panel.md) says what the UI does with it.
