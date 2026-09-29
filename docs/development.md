# Development

When several worktrees build the shell, preserve the completed shell executable
and installer before another build replaces the shared Cargo output. Run shell
checks against that copy with `BOITE_E2E_SHELL_EXE`. Installer names and timestamps
alone do not identify the source branch. Verify the installed UI over CDP before
reporting a desktop installation complete.

When Cargo uses a shared target, preserve the shell executable, core and workers
from your build together before running end-to-end tests. Set
`BOITE_E2E_SHELL_EXE` to that preserved `boite-shell.exe`; the suite checks and
runs its adjacent sidecar rather than a binary another worktree can replace.

Everything below runs from the repository root, on a `bun install` that has
already happened. The rules these commands are meant to prove are in
[../AGENTS.md](../AGENTS.md).

## Desktop updater tests

Desktop updater checks use a local HTTP fixture and a signed inert payload in
`cargo test --lib`. The fixture never launches an installer. Its Windows test
executable links the shell's Common Controls v6 manifest too; without that
resource, loading the native dialog dependency fails before tests start.

`bun test tests/e2e/app-updates.test.ts` checks the update card, channel choice,
restart confirmation, progress, errors and absence of installer controls on a
phone. Development-only `?fake=1&appUpdate=ready` and the `downloading` and
`error` variants support captures without network updates. Set
`appUpdateChannel=nightly` to preview a nightly target and
`appUpdateCurrentChannel=nightly` for an installed nightly. These fixtures are
removed from production builds.

## The core

```bash
bun run dev:core            # bun --watch on packages/core/src/main.ts
bun run core                # the built bundle when there is one, the sources otherwise
```

The core prints one ready line on stdout and nothing else at start:

```
boite-core ready http://127.0.0.1:53421
```

That is the RPC endpoint a client connects to, and it is the whole line. No
pairing grant rides on it: a grant is a live session key, and a line printed on
every start ends up in log files, terminal scrollback and anything that reprints
stdout. A phone gets its link when the owner asks for one in Settings, or over
`pairing.grant` ([docs/phone.md](phone.md)). The core token is 32 random bytes
generated on first start and kept in `<dataDir>/core.json` with the port and the
pid, written `0600`; the shell reads it there, a test reads it there, and it
never appears on stdout.

One core per data directory. The first one to start takes `<dataDir>/core.lock`
and a second one refuses to start rather than rewrite the first one's live turns
as crashes. A lock whose holder is gone is taken over, so a core killed hard
leaves nothing to clean up by hand. Gone includes a pid another process wears
now: after a reboot, Windows can hand the dead core's pid to a browser tab, so a
holder that started more than 2 s after the lock was written does not count.
Windows reads the start time with `GetProcessTimes` and Linux from procfs; macOS
cannot say, and there a live pid still holds the lock.

Flags: `--port` (0 asks the OS for a free one), `--host`, `--lan` (which is
`--host 0.0.0.0`) and `--data-dir`. There is a fifth, `--channel`, which takes
`stable` or `dev` and nothing else: it picks the default data directory,
`boite2` or `boite2-dev`, and it is what the dev shell passes so the two installs
never share a journal ([docs/releasing.md](releasing.md)). `bun run dev:core`
passes none of them, so reach the entry point directly when you need one:

```bash
bun packages/core/src/main.ts --port 0 --data-dir /tmp/boite-scratch
```

The data directory is `--data-dir` when given, else `BOITE_DATA_DIR` when set,
else `%LOCALAPPDATA%\boite2` on Windows, `~/.local/share/boite2` on Linux and
`~/Library/Application Support/boite2` on macOS. On `--channel dev` that last
name becomes `boite2-dev`. It holds `core.json`,
`journal.db`, `accounts/`, `providers/` and the files of any managed install.
Never point a scratch run at the real one.

## The UI

```bash
bun run dev:ui              # vite on http://localhost:5173
bun run build:ui            # packages/ui/dist, which the core then serves at /
```

The UI keeps its transport behind one `Client` interface, so it runs on three
things: a WebSocket to a real core, a WebSocket to a remote core, and an
in-memory fake.

- In Vite development mode, `?fake=1` loads `lib/fake-client.ts` instead of the
  socket. No core, no agent, no tokens spent, and the whole contract answered in memory. This is what the
  UI tests run on and the fastest way to look at a screen.
- `?fake=1&long=1` adds a four-hundred-message thread, which is what the
  windowed message list is looked at on.
- `?fake=1&stream=tokens` streams answers and reasoning sixteen characters per
  delta, the echo driver's rate, instead of five deltas per answer, so a cost
  paid per delta shows. Tests pass `chunkSize` to `FakeClient` for the same.
- The app opens on a new thread's draft in the last used project, as if New
  thread had been pressed: the project last opened or drafted in on that
  device (kept per core in `localStorage`), else the project of the most recent
  thread, else the first one. `?fake=1&open=recent` opens the most recent
  thread instead, which is the page most captures and e2e tests look at.
- `?grant=<grant>` is a pairing link: the page exchanges it once for a session
  key of its own and stores that. `?token=<token>` opens the page on a token
  one already holds, and `?core=<url>` points it somewhere else, after asking
  when that core is new to the device. All three are stripped from the address
  bar; the grant is never stored, and the endpoint is stored only once it has
  answered a hello.

The service worker never registers under `?fake=1`, so a rebuild is always what
a reload shows.

Opening a project uses one dialog from the sidebar, the drafts' project menu
and `Work in a folder of mine`, settings and the command palette. Choose a machine, then type an absolute path or browse
its directories through the owner-only `projects.browse` method. The native
folder button is available only for the shell's local core. A folder dropped
from the desktop switches to that local core before opening the path.

Both sidebar views order threads the same way (`lib/thread-order.ts`): pinned
threads first, then a thread waiting on the user, then running, queued and failed
ones, then the rest by the user's last message. Under a project's header a row
leaves out the project name; Recent shows it.

The sidebar footer counts authenticated machine connections. Remembered cores
use separate sockets without thread subscriptions; failed connections retry
every thirty seconds. The menu names disconnected machines and opens connection
settings. The title bar has no second connection indicator.

Two menus open over the composer while typing, above the box, shortened to the
room left under the title bar, or below the box when that side has more room
(`lib/menu-fit.ts`). `/` on an empty box lists the
commands: the agent's own first (`Thread.commands`, whatever its protocol
reported), then Boite's, the same list as the palette, which the command
button at the foot of the sidebar opens without a keyboard. `@` at the start of a
word lists the project's files, ranked by `projects.files` on the word after
it, and the pick writes the path in as `@src/lib/store.ts`. That is plain text
in the prompt: Claude Code reads a mention as the file itself, every other
agent gets a path relative to its working directory. The core walks the project
once per query burst (a five second hold), skips `.git`, `.boite`, `node_modules` and the
names the root `.gitignore` lists outright, and stops at twenty thousand files,
saying so in `capped`. A glob or a negation in `.gitignore` is not read, so a
tree ignored through one still shows up in the menu.

A draft on a git repository has one more chip, `Worktree`. `Project.repository`
says whether the folder holds a `.git`, by the test the worktree refuses on. The
answer is the last check's: each answer starts the next check off the event
loop, one per folder at a time, so a folder that gains a `.git` says so on a
later answer, and a project on a share whose host is gone never blocks the core
(a synchronous check there froze it for 21 s). A check with no clear answer
keeps the last one. The core checks every project at start and on
`projects.add`; before any check has answered, the field is left out, and a
client that gets no field keeps the chip. On, the first send passes
`worktree: {}` to `threads.create` and the core runs `git worktree add -b`
before writing the thread: the branch is `boite/<slug of the title>` (`-2`,
`-3` when the name is taken, or the `branch` the call names), the directory
defaults to `<project>/.boite/worktrees/<slug>`. Settings > General > Worktrees
offers a shared folder instead, with `<project-name>-<project-id>/<slug>`
under it so repositories with the same name stay separate. On a phone, owners
reach the same setting through Settings > Worktrees. `settings.worktreeStorage`
stores `{ mode: 'project', directory: null }` by default or
`{ mode: 'shared', directory: '<absolute path on the core machine>' }`.
Changing storage affects new worktrees only. Existing threads keep their
`cwd`, and prepared agent workspaces retain their recorded path across restarts.
Nested worktree folders are excluded through Git's local `info/exclude`,
without changing `.gitignore`. The thread's `cwd` is that directory with
`branch` set, which the header shows as a badge. A project that is not a git
repository, a missing git, a branch that already exists: each is refused by
name and no thread is written. The git calls run under the thread's id, so
they are in its trace. Archiving the thread leaves the worktree and the branch
where they are: the branch may carry work nobody merged, and deleting it is a
person's call, made through `worktrees.remove`.

`worktrees.list { projectId }` reads `git worktree list` for the project's
repository and returns every linked worktree, including older storage locations
and any made by hand, but never the main checkout or the
project's own folder. Each entry says:

- `dirty`: `git status --untracked-files=normal` lists something, untracked
  files included.
- `unmerged`: HEAD is on no local branch or remote-tracking ref other than the
  worktree's own branch (`git for-each-ref --contains`), so removing the branch
  would lose those commits. A branch with no commit of its own is not unmerged,
  and a commit that also sits on another local branch is not either.
- `missing`: git still lists the worktree but the directory is gone.
- `threadId`, `threadTitle`, `threadArchived`: the thread whose `cwd` is that
  folder or inside it, without case on Windows, a live thread before an
  archived one.

`worktrees.remove { projectId, path, force? }` refuses, naming the field: a path
git does not list for the project, the main checkout, a worktree a thread that
is not archived stands in (even with `force`), and, without `force`, a dirty or
unmerged worktree ("This worktree has uncommitted changes.", "This worktree has
commits on no other branch.", or both). It then runs `git worktree remove`
(`--force` only when asked, since git refuses a dirty tree), `git branch -d` on
the branch (`-D` with `force`) and `git worktree prune --expire 1.hour.ago`,
never a bare prune: a folder in the middle of a rename would lose its
registration. A missing directory only loses its registration. `branchDeleted`
is false when git kept the branch, for example when its commits sit on a branch
not merged into HEAD. Both methods are owner only and run git under the trace id
`worktrees:<projectId>`.

An archived thread whose worktree was removed keeps its `cwd`. Restored, its
next `turns.start` or `threads.compact` is refused with the missing folder in
the message and `field: 'cwd'`; nothing recreates the worktree.

Archiving stops the thread's running turn, its pending questions and its child
agents, so the sidebar menu, the header and the palette ask first when the thread
is working, waits on an answer or has a live child agent. An idle thread archives
at once. Settings > General > Archived threads (on a phone, Settings > Archived
threads) lists the archived conversations and restores one to the sidebar;
stopped work does not resume. The General page reads the list only on its
button. The palette's Archived threads command and each project's `...` menu
open the same card with the list already read, and the phone's page reads it
when it opens. A restored row keeps its place with Open, which goes to the
thread. Under its rows, a project with archived threads shows a folded
"N archived" line; opened, it reads that project's archived threads and
restores one in a click. The fold is not remembered between sessions.

The project menu keeps New thread, Copy path, View archived threads and Manage
project, with distinct icons. The phone opens the same menu from the project's
header action button. Manage project opens a second menu with Back,
worktrees, icon refresh, session import when enabled, archive and removal.
Actions keep their owner restrictions; project archiving stays available to
paired devices. Copy path shows the path on hover.

Settings > General > Worktrees (owner only, also under each git project's
Manage project menu) lists every project's worktrees with what each would lose. "Remove the
clean ones" takes those that are neither dirty nor unmerged and hold no live
thread, without `force`. Files git ignores do not make a worktree dirty, as
for `git worktree remove` itself: dependencies and build output an agent left
there would otherwise mark every used worktree, and they go with it. Removing a dirty or unmerged one asks first, then
passes `force`. A worktree a live thread stands in cannot be removed.

`projects.archive { projectId, archived? }` flags a project archived (the
default) or brings it back, and `project.updated` tells every client. It moves
nothing else: the project's threads keep running and its worktrees stay. The
sidebar lists it under "Archived projects" with Restore, the landing and the
project pickers skip it, and a thread started in it brings it back. The drafts
project is refused. Each project also carries `archivedThreads`, the count of
its archived top-level threads, announced again with `project.updated` when a
thread is archived or restored. A paired device may archive a project: it is a
flag the owner undoes in one click.

### Moving a thread

A thread changes project from its row menu or its title menu ("Move to
project", which opens a picker of the machine's other projects, archived ones
marked), and on a desktop by dragging its row onto another project's section,
which takes the accent outline while the row is over it. The phone reaches the
same picker from the title's sheet. Only another project of the row's machine
takes a drop; the recent view has no project sections to drop on.

`threads.move { threadId, projectId, stopBackground? }` (`threads/move.ts`)
moves the thread and its sub-threads and answers the thread's new row;
`thread.updated` tells every client. What the core does:

- The working directory becomes the target's folder. A thread that had a
  worktree of its own (`branch` set) gets a new one in a target that is a git
  repository, placed and named as `threads.create` with `worktree: {}` does; a
  target that is no repository gives it the project folder, and the drafts
  project a new dated folder. The old folder, worktree or branch is never
  touched, so uncommitted changes in it are not a reason to refuse.
- The session follows only where the agent's resume takes a new folder: Codex
  (`thread/resume` carries `cwd`). Every other driver drops it, as an account
  switch does: the next turn starts a fresh session seeded with the journal's
  history (`continuation.ts`). Warm processes are keyed by folder in every
  driver, so none started in the old folder is reused.
- The next message carries a note the agent reads before the prompt ("This
  thread moved from project A (old folder) to project B (new folder). Your
  working directory is now ..."). It is kept in the journal (`move-note:<id>`)
  until that message, survives a restart, skips a slash command and a compact,
  keeps the first origin over several moves, and goes when the thread returns to
  where it started. The prompt shows the accent marker "Move explained to the
  agent", which opens on the note.
- A thread whose own turn runs, is queued or waits is not moved under the
  running process. The call returns at once with the row still in place and
  `pendingMove { projectId, project, by, at }` set, and the move happens when
  the turn ends, whether it finished, stopped or failed, through the same code
  path as the agent's own move (`ThreadMove.applyWaiting`, called by the turn
  runner). A turn queued behind it then runs in the new folder. Everything that
  can be refused is checked when the move is asked for; a refusal that only
  appears by the turn's end (the project removed meanwhile) leaves a system line
  in the thread saying why. The confirm says the move happens when the current
  turn ends; the row shows "Moves to <project> after this turn" in the accent,
  and so does the header (only the mark on a phone). A second move replaces the
  waiting one, "Cancel move" in the same menus drops it
  (`threads.moveCancel { threadId }`, refused naming `threadId` when nothing
  waits), and archiving the thread drops it too. The waiting move lives in the
  core's memory only: a core restart before the turn ends forgets it. The
  row stays draggable.
- A sub-thread with a turn in flight is still refused with
  `reason: 'turn-in-flight'` and `busyThreadId`: the parent's turn end is no
  moment to move a thread whose child still runs. The menu entry is off with
  that reason and the row cannot be dragged.
- Background work (a monitor, a shell the agent left running) needs
  `stopBackground`: without it the move is refused naming the field. The UI asks
  "Stop monitors" or "Keep them". `true` stops it; `false` leaves it running in
  the old folder until the next turn starts the agent in the new one. For a
  move that waits for the turn, the choice applies when the move does; a move
  asked for while no background work ran keeps any that started meanwhile.
- A target project that is archived comes back, as a thread started in it does.
- Refused by field: an unknown thread or project, the thread's own project, an
  archived thread, a sub-thread (it moves with its parent), a persistent agent's
  session, and a target whose folder is gone.

A paired device may move a thread and cancel a waiting move: it names a
project it already lists, never a path, and the core picks the folder
(`packages/contracts/src/access.ts`). An agent moves its own thread with
`boite thread move <project>` ([CLI](cli.md)), applied when its turn ends in
the same way; its move skips the note and the "Move explained to the agent"
marker, since the agent knows.

## Pending prompts, goals and loops

Enter during a running turn queues the message and its attachments. Each pending
message shows above the composer as a user bubble with a dashed outline. Up in
an empty composer takes the newest pending message out of the queue for editing;
clicking a pending message does the same. Enter again in the emptied composer,
or Send now under the bubbles, stops the current turn and sends the oldest
pending message next; the others wait for its turn. Escape stops the current
turn too. Pending messages then run in their original order. An Escape that closes something first (a popover, a menu, a
confirmation, the command palette, a rename field) only closes it, and the focus
goes back to where it was, or to the composer when that is gone, so a second
Escape is needed to stop. A failed send preserves the queue for an explicit retry.

The core can open a turn by itself as the previous one ends: answers to an
asynchronous question that could not be steered in, or an agent resuming on its
own. A prompt that reaches the core in that moment, sent from the box or from
the queue, is refused with `reason: 'turn-in-flight'` and the thread's row
(`TurnInFlightData`). That is not a failure: the composer applies the row, puts
the prompt back at the head of the queue without pausing it or showing an error,
and sends it once that turn is over.

`/goal <objective>` starts work toward an objective. `/loop 2 <prompt>` runs two
consecutive iterations and stops. Counts range from 1 to 1000. A count written
as "2 iterations" or "2 itérations" in the prompt is also recognized.
`/loop 5m <prompt>` explicitly schedules repetition, with the delay counted
after each finished turn. Intervals use `s`, `m` or `h`, from one second to
24 hours. A loop without a count or interval is refused; there is no default timer.
Both commands belong to Boite and work with every driver. Goals and loops can
coexist with the agent's task list above the composer. The compact overlay shows
the current task and progress. Only a click expands it; updates and disclosure
do not resize the timeline. An asynchronous question (`boite ask`, or Codex's
`delivery: "async"`) waits on top of that overlay with the same answer controls
as a blocking one. Several stack behind a pager ("2 of 3"), each keeping what
was picked while another shows, and a new one comes up open. The timeline keeps
one line where it was asked, and a click on it brings that question up. While
a question is open there, the timeline's bottom margin grows to the overlay's
height so the last answer stays above it; `tests/e2e/composer-activity.test.ts`
checks that at desktop and phone widths. Completed tasks and goals fade out on the next user
prompt, and newly reported work brings the task list back. Loop details show
the latest 50 iterations with their outcome and up to 4000 characters of result.

The core owns this work, so switching threads or closing a client does not
cancel it. A goal continues through scheduled turns until the agent emits
`[BOITE_GOAL_COMPLETE]` on its own line. The prompt requests that marker only
after verification. `[BOITE_GOAL_BLOCKED]`, an error or Escape pauses it.
Escape also pauses a loop between runs. The activity bar has pause, resume,
remove and manual goal completion controls. A restarted core preserves the
activity but requires an explicit resume.

Goal instructions are assembled only when invoking a driver. The journal stores
the visible `/goal` or `/loop` message with its kind and iteration in the text
part. The UI also cleans up goal prompts saved by older cores and hides standalone
completion/blocker markers, including partial markers during streaming.

Tasks come from ACP plans, Codex plan notifications or successful task tools
such as Claude's TodoWrite and TaskCreate/TaskUpdate. An agent that reports no
tasks gets no invented task list. Pi uses the same successful-tool observation.

Each connected provider's row in Settings, Providers stores a default model and
effort for that provider on this device.
Initial defaults are Opus 5 High, Codex GPT 5.6 Sol Medium and Grok 4.6
High. The account must offer the model; a first send probes when needed and
refuses an unavailable default by name. New thread uses these defaults;
Ctrl+Enter preserves the current explicit choice. Existing threads keep theirs.

## The echo provider

`echo` is the deterministic fake agent: it streams the prompt back, can call a
fake tool, can ask for a permission, can spawn a child process on request, and
never touches the network. It ships only when `BOITE_ECHO=1` is set, so a user
never sees it in the picker. The tests, the end to end suite and the bench set
it themselves; a core you start by hand without it lists the real providers
alone, and anything expecting an echo account fails on "no echo account". It
takes images: each one comes back as `[image <mime>, <bytes> bytes, <name>]`
in front of the echoed prompt, which is how a test proves an attachment reached
the agent. It lists two slash commands on every turn, `/shout <text>` (the text
back in capitals) and `/whisper`, so the composer's slash menu has an agent
group to show and a test can prove the picked command reached the agent. Its
context meter is 100 tokens plus one per character of the prompt on a window
of 2000, and `[compact]` in a prompt draws a compaction divider and drops the
reading to 300 ([context.md](context.md)).

```bash
BOITE_ECHO=1 bun run dev:core
```

`BOITE_HOST_AGENTS=0` keeps a core away from the agents installed on the
machine: the shipped providers still load but resolve no program, so no
version check, quota read or model probe runs the developer's own CLIs. The
test harness, the end to end suite, `bun run bench` and `bench/idle-rss.ts` set
it; an opt-in live test (`BOITE_E2E_*=1` or `BOITE_BENCH_*=1`) turns it back
off.

## Checks and tests

```bash
bun run check    # contracts, core, UI, end-to-end test, bench and telemetry Worker types
bun run test     # bun test in packages/core (parallel workers), vitest in packages/ui
bun run build:ui # required by the core-backed browser tests on a fresh checkout
bun run e2e      # tests/e2e
```

Run all three once on a clean tree before writing anything. A failure you did not
cause reads exactly like one you did, and that has cost time here before.

jsdom is held at 30.0.1, exactly, and Dependabot is told to leave it there.
Since 30.1.0, removing the focused element makes the next `focus()` fire a
blur aimed at the window ([jsdom#4347](https://github.com/jsdom/jsdom/issues/4347)).
Every menu here closes on a window blur, so a menu that opens right after
another one closed shuts itself in the same tick: two tests in
`packages/ui/src/app.test.ts` fail on it. Lift the pin once that issue is fixed.

`bun run e2e` builds the UI before loading any test. Tests earlier than
`ui.test.ts` also serve that build, so building only inside the UI suite leaves
them without a page in a fresh worktree.

`bun run e2e` covers three surfaces in one go: a real core process over WS with
the echo driver, the UI served by that core and driven in a throwaway browser,
and the release shell executable driven over the WebView2 debugging port. The
shell part runs with `BOITE_SHELL_HIDDEN=1`, which is the only way an agent may
ever start that executable: a window on the user's screen is forbidden.

### Contract scenarios

`tests/contract/scenarios.ts` holds the contract as behaviour: each scenario
drives methods through a small environment (`call`, `on`, a new folder, a
missing one) and throws on the first code, data key or event that breaks the
rule. It reads codes and data keys, never message text. Two runners share it:
`packages/core/test/contract.test.ts` against one echo core over WebSocket, and
`packages/ui/src/lib/fake-client.contract.test.ts` against the in-memory client.
Both finish in under a second. `KNOWN_DIVERGENCES` lists a scenario allowed to
fail on one side, with the reason; a listed scenario that passes fails its
runner, so a fixed drift leaves the list. The rules the fake repeats live in
`packages/ui/src/lib/fake-client/checks.ts`, and `settings.set` validation is
one function in the contract (`checkSettingsPatch`). What only one side can
show (a shell to close, a login to cancel, a device kept from owner events) is
in `packages/ui/src/lib/fake-client.parity.test.ts`. In the fake, a folder
under one named `missing` does not exist.

Vitest gives each UI test 15 seconds (`packages/ui/vitest.config.ts`); the
`waitFor` of `app.test.ts` stops at 8 seconds, so a slow wait fails with the
page's text rather than as a bare timeout.

## Rebuilding the shell executable

`bun run test:shell` runs the Rust unit tests. A full `bun run e2e` fails when
the shell executable or its workers are missing or stale. Set
`BOITE_E2E_SKIP_SHELL=1` only for an explicitly partial core/UI run. The browser
UI test file rebuilds its bundle, but other core-backed tests can run first.
Build the UI before the suite so those tests also load current assets.

The end to end run drives
`apps/shell/src-tauri/target/release/boite-shell.exe`, and the only command that
produces a working one is:

```bash
bun run --cwd apps/shell tauri build --no-bundle
```

`cargo build --release` in `src-tauri` compiles the same code and writes the
same path, but the executable it leaves there never reaches its own IPC: every
`invoke` came back with `Origin header is not a valid URL` and the UI never
connected, seven of the ten shell tests failing on it (2026-09-08). Use cargo to
find compile errors fast, never to produce the executable a test runs.

## Staging the sidecar

The shell test drives whatever `boite-core.exe` sits beside
`apps/shell/src-tauri/target/release/boite-shell.exe`. After a core change that
file is stale, and a stale core answers an old contract, which used to look like
a UI timeout. The suite now refuses it in milliseconds, naming the sidecar's
mtime, the newest core source and the fix:

```bash
bun run stage:core   # build:core:exe, then copy the exe and both workers into place
```

That script puts the compiled core in `src-tauri/binaries` for the bundler and
beside the release shell executable for the end to end run, with `jobs-worker.js`
and `guard-worker.js` next to each copy. Without the first the trace degrades
from exact events to polling; without the second the focus guard never starts.
On Windows the first staging downloads Bun's baseline runtime (a 40 MB archive)
for the Bun version running it and keeps it under `node_modules/.cache`
([releasing](releasing.md)).

## Captures

On desktop, the selected project sits above the sidebar and the conversation
title starts above the chat. Folding or resizing the sidebar adjusts the header;
the phone keeps its existing project navigation and conversation title.

`tests/e2e/header.test.ts` checks the shared header, sidebar folding and saved
state, project groups, machine menu ordering, and prompt navigation through a
paged, virtualized conversation. It captures desktop, phone and light-theme
layouts on the fake client. The shell suite checks that the thread controls sit
inside the same title bar and that dragging excludes editable controls.

The prompt outline uses at most 13 entries, keeping the first and last prompts
and seven around the reading position. Distant prompts are grouped behind a
keyboard-accessible list, so every loaded prompt remains reachable. Desktop
markers are 12 px apart; the compact activity panel sits 4 px above the composer.

In forced colors (Windows high contrast) the browser drops the shadows and
border tints the UI uses to mark focus. `app.css` then gives every
`:focus-visible` control a 2 px `Highlight` outline, and
`tests/e2e/readability.test.ts` checks it on the composer and the thread
search.

The fake client is excluded from production bundles. Its imports sit behind
`import.meta.env.DEV`, and because Rolldown still writes a chunk for a dynamic
import in a dead branch, `vite.config.ts` deletes that orphan chunk and fails
the build if a shipped chunk still names it. Tests that need it must
use the Vite development server. `tests/e2e/settings.test.ts` starts and closes
one within the test process; the other end-to-end paths use a real temporary
core with the echo driver.

A real core serves `packages/ui/dist`. `tests/e2e/ui.test.ts` and
`tests/e2e/cli.test.ts` call `ensureProductionUi` (`tests/e2e/lib/prod-ui.ts`),
which builds it again with `NODE_ENV=production` only when it is missing, older
than the UI sources, `packages/contracts` or `bun.lock`, or a development
build. A child of `bun test` inherits `NODE_ENV=test`, and Vite then builds a
development bundle that loads the fake client on `?fake=1`. `ui.test.ts` fails
if the bundle the core serves imports the fake client or carries Svelte's
development runtime.

`tests/e2e/model-switch.test.ts` changes an existing conversation from Echo to
an ACP fixture over real RPC and stdio. It checks history continuity and writes
desktop and phone captures without using provider logins. Core regression tests
also cover queued targets, stale selections, image transfer and schema migration.

`tests/e2e/project-picker.test.ts` covers folder navigation, a phone-width
dialog and an unreachable remembered machine. The shell suite checks the native
folder button with its dialog IPC stubbed, so no system dialog takes focus.

`tests/e2e/lib/cdp.ts` launches Chromium with `--headless=new`, on the real GPU
through ANGLE, muted, in a throwaway profile, and drives it over CDP.
`page.screenshot(path)` writes a PNG, and the suite puts its own under
`tests/e2e/.artifacts/`, which is git-ignored. That is the proof for anything
visual: a diff, a passing test and a green build all say nothing about what a
screen looks like.

`page.close()` kills the browser's process tree without blocking the other
closes, waits up to 30 s for the browser to exit, then removes its profile,
retrying for 15 s while Windows still holds a file. A directory it cannot
remove is printed as `e2e: left <path>`. The test preload removes `boite-e2e-*`
directories older than an hour, which an interrupted run left in the temp
folder, and closes any page a file left open when the run ends.
`tests/e2e/cleanup.test.ts` checks all three.

An end-to-end file serves the UI through `tests/e2e/lib/ui.ts`. `startUi` uses
the fake-client bundle in `BOITE_E2E_FAKE_UI` when set. With
`BOITE_E2E_PREBUILT_UI=1`, it builds one under `.artifacts/fake-ui-<pid>`, one per
test process, before browser interactions. The installer still uses the
production build, which does not enable the fake client. Without either, it
falls back to `startDevUi`. A file whose page imports `/src/...` calls
`startDevUi` directly. It transforms every module the page can load before
returning, so the first page load finds warm transforms.

`BOITE_E2E_BROWSER` overrides the browser lookup when the candidates in that file
find nothing. Helium is the last of them: on a fresh profile it reloads the tab
a few seconds after launch, so a test that acts in that window sees the page
boot twice, and its dictation tests fail.

## The opt-in live tests

These run a real agent on the user's own CLI login and spend real tokens, so
each one is skipped unless its variable is set. Run them from
`packages/core`, one at a time, and never from a loop.

| Variable | Test | What it proves |
|---|---|---|
| `BOITE_E2E_CLAUDE=1` | `test/claude.live.test.ts` | a real Claude turn, then a resume; the same session imported from `~/.claude/projects` into a new thread and resumed there; a warm thread on one process |
| `BOITE_E2E_OPENCODE=1` | `test/opencode.live.test.ts` | an ACP turn, then a resume on a new process |
| `BOITE_E2E_GROK=1` | `test/grok.live.test.ts` | an ACP turn on a named Grok model and effort, then a resume on a new process. It only ever uses the default account, which reads `~/.grok`: a Grok started on an empty `GROK_HOME` opens a browser |
| `BOITE_E2E_CODEX=1` | `test/codex.live.test.ts` | a Codex app-server turn and its resume |
| `BOITE_E2E_PI=1` | `test/pi.live.test.ts` | a pi turn and its resume |
| `BOITE_E2E_AGY=1` | `test/agy.live.test.ts` | `agy models` folded into models with effort levels, then one cold turn on `gemini-3.8-flash` at `low` with a one-word prompt, on the default account. agy must be installed and signed in |
| `BOITE_E2E_KEBACC_INSTALL=1` | `test/plugins.install.live.test.ts` | pinned native plugin download, version check and uninstall in a temporary directory; no login |
| `BOITE_E2E_ANTIGRAVITY_INSTALL=1` | `test/antigravity.install.live.test.ts` | the managed install for real: 468 MB from Google, the sha256 and every file size checked, `initialize` answered. No sign-in |
| `BOITE_E2E_ANTIGRAVITY=1` | `test/antigravity.live.test.ts` | the whole Google sign-in, in your browser, then one turn. Only a person runs this one |
| `BOITE_BENCH_CLAUDE=1` | `bun run bench` | the Claude turn row of the bench |
| `BOITE_BENCH_HOST_AGENTS=1` | `bun run bench/idle-rss.ts` | the steady idle point with the update check reading the agents installed on the machine, as a user's core would |

One more is opt-in for a different reason. `BOITE_E2E_GUARD=1` runs
`test/guard.e2e.test.ts`, which opens a real window and steals the keyboard focus
for a blink. Every other focus guard case is decided on a fake of the Win32
calls, so no other test creates a window.

## Phone checks

Voice dictation checks and the opt-in local Whisper smoke test are listed in
[voice.md](voice.md#verification).

`bun test tests/e2e/mobile.test.ts` runs the phone navigation, portrait and
landscape layouts, model sheet and browser Back, retained drafts, and the visible
message when returning to a long conversation. It uses the in-memory client in
a hidden browser. Captures go to `tests/e2e/.artifacts/mobile-*.png`.

`bun test tests/e2e/ui.test.ts` covers a paired device against a temporary real
core, device-only settings, revocation, reconnection and an offline app shell.
`packages/core/test/push.test.ts` exercises subscription ownership and lifecycle
with a substituted push sender. It does not prove delivery by a push provider.

For USB Android checks, use an isolated core data directory and an echo account.
Forward its port with `adb -s SERIAL reverse tcp:7337 tcp:7337`, then open the
temporary core's pairing link on `http://localhost:7337`. The browser treats
localhost as a secure context, so this exercises the service worker without a
public certificate. Remove the mapping with
`adb -s SERIAL reverse --remove tcp:7337` when finished. Actual keyboard resizing,
installation, suspension and push delivery still need a connected device;
external access needs the trusted HTTPS origin described in [phone.md](phone.md).

## Benches

```bash
bun run bench               # against Boite Legacy, writes bench/results/<date>.md
bun run bench/idle-rss.ts   # the core's idle memory against bare bun, at 4.5 s and 75 s (--fresh-only: 4.5 s)
```

Both set their own fresh data directory. Quote a figure with the date of the run
it came from, and rerun before quoting an old one.

## Architecture checks

Core tests default to 15 seconds per case because scripted driver tests start
several traced child processes. Their explicit protocol and shutdown deadlines
still apply. Override the default with `bun run --cwd packages/core test --timeout 5000`
when reproducing a timing failure. A slow assertion still fails; this timeout
does not retry or skip tests.

`bun run check` includes `bun run check:architecture`. The architecture check
uses Bun's parser and needs no installed workspace dependencies. CI runs it in
the changes job on every pull request. `bun test scripts/architecture` verifies
cycle detection, import resolution, the package boundaries and the size budget.

The same check fails when a production `.ts`, `.js` or `.svelte` file passes
900 lines. The files already above it are listed in
`scripts/architecture/size-budget.json` with the most lines each may have. A
file that grows past its entry fails; split it instead of raising the number.
When a file shrinks, the check prints a note, and
`bun run check:architecture --write-size-budget` lowers its entry to match, or
removes it once the file is back under 900. That flag never raises an entry.

The `exempt` entries of the same file have no ceiling, each with its reason:
`packages/contracts/src/index.ts`, which every RPC method changes first,
`lib/fake-client.ts`, which implements that contract, and the
`lib/strings.*.ts` tables, which gain an entry with every UI sentence.

`bun run check:architecture --rebaseline-size-budget` pins every file above 900
at its size today, raising or adding entries, and prints each raise. It exists
for one case: merging branches written before their files were pinned, on the
tree that combines them, so the raises are reviewed in that diff. Everywhere
else a file that outgrows its entry is split.

`bun run audit:complexity` ranks production functions by cyclomatic complexity.
Use `bun run audit:complexity --json` to save a comparison. It is advisory;
the [architecture guide](architecture.md#module-boundaries-and-complexity)
describes its scope and the module boundaries behind the checks.

## The worktree trap

An agent usually works in a detached git worktree of this repository, and the
private working notes under `.claude` are excluded from git, so no worktree has
a copy of them. A write to one of those files by absolute path lands in the
original checkout: outside the worktree, outside the branch, outside the commit,
and invisible to the review that follows. The tracked docs, this page included,
are the ones a worktree can actually change. Check where a file you are about to
edit really lives before editing it.


## UI spacing and motion

Composer menus use the browser's top layer through `lib/floating.ts`, including
effort, permissions and the slash and mention lists. Their position follows the
trigger and the available viewport, so the sidebar and glass composer cannot
cover them. Phone pickers share the bottom sheet; typing suggestions stay by
the composer.

The sidebar, right panel and terminal use the same short fade and vertical
movement. The terminal and right panel stay mounted through their exit, and
archive drawers use the shared grid fold. All durations honor reduced motion.

Unsent messages are saved in IndexedDB with strict transaction durability,
separately for each core and data directory. A small synchronous text backup
covers typing while a transaction is pending. A local core changing its port
keeps the same drafts.
New conversations keep one draft per project, visible in the sidebar after
opening another thread. Existing conversations keep their own unsent reply.
Queued messages are restored paused, so reopening the app does not send them.
The durable journal includes attachments and page references.
Storage failures show an error while retaining the text in memory.
Opening, reading or writing the journal has a three-second deadline, so blocked storage
cannot hold startup indefinitely. A failed read never replaces unread durable
drafts; its text backup is merged with them when storage becomes readable again.
Unavailable attachment bytes leave removable placeholders; their IDs survive
text edits, and removed IDs stay absent when storage recovers. Sending waits
until the remaining attachments are readable or explicitly removed.

`bun test tests/e2e/drafts-overlays.test.ts` checks reloads, forced browser exits,
menu stacking, panel exits and reduced motion, and writes desktop and phone
captures under `tests/e2e/.artifacts/`.

Settings pages share their width and card padding through `--settings-width`
and `--settings-padding` in `app.css`. A page that wraps its cards for a loading
state uses `settings-stack` on that wrapper. This keeps its cards on the same
spacing rules as direct children of a settings page.

A settings page shows titles and controls. The sentence saying what a page, a
card or a row is for goes in an `InfoTip` beside its title: a small "i" that
opens on hover with a mouse, on a tap with a finger (a sheet on the phone), and
closes on Escape or a press elsewhere. A muted `.hint` line stays in view only
for what is true now: an error, a count, a step that is missing. The tour is
the exception, since explaining is its job.

Native `details.disclosure` sections animate their height in browsers that
support intrinsic-size transitions, with an immediate fallback elsewhere.
Task sections use a grid fold and become inert while collapsed. Both read the
shared motion durations, including the reduced-motion override. The Usage and
panel end-to-end tests cover card spacing, folded drafts and phone controls.

## Chat readability

`bun test tests/e2e/readability.test.ts` checks the sidebar metadata, process
panel, paragraph buffering, reasoning replacement, goal display and command
highlighting, compact tool calls and answered questions through the fake client.
It writes desktop, phone and light-theme captures under `tests/e2e/.artifacts/`.

Scheduled goal and loop prompts journal the command and objective in `text`, with
activity kind and iteration metadata. The core builds the execution instructions
when starting the driver. Older messages can carry `displayText`, which the UI
still honors when displaying or recalling a prompt. Terminal goal control markers
stay hidden; examples inside answer text or code fences remain visible.

Chat status uses two small receipts: core acceptance and the first nonempty
assistant activity. Agent protocols do not provide a literal read receipt.
The reply has one spinner while running, paused when the document is hidden
and disabled for reduced motion. Finished turns show a check and elapsed time;
usage totals remain in Usage settings. Context details open separately from
compaction. `tests/e2e/chat-context.test.ts` covers these interactions.

Tool calls read as a work log. A single completed call uses a count-based
summary, with its full input and output available on expansion. A run of calls with
nothing between them folds under one sentence ("Ran 4 commands, read 1 file and
searched the code once"): one clause per kind, in the order the kinds first
ran, with edits counted by file. While a call runs, the folded line says what
runs ("Running git"). While that activity is visible, the turn does not add
a second working indicator unless it needs an answer or has background work.
Inside an expanded group, each call is a plain line: a command as the command
it ran, with the pwsh, cmd or bash wrapper taken off
(`lib/tool-groups.ts`), anything else as a short sentence ("Read app.css"). A
call that produced a diff stands alone, shows its `+N -M` and opens on the
diff; when it failed, its output sits above the diff. In `?fake=1`, `[tools]`
in a prompt plays a burst of six calls, one of them failing, and `[diff]` an
edit with its diff. Failed and denied calls stay outside groups, with an
output preview that remains visible when the call is closed.

Answered questions collapse to the actual answer. Expanding restores the
question and the full answer without enabling another submission. Thinking
uses one stable label; its current heading remains in the expanded detail.
These disclosures share the activity spacing tokens in `app.css`: 4 px row
padding, an 8 px icon gap, 30 px desktop rows and 44 px phone touch targets.
Text blocks stay 12 px away from activity rows.

### Theme colours

Settings, Appearance offers five palette previews and five editable colours:
background, sidebar and frame, panels and messages, text, and accent. Click a
preview element or a colour row to edit it with the colour field, hue slider
or hex input. The field supports touch and arrow keys; Shift takes larger steps.
Undo restores the colours before the current edit. Reset returns the active
appearance to its original palette.

Light and dark palettes are stored separately on this device under
`boite.theme-colors.v1`. System follows the operating system and selects the
matching palette; Grain uses the dark colours. Secondary text and borders are
derived from the main colours. Low text contrast offers a correction, measured
against the solid surfaces. Window transparency can change that contrast.
Vite generates the prepaint script from the same validation and colour math
as the runtime, so reloads restore the colours before the UI mounts.

`bun test tests/e2e/theme-colors.test.ts` exercises palette selection, custom
colours, reloads, separate appearances, contrast correction, undo and phone
controls. It writes desktop and phone captures under `tests/e2e/.artifacts/`.

### Faces and zoom

Settings, Appearance, Reading picks the text face and the code face for this
device. Inter is the default text face; Geist, IBM Plex Sans, Atkinson
Hyperlegible Next, Figtree, Source Sans 3, DM Sans and the system's own are the
others, and the code face is Geist Mono, JetBrains Mono or the system's. The
system choices use the fonts the OS has. Every other face is a bundled variable
woff2 under the OFL, its licence beside it in `public/fonts`, cut by
`unicode-range` so a face nobody picked is never downloaded. `lib/fonts.ts` stamps the pick on `<html>` as `data-font` and
`data-mono`, whose rules in `app.css` swap `--font-sans` and `--font-mono`;
the boot script of `index.html` stamps and preloads it before the first paint.
The service worker precaches the default faces only.

In the desktop shell, `Ctrl+=`, `Ctrl+-` and `Ctrl+0` zoom the whole interface,
from 50 % to 200 %, with a Zoom row on the same page (`lib/zoom.ts`). It is the
webview's own zoom, so the layout and its media queries recompute at the new
size. The factor is applied before the window shows. A browser surface in the
panel keeps its own zoom. In a plain browser the page's `Ctrl+=` does the same
and nothing of this runs.


### File attachments

In the desktop app connected to its own core, executable links in chat open
the original file on click. Other local files keep their preview and offer
Open to use the system's default application. The shell accepts existing files
inside the thread directory, resolves symlinks before checking containment,
and refuses commands from browsed webviews. Remote cores, browsers and phones
keep the preview/download behavior; attachments remain downloadable copies.
`bun test tests/e2e/local-files.test.ts` covers the UI and phone fallback.
The native file opener case in `tests/e2e/shell.test.ts` runs an inert executable
that writes a marker and exits without a window.

Desktop and paired phones can pick, paste or drop files into the composer.
A turn accepts eight attachments, each at most 5 MB and 10 MB together. The
total keeps the `turns.start` frame, where they travel as base64, under the
16 MB the core reads in one frame (`RPC_MAX_FRAME_BYTES`, the websocket's
`maxPayloadLength`); a larger frame would close the socket before any handler
ran, so the UI client refuses one before sending it. PNG, JPEG, GIF and WebP
use the provider's native image input. Other formats, including PDF, text,
source files and archives, use `kind: 'file'` and do not require image support.
The core validates and journals their base64 bytes, then writes a sanitized,
content-addressed copy under its data directory's `attachments/` folder. Every
driver receives an absolute host path in its prompt and can read it with its
existing tools. Reading a format depends on the agent's tools and permissions;
Boite does not extract archives or execute uploads. Copies persist with the core
data directory so resumed sessions can still read them. They are not currently
removed when a conversation is archived or a project is removed.

Image attachments insert numbered `[Image 1]` references at the composer caret.
Hovering or focusing a reference highlights its thumbnail. Clicking either
opens an inline preview above the input, which stays editable. Escape or the
close button dismisses the preview, as does a click outside the image and composer.
Removing an image updates the remaining
references to match attachment order. `bun test tests/e2e/composer-images.test.ts`
checks this flow and captures desktop and phone layouts.
An image accepted during a pending send stays in the next draft without keeping
already-sent content. A refused send keeps the original prompt and attachments;
text edited by the user while sending remains intact.

The timeline shows downloadable file cards with names and sizes. Images retain
thumbnails. `bun test tests/e2e/attachments.test.ts` checks owner desktop and
paired phone uploads against the real core, reads back host bytes and verifies
the timeline download payload. `bun test packages/core/test/attachments.test.ts`
checks validation, path containment, empty files and continuation references.
