# Development

Run commands from the repository root after `bun install --frozen-lockfile`.
Use the Bun version in `package.json`. Desktop builds also need Rust and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
[AGENTS.md](../AGENTS.md) defines code boundaries;
[CI](ci.md) defines automated check selection and
[portability](portability.md) records platform coverage and gaps.

## Shared-project fixtures

Shared compute admission acknowledges a durable queued job before preparing its
checkout. Completion includes Git provenance inspection after the worker's turn
finishes. Tests use `waitForComputeJob` to observe durable changes, within the
test's own deadline, without extra peer reads or a shorter helper cutoff.
The fanout test retains four local and five remote workers.

Board edits may return a queued receipt after 100 ms while the authority still
answers. Storage-exhaustion tests drain that outstanding operation through a
board read before asserting the local disk error and retained pending edit.
The authority must still contain the accepted change.

Two remote browser viewers share one page viewport. A lone viewer fits it to
its available area; another viewer or an agent preset may change its dimensions.
The real-core E2E test checks a decoded, usable frame without distortion on the
second viewer and verifies its input still reaches the page.

## The core

```sh
bun run dev:core            # watch the core sources
bun run core                # built bundle when present, sources otherwise
```

A scratch core needs its own data directory:

```sh
scratch_dir=$(mktemp -d)
BOITE_ECHO=1 BOITE_HOST_AGENTS=0 bun packages/core/src/main.ts --port 0 --data-dir "$scratch_dir"
```

The ready line is `boite-core ready http://127.0.0.1:<port>`. It contains no
pairing grant or token. The owner token is stored in `<dataDir>/core.json`
with mode `0600`; the owner requests a phone link through Settings or
`pairing.grant`. Stop the scratch core before removing its directory.

One core holds `<dataDir>/core.lock`. Another refuses to start on the same data.
The operating system holds the lock (`flock` on Linux and macOS, `LockFileEx`
on Windows, `packages/core/src/platform/`) and drops it when its holder dies,
so a dead holder never blocks a start and two starts never both get in. The
file's record (PID, start time, Linux start key, `osLock`) names the holder in
the refusal only. A record without `osLock` comes from a core older than the
OS lock: Linux compares its start key (boot id and start ticks), Windows
rejects a reused PID more than two seconds newer than the record, and macOS
retains it while its PID is alive.

| Option | Meaning |
| --- | --- |
| `--port` | Port; 0 asks the OS for a free one |
| `--host`, `--lan` | Bind address; `--lan` binds all IPv4 interfaces |
| `--data-dir` | Explicit data directory |
| `--channel stable\|dev` | Selects the default `boite2` or `boite2-dev` directory |

Directory selection is `--data-dir`, then `BOITE_DATA_DIR`, then the platform
default: `%LOCALAPPDATA%\boite2`, `$XDG_DATA_HOME/boite2` (an absolute value,
otherwise `~/.local/share/boite2`) or
`~/Library/Application Support/boite2`. It contains the journal, accounts,
providers and managed installs. Tests must use fresh directories.

## The UI

The composer's slash menu reads global manual skills from `brain.commands`, including on drafts and drivers without commands; `disable-model-invocation: true` hides them from model catalogs and enables core expansion on explicit invocation.

The Windows shell forwards its eight client-area edges and corners to Tauri's
native resize loop. Windows 10 uses `shadow(false)` to avoid a grey frame;
WebView2 then covers the native hit-test area. `WindowResizeHandles.svelte`
keeps resizing available without restoring that frame. Handles disappear
when maximized or fullscreen and are absent in browsers, Linux and macOS.
`TitleBar.test.ts` exercises the directions and window-state transitions.
The caption buttons retain their full hit areas: the northeast grip sits to
their left, and the east grip starts below the title bar. `ui-polish.test.ts`
checks caption hit targets and reachability of all eight resize directions.

```sh
bun run dev:ui              # Vite at http://localhost:5173
bun run build:ui            # packages/ui/dist, served by a real core
```

The same `Client` interface supports local and remote RPC and the in-memory
client. Development fixtures spend no provider tokens:

| Query | Fixture |
| --- | --- |
| `?fake=1` | In-memory core; no service worker |
| `?fake=1&long=1` | Four-hundred-message conversation |
| `?fake=1&heavy=1` | Forty messages and 11.5 MiB of tool calls, the last turn 1,300 of them |
| `?fake=1&stream=tokens` | Sixteen-character streaming deltas |
| `?fake=1&rtt=200` | Every call waits a 200 ms round trip, half each way; pushed events are not delayed |
| `?fake=1&open=recent` | Opens the latest thread instead of a new draft |
| `?fake=1&uninstalled=1` | No connected provider |
| `?fake=1&policy=managed` | An admin policy that locks every key a control shows; `broken` adds problems, `closed` fails closed ([enterprise](enterprise.md)) |

Production bundles exclude the fake client and Svelte development runtime.
Vite removes an orphan fake-client chunk and rejects shipped references to it.
`ensureProductionUi` in `tests/e2e/lib/prod-ui.ts` rebuilds missing, stale or
development assets with `NODE_ENV=production`. The core fixture clears inherited
`BOITE_UI_DIR` unless the test explicitly supplies one, so installed assets
cannot replace this checkout's UI.

The service worker never registers under `?fake=1`, so a rebuild is always what
a reload shows. Run `svelte-check` before source-based browser scenarios: writing
its generated tsconfig makes Vite reload the page and can reset a fixture mid-test.

Fake browser fixtures do not always need a development server.
`tests/e2e/lib/ui.ts` selects a prebuilt fixture from `BOITE_E2E_FAKE_UI`, builds
one per test process with `BOITE_E2E_PREBUILT_UI=1`, or falls back to Vite.
Both modes expose the fixture workspace through `globalThis.__boiteTest`, so
tests that only need the Store can use the prebuilt bundle. Close each scenario's
browsers in `afterEach` to release their rendering resources before the next test.
Give browser shutdown hooks an explicit 60-second budget: captured-process exit
can take 30 seconds and profile removal retries for another 15 seconds. Close
the fixture server in `finally` so a browser cleanup failure still releases it.
Pages importing `/src/...` call `startDevUi` directly. That server warms their
reachable modules before browser interactions. Fixture bundles enable the fake
client separately from the production assets staged in installers.

For native mouse selection, move to the text and await `document.hasFocus()`
before pressing. A headless page can already have an active element while its
window is unfocused; the first mouse move activates it asynchronously.

Pairing, token and remote-core query parameters are removed from the address
bar. The grant is exchanged once; only an authenticated endpoint and the
resulting client credential are retained. See [machines](machines.md) and
[phone](phone.md) for connection behavior.

## Projects and worktrees

A project's action menu offers Rename on desktop and phone. It changes the
display name through `projects.rename`, retains the folder and conversations,
and broadcasts `project.updated` to other clients. Paired devices may rename
too. Trimmed names must contain 1 to 1024 UTF-16 code units; the core rejects
larger names before journaling or broadcasting. The system drafts project
keeps its localized name.

Owners open a folder through the project dialog by selecting its machine and
browsing or typing an absolute path. `projects.browse` is owner-only; the native
folder picker is available only on the shell's local core. Dropping a desktop
folder switches to that core. A delayed dialog response remains tied to its
original machine and dialog revision.

`Project.repository` and `missing` come from asynchronous folder checks.
Unreadable shares retain their last known state; they do not count as missing.
A removed folder makes thread creation, worktree creation and Git reads refuse
with the path. `projects.list` refreshes the state and emits `project.updated`
when it changes. Client-supplied `cwd` must be an existing directory lexically
and physically inside the project. The core checks resolved symlinks or
junctions at admission; this is not a filesystem sandbox against later edits.
Core-created worktrees can live outside the project through the storage setting.

Owners toggle Worktree by default in Manage project. The core persists
`Project.worktreeDefault` through `projects.setWorktreeDefault` and broadcasts
`project.updated` to connected clients. New drafts use this default; an explicit
composer choice overrides it. Moving a draft uses the target's default unless
explicitly chosen; restored drafts keep their choice. Enabling the default
requires a Git repository other than Drafts.

Settings > Appearance > Buttons can hide the Worktree switch on desktop and in
the phone's options sheet. This device preference preserves the draft's choice
and the project's default.

Thread worktree registration, recovery, branch rename and rollback commands serialize
by the canonical Git common directory. Linked checkouts share that queue; other
repositories and running jobs remain independent. Queued preparation rechecks
cancellation before spawning, and queue time counts against an explicit timeout.

With `worktree: {}`, `threads.create` runs `git worktree add -b` before writing
the thread, with `-c checkout.workers=0` (one checkout worker per core) unless
the repository's or the user's git config sets `checkout.workers`; the core
reads that once per repository. The temporary branch is `boite/wt-<id>`, unless explicitly named;
the directory is `<project>/.boite/worktrees/wt-<id>` by default. A missing Git
executable, a non-repository project or an existing branch is refused by name
without writing a thread. Git calls appear in the thread's trace. The header
shows the recorded branch.

Settings > General > Worktrees offers project storage or an absolute shared
folder. Phone owners open that card from a project's Manage project menu or
a settings link; it has no row in the phone's settings list.
`settings.worktreeStorage` stores `{ mode: 'project', directory: null }` or
`{ mode: 'shared', directory: '<absolute path on the core machine>' }`.
Shared storage uses `<project-name>-<project-id>/wt-<id>` to separate repositories
with matching names. A changed setting affects new worktrees only. Existing
threads and prepared workspaces retain their recorded path. Nested directories
are excluded through Git's local `info/exclude`, without changing `.gitignore`.
Archiving retains the worktree and branch; `worktrees.remove` and the
[settled worktree cleanup](#settled-worktree-cleanup) own removal.

The title operation can rename a temporary branch to `boite/<slug>`, adding
`-2`, `-3` when needed. It preserves the directory, commits and session.
Explicit names, already renamed branches and branches with upstream or remote
tracking remain unchanged. Naming failure leaves the temporary branch usable;
`threads.retitle` can retry. The pending naming flag survives restart.
See [titles](titles.md) for naming and title behavior.

`worktrees.list { projectId }` reads every linked worktree, including manual and
older storage locations, excluding the main checkout and project folder.
Its entries include:

| Field | Meaning |
| --- | --- |
| `dirty` | Git status contains changes, including non-ignored untracked files |
| `unmerged` | HEAD is on no other local branch or remote-tracking ref |
| `missing` | Git lists a directory that no longer exists |
| `threadId`, `threadTitle`, `threadArchived` | A thread in that folder or below it; active threads take priority |

`worktrees.remove { projectId, path, force? }` is owner-only. It refuses paths
outside Git's list, the main checkout and a worktree held by an unarchived
thread, even with `force`. Without `force`, it also refuses dirty or unmerged
worktrees. Removal uses `git worktree remove`, branch deletion and
`git worktree prune --expire 1.hour.ago`. A missing directory loses its
registration only; `branchDeleted: false` records when Git keeps the branch.
Both RPCs trace Git under `worktrees:<projectId>`. The list describes four
worktrees at once and keeps git's order. Its reads go through the Changes
panel's reader (deadline, shared read slots, no index lock, no fsmonitor hook).
A thread counts as a holder only when it belongs to the project or its folder,
as written, lies in the project, its worktree folder or a listed worktree.

Settings > Worktrees and Manage project offer the same controls. Removing clean
worktrees requires no force; ignored dependencies and build output leave with
the directory. Dirty or unmerged removal asks first. Archive alone never removes
a branch or worktree. Restoring a thread whose worktree was removed retains its
`cwd`; sending or compacting refuses the missing folder instead of recreating it.

### Settled worktree cleanup

The core removes a worktree it created once its work is settled
(`worktree-cleanup.ts`). The first pass runs five minutes after startup, then
every ten minutes, with at most eight removals, eight merge proofs and two
minutes per pass. A worktree qualifies when all of these hold:

- It lies under the project's `.boite/worktrees` or the project's folder in the
  current shared storage. Manual worktrees elsewhere are never touched.
- Every thread whose `cwd` is that folder or below it was archived, marked done
  or deleted at least an hour ago, and none has a live process or terminal. An
  archive written by an older core counts from `updatedAt`.
- With no thread standing there, the branch starts with `boite/` (or HEAD is
  detached), no draft reservation names the folder, and git last wrote to it at
  least an hour ago: the newest of the `.git` file and the HEAD, index and HEAD
  log in its admin folder. PR lookups run git with `GIT_OPTIONAL_LOCKS=0`, so
  the cleanup's own reads do not move those dates.
- No live, non-archived thread linked an open pull request whose head is the
  worktree's branch. A delegated worker often runs from another folder and
  makes its worktree with `git worktree add`; its `boite pr link` keeps it.
- `git status` lists nothing, untracked files included. Ignored files such as
  dependencies and build output leave with the folder.
- HEAD is on another local branch or remote-tracking ref, or a merged, non-fork
  GitHub pull request has that exact commit as its head. The proof is the one
  [merged pull request archives](#merged-pull-request-archives) use, so a squash
  or rebase merge counts. A worktree no thread stands in is asked for by branch
  name only.

`WorktreeSweep.removeSettled` reads the worktree again and applies the refusals
of `worktrees.remove` without force, except that a proved merged head passes.
It runs `git worktree remove` without `--force`, so git itself refuses a change
that appeared meanwhile. The branch then goes with `git branch -d`, or after a
merge proof with `git update-ref -d refs/heads/<branch> <sha>`, which deletes it
only while it still points at the merged commit and no other worktree has it
checked out. Remote branches are left to the forge's own "delete head branch"
setting. A worktree kept for a reason is looked at again an hour later, or as
soon as its HEAD moves.

Each thread that stood there gets `worktreeRemoved` on its summary: the path,
branch, whether the branch went, the reason (`pr-merged` or `clean`) and the
pull request. The done notice and, after Move to Recent, the composer show it:
the thread can be read but a turn is refused because the folder is gone. The
field disappears once the thread moves to another folder.

Owners turn this off per project through `projects.setAutoRemoveWorktrees`
(owner only), shown as Remove settled worktrees beside Hide merged PR
conversations in the grouping menu and in Manage project. `Project.autoRemoveWorktrees`
is true unless turned off; a core older than this feature does not send it and
the clients hide the switch. Turning it off stops later removals only.

### Git on Windows

Every git process the core starts goes through `procs.spawn`, which on Windows
adds `core.longpaths=true` through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and
`GIT_CONFIG_VALUE_<n>`, after any entries the environment already carries.
Without it git cannot create or delete a path over 260 characters, and a
worktree adds about 30 characters to every path in the repository. The user's
git config is not written. The same launcher replaces Git for Windows'
`cmd\git.exe` or `bin\git.exe` with the real binary under `ucrt64`,
`clangarm64`, `mingw64` or `mingw32`, which saves one process per git call. It
keeps the launcher when `MSYSTEM` is set, when the layout is absent and when
PATH finds a `git.cmd` wrapper (`git/command.ts`).

## Thread lifecycle

Manual archive stops the thread, pending questions and child work, hides it from
the sidebar and offers Undo. Settings, the project menu and the palette open
archived lists; restore keeps history without resuming work. Paired devices may
archive and restore. Project archive only hides the project; its existing turns
continue. New work in it restores the project. Drafts cannot be archived.
`Project.archivedThreads` counts archived top-level threads and updates clients;
`Project.doneThreads` is the share of them with a done date. The rest were
archived by hand to pick up later.
An archive or delete action on the open conversation returns to a draft in its project.
Removing a background conversation keeps the current conversation on screen.

Thread row and title menus share action groups and icons on desktop and phone:
open/pin, completion/archive, title/move, tools, then a separate Delete group.
Archive stays available beside Mark done in project and recent lists, including
while work is pending. Pull request refresh appears only for a named branch.

Chat text selection never activates a file, conversation or external link at
the end of the drag. The external opener runs after the selection guards.
Dropped text and URLs insert into writable fields; drops elsewhere cannot
navigate the app. File attachments and project moves retain their own handlers.
A later click or keyboard activation still opens the link. Delayed
cross-machine conversation links yield to a newer conversation or draft.

Recent keeps completed conversations in a collapsed Done section at the bottom,
and manual archives in an Archived section after it. Done holds only
conversations with a done date; a manual archive never lands there.
Mark done uses the persistent archive and its undo action; `threads.archive`
with `onlyIfIdle: true` refuses pending work in the conversation's
family before changing it, and its refusal names what is pending and in which
child. Unsent drafts and paused input queues never block Mark done or manual
deletion. Reported input and clients
that cannot read their drafts still protect automatic expiry and merged-PR archives.
A paused workflow run holds expiry but not Mark done,
which stops it as archiving does. Done reads archived summaries only on expansion,
respecting the project and machine filters. A completed conversation opens for
reading with a Move to Recent button in place of the composer. Reopening keeps
history without restarting work. Mark done records its own date; automatic archives
after a merged PR do the same. Settings > General > Archived threads controls the
delay before deletion, 3 days by default, or 0 to disable it. Restoring clears the
date, and marking done again starts a new delay. Manual and older archives without
a done date stay retained. Expiry runs at startup and once per minute, skips
families with pending work or input, and uses the recoverable deletion flow below.

Settings > General > Conversations offers Group working threads,
stored on this device. Phones reach the switch through the thread list's
Display options. The sidebar's Display options panel (`DisplayOptions.svelte`) offers the
view choice and this switch, each scope behind its "i". In Projects it adds the
project order choice, once there is a project to order, and the idle-projects switch.
It stays open while adjusting multiple options.
It moves running, queued and background work to a collapsed section above Done
in Recent and behind each project's working counter in Projects. Turning it
off keeps those conversations in the main list in both views.
Pins, unsent drafts, failures and requests for
the user's answer remain visible. Phone search temporarily shows matching
working conversations in the main list. Keyboard thread shortcuts follow the
expanded rows in their displayed order. Merged-PR archiving feeds Done through
the core check below; its PR link, `#428 merged`, appears under the completed title
and opens the pull request. A done or archived row reads like a thread row
(provider, title, time) without the project a project section already names; it
has no menu button: a right click, or a long press on a phone (`lib/long-press.ts`),
opens its menu, and restoring sits in the time's place under the pointer.

Projects lists projects in sections (`projectSections` in
`lib/project-threads.svelte.ts`), on desktop and phone. Working, on top, exists
only while working grouping is enabled (off by default) and holds the projects whose every conversation is at work with no pin or unsent text, in
a conversation or a new draft, so nothing there waits on the user; a project leaves it as soon as one conversation
needs the user, and the section goes with its last project. The open projects
follow: any other conversation or a draft. Each project header has separate
Working, Done and Archived counters. When working grouping is enabled, its counter toggles
that list; Done toggles completed history and Archived the manual archives. All lists start closed. Working
includes running, queued and background work. Pins and unsent
drafts stay visible while Working is folded and appear once when expanded;
questions and failures stay in the main list. Done and Archived read only that project's
archived summaries when expanded, with the same reading and restore actions as
Recent. Set aside, below the open projects, holds the projects with nothing open
but conversations archived by hand: archiving is how work is put away to pick up
later, so those projects keep a card whose body is that list, drawn at once and
read like open rows, with no Archived pill while the card is unfolded. Working
and Set aside start open; their headers fold them for the session.
Two closed folds below, on desktop and phone, hold the projects with no card
(`ProjectShelf.svelte`, its rows in `ProjectShelfRows.svelte`, loaded at the
first opening or once the list has drawn): Idle projects, with nothing to do,
at most a done history, then Archived projects, a step quieter. Choosing an idle row starts a draft
there; choosing an archived row restores the project, then starts a draft. Under
the pointer a row archives (idle) or restores and removes (archived) without
opening anything; its full menu opens with a right click or a long press, and an
idle row takes a dragged thread. An idle project
with done conversations shows that count on its row, which unfolds
that history under it. Creating or restoring a conversation or starting a draft
returns its project to the open cards. In the custom order a project moves among
the cards of its own section.
Group idle projects, in settings and the Display options panel, can be disabled
to keep every project but the Working ones as open cards, in their normal order. Both grouping preferences persist on
the device. Expansion follows the owning project between desktop and phone for
the current session. Phone search exposes matching
working conversations even when their counter is closed.
Recent project order uses the latest user message among live conversations,
including imported history. Removing or moving the newest conversation lowers
the project; empty projects follow those with conversations. A selected project
promoted to the top by a new prompt also scrolls the desktop sidebar to the top.
Custom project order remains fixed until the user changes it.

Visible desktop and phone rows read their PR every 15 seconds during a turn,
every minute at rest, on a status change and when the app becomes visible.
Polling continues after a merge so a reused branch can acquire another PR.
Folded rows and hidden windows skip background reads; errors keep the last
successful badge. Open, closed and merged PRs have distinct icons and colors.
Linked PR state events update both views immediately; an unlink waits out an
older pending lookup before reading again.

Explicit conversation links work without a branch or a surviving checkout. An
open link takes priority; when every link is terminal, a newly discovered open
PR can replace it. The core shares 15-second list and detail caches, pins GitHub
queries to the origin fetch repository, and ignores foreign forks sharing a
branch name. A private worktree's own HEAD follows an agent's branch rename.
Shared project-directory threads never inherit that directory's current branch.
Missing GitHub CLI or login retries after a minute; manual refresh retries at once.

Deletion is separate from archive. `threads.remove` stops the thread family and
waits for processes before hiding it behind persistent markers.
`threads.deleted` lists retained conversations and `threads.restore` restores
history and prior archive flags. A paired phone may delete and undo from its
thread menu; the deleted list and the retention period stay owner-only. Undo toasts last eight seconds.
The default retention is 30 days; 0 disables purge. Restart and disconnection do
not erase the markers. Files, branches and worktrees stay on disk; project
removal purges that project's pending deletions. A later purge can remove
unreferenced Claude transcripts from accounts Boite isolated itself; the
user's own CLI profiles and other providers' transcripts remain
([transcripts Boite removes](accounts.md#transcripts-boite-removes)).

Archiving a bot in its Settings requires typing its existing
name exactly. Cancel, Escape and Back keep it active. Archiving stops its work
and removes it from the active list; its profile and history remain searchable.

Closing the desktop window, the native Quit menu and Ctrl+Q share a confirmation
when this PC's own core has queued, running or waiting turns. The check reads a
fresh thread list, including agent sessions and delegated children, and asks
too when that core cannot answer. Another machine's agents keep working after
the window closes, so its turns and its reachability never hold the app open
(`closingStores` in `lib/shell-quit.ts`). Close to tray still hides the window without
quitting. The warning distinguishes resident engines, which keep working, from
engines configured to stop with the shell.

### Merged pull request archives

Projects default to `autoArchiveMergedPr: true`; the owner changes it through
`projects.setAutoArchiveMergedPr`. The core can automatically archive a
root conversation only for a clean linked worktree and a uniquely identified,
merged, non-fork PR from the same repository with the exact branch tip. The
proof takes the checkout's current branch from `git status`, not the thread's
recorded starting branch. The repository's cached fetch remotes identify origin,
then explicitly linked URLs are read directly with `gh pr view`, even when they
are absent from the repository's page. Every linked PR is checked before accepting
a merge: another open linked PR keeps the conversation visible. A linked merge
needs the exact tip but may have another head name, because agents often push
`HEAD:fix/...`.

Without a linked proof, the repository's page, its 100 PRs updated last, is
shared with sidebar discovery; only that read counts as evidence, never what
earlier pages taught. Its branch needs exactly one local PR; unrelated fork branches do not
count. A full page requires a branch-specific query and a complete result before
archiving. `git status` runs only when a merged PR could match. A negative proof
retries after one minute even when the thread has not changed, so an external
merge is detected without further conversation activity.
The grouping menu in both views exposes this project policy as Hide merged PR
conversations and names the project it affects. In Recent it follows the project
filter, or the current project when all projects are shown. Disabling reveals
that project's automatically hidden conversations immediately, preserves manual
archives and permits hiding them again when the policy is enabled.
A shared checkout, reused branch history, ambiguous root holder, dirty tree or
failed Git/GitHub read leaves the conversation visible.

When a badge read or linked-PR watch detects a merge, that conversation is checked
directly, without the startup grace, settling delay or periodic history scan.
Failed detected proofs suppress repeated reads for a minute, independently of the
scan. A thread update or changed PR links permit an earlier retry. A failed read
of one conversation leaves it visible and does not stop other detected merges.
It moves to Done even while viewed, unread or finishing its current prompt.
The prompt and its processes keep running, its final answer is retained, and the
Done row shows its live state until it finishes. Pinned threads remain visible,
as do threads with protected client input, terminals, queued turns,
pending cards or messages, unfinished goals or loops, and active, paused or undelivered
workflows. Completed workflow and delegated children can remain as history:
every retained child, including an archived child, must be idle with a completed
turn and be free of the same activity and input protections. Undelivered or
uncertain family results keep the parent visible. Fresh repository and family
state checks precede the archive transaction. A late child turn or wake cannot
start under an archived parent; Restore admits new work again without changing
the children's existing archive flags. A fallback history scan catches merges
no surface has read. It starts after a 90-second startup grace and repeats at
60-second intervals after completion, scanning at most 128 rows and admitting
eight idle candidates within a 30-second budget for proof and validation.

Automatic archive changes visibility and records its reason; it does not stop
work or remove a worktree or branch. An hour later the
[settled worktree cleanup](#settled-worktree-cleanup) can remove both. Restore dismisses the exact PR and protects
that restored checkout from another automatic archive, including after restart.
Connected clients publish protected drafts and pending input through
`threads.focus`. A focus caller that has never reported input protection blocks
automatic archive until it reports protection or disconnects. This keeps older
connected UIs from clearing parked input on an archive event; disconnected
clients cannot report their input. The current UI retains unsent composer input,
paused queues, preview undo and unsaved panel drafts on automatic archive.
Manual archive and deletion keep their explicit clearing behavior.

### Moving a thread

`threads.move { threadId, projectId, stopBackground? }` moves a root and its
children to another project on the same machine. Desktop drag and the desktop
or phone menu call the same RPC. Sub-threads and bot sessions cannot
move independently. Unknown, unchanged, archived or missing targets are refused.
A target project that was archived becomes visible again.

The working directory becomes the target folder. A thread with its own worktree
gets a new one when the target is a Git repository; Drafts gets a new dated
folder. The old folder, changes, branch and worktree stay untouched. Codex can
resume with a new `cwd`; other drivers start a fresh seeded session. Every warm
process key includes the folder, so none is reused across a move.

A durable note explains the move before the next normal prompt. It skips slash
commands and compaction, keeps the first origin across repeated moves and clears
when returning there. An agent's `boite thread move` uses the same operation
but skips that explanatory note.

A busy root stores an in-memory `pendingMove` until its turn ends, whether done,
failed or stopped. The following queued turn uses the new folder. A later request
replaces it; `threads.moveCancel`, archive or core restart drops it. A failure at
application time creates a system message. A busy child refuses the move with
`reason: 'turn-in-flight'` and `busyThreadId`.

Background work requires an explicit `stopBackground`: true stops it, false
leaves it in the old folder until the next agent launch. A choice for a pending
move applies when it runs. If none existed when the move was requested, work
that began meanwhile is retained. Paired devices may move by project ID and
cancel; the core chooses the path. [CLI](cli.md) documents agent moves.

## Pending prompts, goals and loops

[Context](context.md#pending-prompts-goals-and-loops) owns queued prompts,
steering, durable drafts, goals and loops. [Model switching](model-switching.md)
owns provider defaults, on-demand model catalogs, accepted execution targets and
context transfer.
These rules apply across navigation and are covered by the composer, Store and
context tests; live provider behavior stays opt-in.

## The echo provider

`BOITE_ECHO=1` enables a deterministic fixture provider. It streams its prompt,
can report fake tools, ask permissions and start a captured child process,
without network calls. Tests, E2E and benches enable it themselves. It supports
image markers, `/shout`, `/whisper` and `[compact]`; its context reading is
100 plus prompt characters on a 2,000-token window.

`BOITE_HOST_AGENTS=0` disables executable resolution and access to host agent
profiles, so version checks, quotas and probes cannot use developer logins.
Fixture harnesses set it. Only the host-agent opt-ins listed below enable
installed agents; `BOITE_E2E_PREBUILT_UI` and `BOITE_E2E_SKIP_SHELL` only select
browser fixtures and cannot enable host profiles or probes.

The side-question path is covered by
`bun test packages/core/test/side-questions.test.ts packages/core/test/claude.side-question.test.ts`
and the composer suite. `bun test tests/e2e/side-questions.test.ts` uses a real
temporary echo core to check desktop and paired-phone `/btw` answers during a
waiting main turn, dismissal and unchanged history. Its captures land in
`tests/e2e/.artifacts/btw-desktop.png` and `btw-phone.png`; no provider tokens
are spent. See [context](context.md#side-questions) for provider support.

Side questions run without tools against a conversation snapshot and stay
temporary. Pending requests and retained answers protect the root and retained
descendants from automatic merged-PR archive; completed answers expire after 10
minutes and the core retains at most 64. Manual family archive cancels pending
requests and ignores late results. Pending inference also blocks idle updater
shutdown.

## Checks and tests

```sh
bun run check               # architecture and all declared TypeScript/Svelte checks
bun run test                # isolated core file processes, then UI Vitest
bun run build:ui            # production assets for core-backed browser tests
bun run e2e                 # builds UI, then runs tests/e2e
bun scripts/check-docs.ts    # local documentation link targets
```

Run the checks relevant to the change. Core files run in fresh Bun processes,
four at once by default; `BOITE_TEST_WORKERS` accepts 1 to 8, and
`bun run --cwd packages/core test:serial` uses one. The runner preserves full
output and does not retry or skip failures. Its default case deadline is
60 seconds; pass `--timeout` to override. Use `bun test <file> -t <name>` for
a focused regression. UI Vitest allows 15 seconds per test; the app's `waitFor`
uses eight seconds so failures include page text.

Owner CLI fixtures remove `AGENT_ENV` from their child environment: an agent's
inherited thread identity must not override the fixture's explicit `--thread`.

jsdom 30.1.0 fired a window-targeted blur when a focused element was removed,
closing menus in the same tick ([jsdom#4347](https://github.com/jsdom/jsdom/issues/4347)).
30.1.1 fixed it; the context menu tests catch a return of that ordering.
Since 30.1.2 `focus()` refuses an element hidden by `display`, and jsdom never
matches `:popover-open`, so its own sheet hides every `[popover]`. `test-setup.ts`
shows them again; the app mounts a popover only while it is open.

The UI keeps `typescript` 6 beside `@typescript/native` (TypeScript 7):
svelte-check refuses `--tsgo` unless both are installed. As of 4.7.7 its
`bin/ts-version-check.js` throws when the package named `typescript` is major
7, and its peer range stops at `^6.0.0`: re-check that range before moving the
UI's `typescript` to 7. The check already runs on TypeScript 7.

`bun run e2e` exercises real-core RPC with echo, browser UI and the Windows
WebView2 shell when available. Shell automation sets `BOITE_SHELL_HIDDEN=1`.
The native shell cases require their executable and adjacent files;
`BOITE_E2E_SKIP_SHELL=1` explicitly selects a partial core/browser run.
It does not establish native macOS or Linux WebView coverage.

`bun test tests/e2e/shared-cores.test.ts` starts three real cores on loopback
with independent temporary journals and Git repositories: two Contact owners
and one group member. It exercises both association directions, signed/sealed
relays, role and route refusals, board claims/tombstones, host compute,
member restart, scoped cancellation, policy revocation and actual Git result
fetch/object verification/cherry-pick. It runs echo only and performs no paid
inference or real account action. `shared-collaboration.test.ts` separately
checks desktop/phone presentation through two in-memory clients. Neither
fixture proves selective external-provider isolation or native Windows behavior.

Windows process usage reaches the registry through a completion-port event,
or a one-second fallback after the child exits (`procs.ts`). Cleanup assertions
must wait for both the expected PID set and install leases before checking them;
the child exit callback alone does not establish that the trace row was removed.

### Promise matchers under bun test

Files run by `bun test` never use `expect(promise).rejects` or `.resolves`;
`bun run check:architecture` refuses them. In Bun 1.4.3 those matchers run a
nested event loop tick on a pending promise. On macOS the nested `kevent64`
reuses the loop's `ready_polls`, and the outer tick drops the events it had not
processed yet: a socket's one-shot write event is lost and the core closes the
socket with 1013 after 10 seconds. On macos-15, `todos.test.ts` failed 23
times in 7,308 runs with `.rejects` and 0 in 14,214 with an awaited
`.catch()`. Await first, then match, with the helpers of
`packages/core/test/settle.ts`: `expect(await thrown(promise)).toThrow(message)`,
`expect((await rejection(promise)).reason).toMatchObject(shape)` for other
matchers (boxed, so a thenable reason is not adopted),
and `expect(await promise)` in place of `.resolves`. UI Vitest awaits its
matchers and keeps them.

### Contract scenarios

`tests/contract/scenarios.ts` drives RPC results and events through the same
behavioral scenarios on a temporary real core and the in-memory client.
`packages/core/test/contract.test.ts` and
`packages/ui/src/lib/fake-client.contract.test.ts` check error codes and data
keys, not message wording. `KNOWN_DIVERGENCES` contains explicit exceptions;
an exception that starts passing fails the runner until removed.

`composer.ts` exercises queue batching, replay, private records/assets and
agent access against both clients. `contract-coverage.test.ts` inventories
literal fake handlers and requires a shared scenario for new methods.
`tests/contract/fake-coverage-baseline.json` lists existing gaps: remove a
method when its scenario lands; do not add new methods to this baseline.

Shared refusals live in `lib/fake-client/checks.ts`, and settings validation
uses contract `checkSettingsPatch`. Side-specific lifecycle and access cases
live in `fake-client.parity.test.ts`. A fake path below a directory named
`missing` represents an absent folder.

### Adding an RPC method

1. Add the method's `params` and `result` to its domain's `<Domain>RpcMethods`
   in `packages/contracts/src/<domain>.ts` (`threads.*` in `ThreadsRpcMethods`
   of `threads.ts`), and its types beside them. `index.ts` re-exports every
   domain file and composes `RpcMethods` and `RpcEvents` from them; a new
   domain is a file there, an `export *` and one line in each `extends`.
   A branch cut before the split, still editing the single `index.ts`, runs
   `bun scripts/migrate/split-contracts.ts` once `git merge origin/main`
   stops: it replays its edits onto the domain files. A rule for its params
   in `RPC_PARAMS` (`packages/contracts/src/rpc-params.ts`) runs in the router
   and the in-memory client before either handler, and refuses a bad field
   with `InvalidParams` and `{ field }`; `settings.set` has one so far.
2. Register the core handler in the domain's `register*Methods` function.
   For `threads.*`, use `registerThreadMethods` in
   `packages/core/src/threads/rpc.ts`, called by `packages/core/src/modules.ts`.
   `packages/core/src/router.ts` dispatches handlers; `drivers/*/rpc.ts` files
   implement provider protocols.
3. Add the fake handler in `packages/ui/src/lib/fake-client/<domain>.ts`.
   `FakeMethods` in `fake-client/context.ts` types the complete handler map
   assembled in `fake-client.ts`; agent, plugin and workflow classes handle
   their own methods. A missing map entry fails `bun run check`.
   `packages/ui/src/lib/client.ts` already has a generic `call` method.
4. Keep owner-only methods out of `DEVICE_METHODS` and `AGENT_METHODS` in
   `packages/contracts/src/access.ts`; the core and the in-memory client apply
   the same `accessRefusal`. Document the reason beside any permission.
5. Test the result and access boundary with a temporary core. Follow
   `packages/core/test/thread-remove.test.ts` for a paired-device refusal.
   The test client in `packages/core/src/client.ts` exposes `error.rpc.code`;
   the UI client's `RpcFailure` exposes `error.code`. Match the caught error
   with `{ rpc: { code: RpcErrorCode.Refused } }`. The core test records a
   Windows crash in Bun's `rejects` matcher and uses `.catch(error => error)`.

Run the affected core test, fake-client checks and type checks:

```sh
bun test packages/core/test/<name>.test.ts
bun run --cwd packages/ui test src/lib/fake-client.contract.test.ts src/lib/fake-client.parity.test.ts
bun run check
```

## Rebuilding the shell executable

```sh
bun run test:shell
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
bun run e2e
```

On Linux, `test:shell` and the shell builds need the WebKitGTK headers first;
without them `glib-sys` stops at `pkg-config` and no test runs. CI installs the
same list in `.github/workflows/desktop.yml`:
`sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.

Use Tauri to build the executable, including a no-bundle development build:
`bun run --cwd apps/shell tauri build --no-bundle`. A plain Cargo build is useful
for compile errors but does not establish the shell's packaged UI/IPC behavior.
See [releasing](releasing.md) for bundle configurations and installed layouts.

The Windows suite defaults to
`apps/shell/src-tauri/target/release/boite-shell.exe`, or
`BOITE_E2E_SHELL_EXE` when set (a `build:shell:dev` leaves
`boite-dev-shell.exe` instead, which the default never names). It rejects a missing or stale shell, UI, core or
worker before running interactions. With a shared Cargo target, preserve the
shell executable, installer, adjacent core bundle/runtime, workers and CLI
shims from the same build before another worktree replaces them. Test that copy
through `BOITE_E2E_SHELL_EXE`. Filenames and timestamps alone do not identify the
branch; inspect the running UI over CDP for installation claims.

A hidden shell whose page never reaches the debugging port fails with "the
browser never exposed a page", followed by every distinct answer the port gave
and when, a last TCP and `/json/list` probe, the end of the shell's own
`logs/shell.0.ndjson` and its process tree (`tests/e2e/lib/shell-diagnosis.ts`).
Any other failure of a shell attach (the page socket, `Page.enable`) carries
the same shell details. The whole text lands in
`tests/e2e/.artifacts/shell-<pid>-diagnosis.txt`, which the
`desktop-failure-captures` artifact keeps. The diagnosis gets 20 s at most. The
process tree is read in the test process (`tests/e2e/lib/process-tree.ts`, a
Toolhelp snapshot and each command line), in milliseconds: the PowerShell and
WMI listing it replaced gave nothing within 10 s on a loaded runner. A
missing `main-window` startup phase means the main webview was never built; a
phase with no `shell.webview.page-load` means the page never started loading.
The shell logs each main-page navigation as `shell.webview.navigation`: the URL
the page was on when the watch began, each navigation's start and URL, when its
document request reached the host (`requested`) and when the asset protocol
answered it (`answered`), whether its content is an error page, and how it
ended (WebView2's `WebErrorStatus` and the HTTP status). A test shell also
writes WebView2's Chromium net log to `logs/webview-net.json`; a failed attach
or bridge wait copies it to `tests/e2e/.artifacts/shell-<pid>-webview-net.json`.
Between `starting` and `requested`, look for `COOKIE_PERSISTENT_STORE_LOAD`
(the profile's cookie database, which holds the first request until it has
opened) and `PAC_FILE_DECIDER` (proxy auto-detection).
A page that is exposed but never gets its IPC bridge fails in
`waitForShellPage` with its frame tree, its navigation history and each
main-frame navigation event and document request devtools saw since the
attach, with how the request ended, in `shell-<pid>-not-ready.txt`.

## Staging the sidecar

`bun run stage:core` builds and stages the core. Staging copies artifacts into
the bundler resources and beside a release shell. On Windows the sidecar is
Bun's baseline runtime, with `core/main.js` and split chunks in the adjacent
`core/` directory, so `stage:core` runs `build:core` there and compiles no
`boite-core.exe`; a bench that times the compiled core on Windows needs
`bun run build:core:exe` first. Other platforms use the compiled core. Windows verifies the
runtime archive's SHA-256 and executable signature and caches it under
`node_modules/.cache` for the running Bun version.

The JavaScript build minifies identifiers as well as whitespace and syntax;
function names in its stacks can differ from the source. The compiled sidecar
keeps identifiers readable. `browser-page-kit.test.ts` evaluates the minified
page script in a fresh realm, without the bundle's globals.

`stage:core` places `jobs-worker.js`, `guard-worker.js` and
`artifact-retention-worker.js` beside the core, with both CLI shims. The jobs
worker supplies Windows process events; without it, tracing falls back to
polling. The guard worker supplies the focus guard and audio mute. The retention
worker scans artifact references in the background. Windows requires all three
files, and the E2E fixture rejects stale or missing adjacent artifacts. Run
staging after the shell build. On Windows the first staging downloads Bun's
baseline runtime archive for the pinned Bun version and caches it under
`node_modules/.cache` ([releasing](releasing.md)).

## Captures

`tests/e2e/lib/cdp.ts` starts a muted headless browser with a disposable profile.
The browser override is `BOITE_E2E_BROWSER`. Local Windows uses native ANGLE;
CI uses CPU compositing with software GL disabled. Browser launch failure
reports early exit or the CDP deadline and saves the last 16 KiB of stderr.
Screenshots go to the ignored `tests/e2e/.artifacts/`. Open desktop and phone
captures before claiming a visual change is verified.

Run capture scripts and browser suites sequentially in one checkout. Concurrent
Vite development servers can invalidate their shared optimized dependencies
and return HTTP 504 for a module that another page is loading.

An unfiltered `BrowserPage.attach` waits past startup `about:blank` targets
before choosing a navigated page. Pass `about:blank` explicitly when that is
the intended target. `cdp.test.ts` checks both discovery and explicit selection.

Condition waits pass their remaining deadline to each CDP evaluation. Timeout
diagnostics get at most 250 ms. A wait after `page.close()` fails immediately.
`browser-deadlines.test.ts` covers unfulfilled promises and busy renderers.

`page.close()` requests CDP shutdown; POSIX also sends SIGTERM. A stalled browser
falls back to its captured PID, waits for exit and retries profile removal.
Removal and the core harness's tree kill are asynchronous: a synchronous delete
of a Windows profile held the test process, its Vite server and in-process core
for 2 to 3 s. Closing a browser there took up to 7 s, so every E2E `afterAll`
names a deadline of at least 30 s instead of Bun's 5 s default
(`scripts/ci/e2e-harness.test.ts`).
Cleanup reports retained directories and the test preload removes interrupted
`boite-e2e-*` directories older than an hour. `cleanup.test.ts` checks teardown.
Never terminate processes by executable name or a path pattern.

| Scenario | Focused browser test |
| --- | --- |
| Header, sidebar, prompt navigation | `tests/e2e/header.test.ts` |
| Scroll following and virtualized history | `tests/e2e/chat-scroll.test.ts` |
| Context, compaction and turn receipts | `tests/e2e/chat-context.test.ts` |
| Readability, tools, answered questions, high contrast | `tests/e2e/readability.test.ts` |
| Draft durability, overlays and reduced motion | `tests/e2e/drafts-overlays.test.ts` |
| Provider transfer over fixture ACP | `tests/e2e/model-switch.test.ts` |
| Folder picker and absent project | `tests/e2e/project-picker.test.ts`, `folder-gone.test.ts` |
| Appearance controls | `tests/e2e/theme-colors.test.ts` |
| Composer image references and uploads | `tests/e2e/composer-images.test.ts`, `attachments.test.ts` |
| Local file opening and remote fallback | `tests/e2e/local-files.test.ts` |

These use fixtures or temporary core data, not paid accounts.

## Desktop updater tests

Rust updater unit tests use a local HTTP fixture and a signed inert payload;
they launch no installer. Windows test executables include the Common Controls
v6 manifest needed by the native dialog dependency.
`tests/e2e/app-updates.test.ts` checks update states and phone restrictions.
Development queries `?fake=1&appUpdate=available`, `ready`, `downloading` or
`error`, with `appUpdateChannel` and `appUpdateCurrentChannel`, preview those
states. `tests/e2e/update-everything.test.ts` opens the foot's update card with
`updates=1&machines=1&appUpdate=available&serverUpdate=available`, checks that
nothing downloads before the click, Remind me later, Update the app alone, the
one request per machine, rows landing one at a time, and the card ending on
Restart or Everything is up to date, and captures desktop and phone. Its fake
core finishes a server update started that way (waiting, restarting, current)
in about three seconds; a plain install stays waiting for the cancel test.
`packages/core/test/updates.test.ts` holds the core side: a registry read after
an agent's updater, when none of its processes runs, keeps Boite's own
installation waiting.

`packages/core/test/server-update.test.ts` checks signatures, archive paths,
wait/cancel, installation and rollback of SQLite and pairing state using an
isolated service adapter. `tests/e2e/server-updates.test.ts` checks machine
ownership and desktop/phone controls. Its `serverUpdate=available`, `downloading`,
`waiting` and `error` fixtures never update the real installation.

After `bun run build:core:linux`, a host with a systemd user manager can opt into
`BOITE_E2E_SERVER_UPDATE=1 bun test packages/core/test/server-update-systemd.test.ts`.
It creates and removes test units, runs an inert replacement through the
compiled worker, and uses fresh data without provider calls.

## The opt-in live tests

The installed-binary compatibility check uses a local mock API, fresh homes
and no login: `BOITE_E2E_OPENCODE2_BINARY=/absolute/path/to/opencode2 bun test packages/core/test/opencode2.compat.test.ts`
from the repository root. It covers discovery, a read tool, queued and immediate
follow-ups in one execution, cold resume, plan mode and cancellation beside a
locked, incompatible version 1 profile. `tests/e2e/opencode2-steering.test.ts`
checks the queued bubbles, Send now and compact tools on desktop and phone
against a scripted native server, without an installed provider.

Real-provider tests use CLI logins and spend tokens. Run selected cases from
`packages/core`, one at a time; never enable them for an ordinary fixture run.

| Variable | Test and boundary |
| --- | --- |
| `BOITE_E2E_CLAUDE=1` | `test/claude.live.test.ts`: turn, resume, native import and warm process |
| `BOITE_E2E_OPENCODE=1` | `test/opencode.live.test.ts`: ACP turn and cold resume |
| `BOITE_E2E_OPENCODE2=1` | `test/opencode2.live.test.ts`: OpenCode 2 turned on, native API turn, cold resume and plan mode; `BOITE_E2E_OPENCODE2_MODEL` names the model |
| `BOITE_E2E_GROK=1` | `test/grok.live.test.ts`: default login, model/effort and cold resume; empty isolated homes can open sign-in |
| `BOITE_E2E_GROK_QUOTA=1` | `test/grok-quota.live.test.ts`: quota for the existing default login |
| `BOITE_E2E_GROK_PROXY=1` | `test/grok-proxy.live.test.ts`: Grok behind a Douane gateway, on an isolated account that never signed in; `BOITE_E2E_GROK_PROXY_URL` is the gateway's API URL, `BOITE_E2E_GROK_PROXY_KEY` its key |
| `BOITE_E2E_CODEX=1` | `test/codex.live.test.ts`: app-server turn and resume |
| `BOITE_E2E_PI=1` | `test/pi.live.test.ts`: turn and resume |
| `BOITE_E2E_INSTALLS=1` | `test/shipped-installs.live.test.ts`: pinned Codex/OpenCode downloads and versions |
| `BOITE_E2E_PLUGIN_INSTALL=1` | `test/plugins.install.live.test.ts`: native plugin install/version/uninstall |
| `BOITE_E2E_ANTIGRAVITY_INSTALL=1` | `test/antigravity.install.live.test.ts`: managed archive integrity and ACP initialization, without login |
| `BOITE_E2E_ANTIGRAVITY=1` | `test/antigravity.live.test.ts`: interactive sign-in and turn; requires a person |
| `BOITE_BENCH_CLAUDE=1` | Real Claude turn in `bun run bench` |
| `BOITE_BENCH_HOST_AGENTS=1` | Host agent update checks in `bench/idle-rss.ts` |

`BOITE_E2E_GUARD=1` separately enables the native Windows focus case, which
opens a real window and takes focus briefly. Other guard tests use fake Win32
calls. Voice and local Whisper opt-ins are listed in [voice](voice.md#verification).

## Phone checks

`tests/e2e/mobile.test.ts` covers navigation, portrait/landscape, model sheets,
Back, retained drafts and visible messages in a headless fixture browser.
`tests/e2e/ui.test.ts` exercises a paired device on a temporary core, including
revocation, reconnect and offline shell. `packages/core/test/push.test.ts`
uses a substituted sender and does not prove external push delivery.

For a connected Android device, use an isolated echo core and
`adb -s SERIAL reverse tcp:7337 tcp:7337`, then its temporary pairing link at
`http://localhost:7337`. Localhost permits the service worker without a public
certificate. Remove the mapping with
`adb -s SERIAL reverse --remove tcp:7337`. Keyboard resizing, installation,
suspension and push delivery require device checks. External connections need
the trusted HTTPS origin described in [phone](phone.md).

## Benches

```sh
bun run bench               # comparison report in bench/results/<date>.md
bun run bench/idle-rss.ts    # bare Bun and core idle readings at 4.5 s and 75 s
bun run bench/agent-startup.ts --offline --runs 7 --delay-ms 150 --output /tmp/agent-startup.json
```

All use fresh data. The agent-startup benchmark requires `--offline`, uses a
scripted native process and checks cleanup and attachment preservation. Its
directory and sparse-worktree samples measure synthetic startup, not provider
inference. See [performance](performance.md#preparing-the-first-prompt).
`--fresh-only` selects the first idle reading. Rerun before
quoting a performance figure and include its command and date.

## Architecture checks

`bun run check` includes `bun run check:architecture`; it reads imports with
Bun's transpiler and the `<script>` blocks of Svelte components with the UI's
own `svelte/compiler`, so a component's imports are edges of the graph and a
cycle through a component fails. `bun test scripts/architecture` covers
cycle detection, resolution, boundaries and source sizes. The roots it reads
are `ROOTS` in `scripts/architecture/inventory.ts`; a missing root fails rather
than narrowing the check. Runtime-import scope
and exclusions are documented in
[architecture](architecture.md#module-boundaries-and-complexity).

Production TypeScript, JavaScript, Svelte, Rust, Kotlin and Java files have a
900-line ceiling; tests, declarations and a Rust module's `tests.rs` do not
count. Two files above it have an allowance in
`scripts/architecture/size-budget.json` that may only shrink:

- `apps/android-server/termux/boite-server.ts`: the Termux controller ships as
  one file, which `install.sh` fetches alone and an update copies alone. It
  splits once the bootstrap carries a directory.
- `apps/shell/src-tauri/src/browser.rs`: the shell's browser surfaces, above
  the ceiling before Rust entered the check.

`--write-size-budget` lowers or removes allowances; it never raises them.
`--rebaseline-size-budget` can raise them for a reviewed integration of branches
written before the limits existed. Nothing is exempt.

`bun run audit:complexity --json` produces an advisory comparison for TypeScript,
JavaScript and Svelte scripts, excluding Rust. A high score requires review of
ownership and duplication, not an automatic split.

## UI spacing and motion

Settings, Experiments, Pinned model quotas adds a pin to Account limits and
the Limits page. The card follows the open conversation's model provider,
including every matching Douane account, and offers four conversation corners
or a dock below the thread or bot list. Drag the card from outside its buttons
to a corner or the sidebar; arrow keys move a focused card and Home docks it.
When the reading column leaves too little margin for the card, it docks
automatically without changing the saved corner. The dock reserves space above
the sidebar controls; the list keeps its own scroll. Where the sidebar is
unavailable, a narrow conversation reserves space below the messages instead
of covering them. Empty drafts keep a floating card so pinning does not shift
the welcome or composer. Pin and placement are device preferences under
`boite.pinned-quotas.v1`. Reads share the other quota views'
cache and events; only an owner refresh forces the providers to read again.

Use `app.css` tokens for colour, radii, spacing and motion, and mirror every
English string in all translations. Floating menus use `lib/floating.ts` and
the browser's top layer; phone controls use the shared sheets. Reduced motion
applies to panels, drawers, terminals and disclosures. Collapsed task controls
are inert. Settings pages use `--settings-width`, `--settings-padding` and
`settings-stack`; explanatory text belongs in `InfoTip`, with visible hints
reserved for current errors, counts or missing steps.

The terminal, the right panel and the sidebar make their room as they arrive,
on `--dur-slide` and `--ease-slide`: the terminal grows its slot, the panel and
the sidebar slide in from their window edge behind a negative margin that
shrinks to zero. The chat gives way over the whole movement instead of jumping
in one frame. The panel and the sidebar keep their final size while they
slide, so nothing inside them rewraps. Over the chat, under 981 px, the panel moves by a transform; floating,
it only fades out. A panel tab opened or picked after the panel is in fades
its surface in. Captures and pointer aims wait on `page.settleAnimations()`
from `tests/e2e/lib/cdp.ts`, which leaves out animations inside a folded
`content-visibility` section: Chrome never updates those, so their `finished`
promise stays pending.

For text beside icons, put `ui-label` on the text leaf inside the flex or grid
row. The shared rule in `app.css` centres the font's cap height and alphabetic
baseline with `text-box`; it keeps padding for accents and descenders when a
label truncates. Use `ui-label-box` on padded badges or inline icon rows to
preserve their original line-height and centre the label. Trimming on the row
itself does not reach its flex items.
The existing line-height remains the fallback when a browser lacks `text-box`.
`bun test tests/e2e/text-alignment.test.ts` measures this alignment across the
eight reading fonts, desktop menus and phone controls.

A folded list opens on `FoldHeader`: chevron, optional glyph, label, then its
count at the end of the row through `fold-count`, never in parentheses inside
the label. Rows inside a fold start at `--fold-indent` so they line up under the
label. Other folds turn the shared `fold-caret` chevron, and a native
`<details>` uses `details.disclosure`.

### Window material

Windows offers acrylic from build 22523, mica from 22000 and solid on every
build. The control is hidden when solid is the only choice. An unsupported
stored choice becomes solid; the shell refuses unsupported material requests
by name. Browsers and other platforms keep an opaque document.

`apps/shell/src-tauri/src/material.rs` applies each material through the DWM
backdrop attribute, using the older mica attribute on early Windows 11 builds.
It reads back the system backdrop on builds that support it. `lib/glass.ts`
serializes native changes and applies transparency only after the latest
successful request. A refusal leaves the document opaque. The shell avoids
Tauri's material-clear path so changing to solid does not leave an accent
policy that prevents a later backdrop from drawing.

## Chat readability

Conversation text uses `--text-reading` and `--leading-reading`: 15 px with
24 px line spacing on desktop, 16 px on phones. Answers, sent prompts,
the composer, plans and delegated transcripts share these tokens. Headings
scale from 1.3 em to body size; code, tables and tool cards retain their
own sizes. `tests/e2e/readability.test.ts` checks both viewport widths.

Sending a prompt leaves 12% of the timeline height above it, bounded to
48-96 px. The response replaces the reserved space below it; resizing updates
both. `tests/e2e/chat-scroll.test.ts` checks desktop and phone.

Tool cards retain full input/output on expansion. Consecutive calls fold into a
count-based summary in first-seen kind order, including failures and denials with
a muted count. Failed edits do not count as successful changes. Expanding a
failed call shows its diagnostic above the full input and output. File changes
fold into the activity by default. One collapsed file summary collects successful
changes while the turn runs, deduplicates paths and opens their diffs on demand.
Appearance independently controls grouping and automatic change previews, per
device. Deferred inputs and diffs load only when a preview is opened; file summaries
reuse their arrays across text deltas. Codex exit codes determine command status;
output text and stderr do not. Answered questions expand read-only. Turn receipts
mean core acceptance and first assistant activity, not a protocol read receipt.
A prompt is drawn the moment it is sent, with both receipts off, and its box
empties at once: the store stages it until the core's own copy takes its place
in the same frame. A draft shows it while its thread is still being created. A
second prompt typed meanwhile waits in the queue and leaves by itself. A
refused prompt returns to an empty box, or to the head of a held queue when the
box already holds the next one. A sidebar card keeps the pull request it last
showed for its checkout across a reconnect and asks again behind it.
`tests/e2e/chat-delivery.test.ts` holds the core's answer back and captures the
pending prompt at desktop and phone widths.
Animations pause when hidden and respect reduced motion.

Replies use a neutral bubble, with sent prompts aligned to the right. Timestamps
stay visible; message actions appear on hover or keyboard focus and stay
available on touch screens. Phone bubbles use more of the conversation width.

Silent running phases show the work status without an empty reply bubble.
Streaming answers show completed Markdown blocks and the unfinished paragraph as
plain text, preserving completed blocks across deltas. Dots accompany actual
answer text; active reasoning and tools show their own activity. Queued turns, disconnected
clients, blocking questions and finished turns do not show typing. The dots
pause on hidden pages and become static under reduced motion.
`tests/e2e/chat-context.test.ts` checks these transitions and phone layout.

Inline Markdown uses markdown-it with raw HTML disabled. Emphasis can wrap
links and code, nest, and use underscores. Link labels retain inline formatting;
balanced destinations, titles, escapes, entities and hard line breaks follow
CommonMark. Boite adds file and thread links after parsing that structure,
keeps formulas opaque, and turns remote images into links without fetching them.
Automatic paths keep underscores literal. Windows destinations identified by a
root or an unescaped separator preserve backslashes; other destinations retain
CommonMark escapes and entity decoding.
Block parsing and streaming boundaries remain in Boite's renderer.
`tests/e2e/markdown.test.ts` covers these formats at desktop and phone widths;
`tests/e2e/diagrams.test.ts` checks diagrams and formulas.

Received agent mail appears on the right with the user accent; sent agent mail
appears on the left with a neutral surface. Owner prompts keep the user style.
The letter's creation time shows its age in the app's language, updates every
minute while visible and exposes the exact date and time on hover.
`tests/e2e/collaboration-ui.test.ts` checks desktop and phone in both themes.

Calls and reasoning with no answer text between them fold into one line,
"Ran 6 commands" with the run's duration, that opens on its steps in order.
When every call of the run carries the agent's own `summary` (Claude's
`tool_use_summary`), the line reads those instead: "Read rules.md and data.txt
· Found N=2 with a prime search". While a step runs the line names it and its
clock ticks: a command reads as what the agent said it is for (the first line
of the call's `description`, Claude's Bash), else as its program and up to two
subcommand words ("Running gh repo create", `commandOf`), never the program
alone; a thought reads as the thought being written. A reasoning step reads
as its last bold heading (Codex) or the first sentence of its last paragraph
(Claude's summary, a raw chain of thought), and as "Thinking" while it has no
words (`thoughtTitle` in `lib/tool-groups.ts`; a live step keeps a
`ThoughtTitleScan` that reads only the lines each delta adds). Reasoning with no words that
took under a second is not drawn. The core
records each block's first appearance and the next part or message completion
for every driver, so durations survive a reload. Older and imported blocks
without timing metadata show no guessed duration.
`tests/e2e/readability.test.ts` and `tests/e2e/chat-delivery.test.ts` check
these lines and durations at both widths.

### Theme colours

Appearance stores light and dark palettes separately under
`boite.theme-colors.v1`. Presets, OLED and custom colours use the same validation
and prepaint script. Editing a main colour updates dependent colours; low
contrast offers a correction, while window transparency can affect the result.
Undo restores the preceding edit; Reset restores the active palette. Community
palette notices ship in `packages/ui/public/theme-licenses.txt`.

### Faces and zoom

Text and code faces are device preferences. Bundled variable fonts carry OFL
licences under `public/fonts`; only selected Unicode ranges load, and the
service worker precaches default faces. `lib/fonts.ts` and the boot script apply
both preferences before the first paint and preload the selected text face; the
code face loads when mono text first draws. System choices use installed
fonts. In the shell, `Ctrl+=`, `Ctrl+-` and `Ctrl+0` control WebView zoom from
50% to 200%, restored before the window appears. The panel browser has separate
zoom; plain browsers keep their native shortcut behavior.

### File attachments

Desktop and paired devices can pick, paste or drop files. A turn accepts fifty
attachments, at most 5 MB each and 10 MB together. On a core advertising
`features.attachmentUploads`, selected files upload before Send through
`attachments.upload`. Finished uploads replace the corresponding
`turns.start` attachment bytes with empty data and an `attachmentIds` entry;
the core resolves those connection-owned leases before validation and
journalling (`attachment-uploads.ts`). Pending uploads never hold Send:
their original base64 bytes travel inline, as on older cores. Expired upload
IDs retry with the original bytes and the same input receipt. These uploads
do not raise the per-file or per-turn caps, and the client still rejects a
frame above the 16 MB RPC limit before send. The journal retains the original
attachments; message reads remain subject to their page budget.
PNG, JPEG, GIF and WebP use native image input. Other
files, including PDFs and archives, use `kind: 'file'` and host paths in the
prompt, and so does an image the provider's agent takes no block of: a GIF for
Antigravity, whose server reads PNG, JPEG and WebP only. Provider tools decide which formats they can read. Boite neither
extracts archives nor executes uploads.

Before those caps, the client brings an image to 2000 px on its long edge
(`IMAGE_MAX_EDGE`, `lib/image-prepare.ts`): JPEG at 0.85, or PNG when that is
lighter or the picture uses transparency. Claude's API refuses an image over
2000 px on either side once a request carries more than 20 images, which a
long thread of screenshots reaches. An image already within 2000 px and 512 KB
goes as it is, and a GIF or an SVG is never redrawn. HEIC and HEIF become JPEG where the
browser decodes them (Safari does); elsewhere they travel as a plain file. A
source over 50 MB is refused before decoding, since a phone's canvas would not
hold it. So twenty iPhone screenshots, 2 to 4 MB each as PNG, fit one turn at
around 400 KB each.

Fifty of them weigh about 26 MB prepared, and the 10 MB total cannot grow: the
user message travels in one `turns.start` frame and stays inline in the
journal, and Claude refuses a request body over 32 MB, history included. So
the composer fits the turn instead of refusing it (`lib/turn-fit.ts`). While
the turn is under budget nothing moves. Past it, the budget is shared out: an
image lighter than its share stays as it is, and each heavier one is encoded
again from the copy it arrived with, at the least loss that fits its share,
down a ladder of JPEG quality (0.75 to 0.35) and long edge (2000 to 1280 px).
It never goes under 1280 px, where a screenshot's text stops being readable;
past that floor the files that still do not fit are refused, by name, with the
usual total message. A GIF keeps its frames, a transparent picture tries PNG
first, and files count at their weight. Every way in goes through it: the
paperclip, pasted and dropped files and a question's answer files, pictures
pasted from another composer, and queued prompts taken back into the box. A
message brought back for editing or after a failed retry already fitted one
turn. Measured on 2026-10-28 with Bun's encoders
(`packages/ui/src/lib/turn-fit.test.ts`): 50 generated screenshots, 1170x2532
and 2560x1440 PNGs of 3.0 to 4.9 MB, went in as one 9.0 MB turn of 154 to
204 KB JPEGs, 1440 to 1600 px on their long edge.

None of this holds the box. A pasted, dropped or picked file shows at once as
a loading tile, a picture with its `[Image N]` at the caret, and the box keeps
taking keys while the file is read (`receiveFiles`, `lib/composer-attachments.ts`).
The reduction runs in a worker (`lib/image-prepare.worker.ts`, `OffscreenCanvas`)
and falls back to the page where a browser has neither. Files of one composer
settle in the order they came, each into its placeholder's place, its undo
steps included. Files settle as they are read while the turn stays under its
total; from the first that passes it, that file and the rest of its batch stay
loading until the turn is fitted once with them, and the pictures already in
take their lighter copies under the same tiles, in their undo steps too. A
placeholder is never saved, synced or uploaded; when a sync conflict moves the
words to a new draft, the file lands in that draft instead (`followRead`,
`lib/draft-attachments.ts`). Send pressed meanwhile waits on a spinner and goes
once every file is ready, in the box it was pressed in; typing on, or a sync
that swaps the box, cancels it. Send pressed while pictures pasted from
another composer are fitted waits for that fit too (`readyToSend`). A refused
file drops its tile and its reference, in the box and in its undo steps, and
says why. A file past the fifty, from the same drop or a later one, waits for
one of them to be refused, and is refused itself only once they are all read.

The Claude driver fits every prompt image to the same edge again before it
goes in (`drivers/claude/images.ts`, Bun's image codec, same format), because
an image can reach a prompt without passing the composer: a client that sends
it unreduced, a browser that could not decode it, or a message written under
the earlier 2048 px cap and replayed by a retry or a carried-over history.
The CLI forwards a prompt's images unchanged, while the images its own tools
read are fitted by the CLI to the model's limit. A GIF, or anything Bun cannot
decode, goes as it is. Tool images shown in the timeline
(`drivers/documents.ts`) never go back to the agent.

An answer to a question with a free field takes the composer's files the same
way (`questions.answer` `attachments`); see [Providers](providers.md).

The core validates bytes and writes sanitized, content-addressed copies under
`<dataDir>/attachments/`. Copies survive resume and are currently not removed
by archive or project removal. A copy the core wrote or compared is not read
again while its size, mtime and inode stay the same; an agent's edit changes
them, and the next reference gets a fresh copy. A different size rejects the
old copy without reading its contents. Timeline cards download those copies. Composer
`[Image N]` references follow attachment order, preview inline and renumber after
removal. A tile opens its picture large above the box; a second click on the
tile, or a click on the large picture, puts it away. Copying or cutting a reference carries its picture
(`lib/composer-clipboard.ts`): pasted where those numbers name other pictures, on
any machine, the pictures join that prompt and the references take their numbers
there; pasted where every number still names the same picture, only the text goes in. A new image accepted during send
belongs to the next draft. Refused sends retain input, attachments and edits made
while sending.

Undo in the composer is the app's, never the textarea's (`lib/composer-history.ts`):
Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z and the context menu walk one history per draft or
thread, up to 200 steps, holding the text, its pictures, its page references and
the selection. Typing groups by word, pause and direction; deleting a selection,
paste, cut, a picture added or removed and every text the app writes are steps
of their own, so deleting everything and typing by mistake comes back in two
undos, pictures included. A sent prompt clears that history.

ArrowUp on an idle thread loads the recalled prompt's deferred attachments
before entering edit mode, like the message's Edit button. A late load cannot
replace a new draft, another recall or another visit. Submitting an edit
validates its current attachments and page references before rewinding history;
attachments deliberately removed from the recalled prompt stay removed.

Original file links in the local desktop thread may open through the system
application, with executable links retaining their explicit local behavior.
The shell resolves symlinks, checks thread containment and rejects browsed-webview
callers. Remote cores, browsers and phones retain preview/download behavior.
Published snapshots from `boite attach` use the separate safe download/open rules
in [CLI](cli.md); they do not authorize executing an uploaded file.

File tickets and compressed view copies open without waiting for a FIFO writer
on POSIX, then check the opened handle's type. A ticket body truncated after its
size was checked errors instead of completing with fewer bytes than advertised.
Download names use RFC 8187 encoding for both file and byte tickets.

Inline text previews use the conversation's vertical scroll, including when
the pointer is over the file contents. Long lines scroll horizontally inside
the preview; Preview folds it again. `bun test tests/e2e/artifacts.test.ts`
checks wheel scrolling in both directions at desktop and phone widths and
writes `text-preview-scroll-desktop.png` and `text-preview-scroll-phone.png`
under `tests/e2e/.artifacts/`.

### File mentions

The composer's `@` menu ranks project-relative paths from `projects.files`.
`packages/core/src/files.ts` caches a walk for five seconds and caps it at
20,000 files. It always skips `.git`, `.boite` and `node_modules`, and reads
plain names from the root `.gitignore`. Globs, negations and nested patterns
are not interpreted, so some Git-ignored files can appear. Responses contain
at most 200 paths, defaulting to 50, and report whether the walk was capped.

## README presentation

The README opens with the app logo and static, theme-aware screenshots.
Its optional ten-second film follows one action: opening the launch-page diff
beside a conversation. It keeps the real timing of the clicks, holds the diff
for reading and fades from light to dark over 850 ms. Sample project data and
recording controls never enter a production build; no live providers run.

`scripts/readme/record.ts` starts an isolated Vite fixture, injects
`scripts/readme/fixture.ts` through a recording-only plugin and fills the frame
with `scripts/readme/stage.html`. The browser runs headless, muted and sandboxed.
The recorder refuses software rendering, checks page errors and fullscreen
bounds, captures desktop and 390-pixel phone views, and closes its own browser
and server on success or failure.

Install Playwright Core 1.63.0 in a separate tools directory and its recording
encoder with `playwright-core install ffmpeg`. Supply a Chrome executable with
View Transitions and a full FFmpeg build with H.264, VP8 decoding and GIF
palette filters:

```sh
bun scripts/readme/record.ts \
  --playwright /path/to/tools/node_modules/playwright-core/index.mjs \
  --browser /path/to/chrome \
  --ffmpeg /path/to/ffmpeg \
  --scratch /tmp/boite-readme-recording
```

The default output is `docs/media`: one silent ten-second 1280 by 800 H.264 MP4,
a matching 960-pixel GIF at 15 fps capped at 5 MiB, and two 2560 by 1600 static
screenshots. The single browser recording changes the theme in place through
a recording-only View Transition. There is no scene acceleration or blending
of separately timed captures.

`--inspect` exercises the same flow and captures both themes without encoding;
`--output` changes the delivery directory. Raw video, phone captures, encoder
logs and verification JSON stay in the scratch directory. `--encode-only`
reuses `capture.json` and its raw recording to regenerate the MP4/GIF without
a browser. The former `--combine-only` option has been replaced.

Check both GitHub themes and the phone README layout after changing the text or
media. Inspect the film and every capture before replacing committed media;
sample data must contain no personal information.
