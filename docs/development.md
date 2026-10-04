# Development

Run commands from the repository root after `bun install --frozen-lockfile`.
Use the Bun version in `package.json`. Desktop builds also need Rust and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
[AGENTS.md](../AGENTS.md) defines code boundaries;
[CI](ci.md) defines automated check selection and
[portability](portability.md) records platform coverage and gaps.

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
A dead holder can be replaced. Windows and Linux also compare process start
time to reject a reused PID more than two seconds newer than the lock; macOS
retains a lock while its recorded PID is alive.

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
| `?fake=1&stream=tokens` | Sixteen-character streaming deltas |
| `?fake=1&open=recent` | Opens the latest thread instead of a new draft |
| `?fake=1&uninstalled=1` | No connected provider |

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
Pages importing `/src/...` call `startDevUi` directly. That server warms their
reachable modules before browser interactions. Fixture bundles enable the fake
client separately from the production assets staged in installers.

Pairing, token and remote-core query parameters are removed from the address
bar. The grant is exchanged once; only an authenticated endpoint and the
resulting client credential are retained. See [machines](machines.md) and
[phone](phone.md) for connection behavior.

## Projects and worktrees

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

With `worktree: {}`, `threads.create` runs `git worktree add -b` before writing
the thread. The temporary branch is `boite/wt-<id>`, unless explicitly named;
the directory is `<project>/.boite/worktrees/wt-<id>` by default. A missing Git
executable, a non-repository project or an existing branch is refused by name
without writing a thread. Git calls appear in the thread's trace. The header
shows the recorded branch.

Settings > General > Worktrees offers project storage or an absolute shared
folder; phone owners reach it through Settings > Worktrees.
`settings.worktreeStorage` stores `{ mode: 'project', directory: null }` or
`{ mode: 'shared', directory: '<absolute path on the core machine>' }`.
Shared storage uses `<project-name>-<project-id>/wt-<id>` to separate repositories
with matching names. A changed setting affects new worktrees only. Existing
threads and prepared workspaces retain their recorded path. Nested directories
are excluded through Git's local `info/exclude`, without changing `.gitignore`.
Archiving retains the worktree and branch; `worktrees.remove` owns removal.

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
Both RPCs trace Git under `worktrees:<projectId>`.

Settings > Worktrees and Manage project offer the same controls. Removing clean
worktrees requires no force; ignored dependencies and build output leave with
the directory. Dirty or unmerged removal asks first. Archive alone never removes
a branch or worktree. Restoring a thread whose worktree was removed retains its
`cwd`; sending or compacting refuses the missing folder instead of recreating it.

## Thread lifecycle

Manual archive stops the thread, pending questions and child work, hides it from
the sidebar and offers Undo. Settings, the project menu and the palette open
archived lists; restore keeps history without resuming work. Paired devices may
archive and restore. Project archive only hides the project; its existing turns
continue. New work in it restores the project. Drafts cannot be archived.
`Project.archivedThreads` counts archived top-level threads and updates clients.
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

Recent keeps completed conversations in a collapsed Done section at the bottom.
Mark done uses the persistent archive and its undo action; `threads.archive`
with `onlyIfIdle: true` refuses pending work or input in the conversation's
family before changing it. Done reads archived summaries only on expansion,
respecting the project and machine filters. A completed conversation opens for
reading with a Move to Recent button in place of the composer. Reopening keeps
history without restarting work. Mark done records its own date; automatic archives
after a merged PR do the same. Settings > General > Archived threads controls the
delay before deletion, 3 days by default, or 0 to disable it. Restoring clears the
date, and marking done again starts a new delay. Manual and older archives without
a done date stay retained. Expiry runs at startup and once per minute, skips
families with pending work or input, and uses the recoverable deletion flow below.

Settings > General > Conversations offers Group working threads,
stored on this device; phone settings offer the same switch under device
preferences. Display options beside Projects and Recent offers the same switches
with their scope and stays open while adjusting multiple options.
It moves running, queued and background work to a collapsed section above Done
in Recent and behind each project's working counter in Projects. Turning it
off keeps those conversations in the main list in both views.
Pins, unsent drafts, failures and requests for
the user's answer remain visible. Phone search temporarily shows matching
working conversations in the main list. Keyboard thread shortcuts follow the
expanded rows in their displayed order. Merged-PR archiving feeds Done through
the core check below; its PR link appears under the completed title.

Projects shows projects with any active conversation or a draft, including
projects whose conversations are all working. Each project header has separate
Working and Done counters. When working grouping is enabled, its counter toggles
that list; Done toggles completed history. Both lists start closed. Working
includes running, queued and background work. Pins and unsent
drafts stay visible while Working is folded and appear once when expanded;
questions and failures stay in the main list. Done reads only that project's
archived summaries when expanded, with the same reading and restore actions as
Recent. Other projects holds empty projects and projects whose conversations
are all archived, in a closed section below the main list. Creating or restoring
a conversation or starting a draft returns its project to the main list.
Group other projects, in settings and the Projects grouping menu, can be disabled
to keep every project in its normal order. Both grouping preferences persist on
the device. Expansion follows the owning project between desktop and phone for
the current session. Phone search exposes matching
working conversations even when their counter is closed.
Recent project order uses the latest user message among live conversations,
including imported history. Removing or moving the newest conversation lowers
the project; empty projects follow those with conversations. A selected project
promoted to the top by a new prompt also scrolls the desktop sidebar to the top.
Custom project order remains fixed until the user changes it.

Visible desktop thread rows read their PR again every 15 seconds, on a turn's
status change and when the app becomes visible. Folded rows and hidden windows
skip background reads; a failed read keeps the last successful link. The core
shares a 15-second PR list cache across a repository's worktrees and reads each
worktree's own HEAD, so an agent's branch rename or switch does not lose its PR.
Shared project-directory threads never inherit that directory's current branch.

Deletion is owner-only and separate from archive. `threads.remove` stops the
thread family and waits for processes before hiding it behind persistent
markers. `threads.deleted` lists retained conversations and `threads.restore`
restores history and prior archive flags. Undo toasts last eight seconds.
The default retention is 30 days; 0 disables purge. Restart and disconnection do
not erase the markers. Files, branches, worktrees and native transcripts stay
on disk; project removal purges that project's pending deletions.

### Merged pull request archives

Projects default to `autoArchiveMergedPr: true`; the owner changes it through
`projects.setAutoArchiveMergedPr`. The core can automatically archive an idle
root conversation only for a clean linked worktree and a uniquely identified,
merged, non-fork PR from the same repository with the exact branch tip.
The grouping menu in both views exposes this project policy as Hide merged PR
conversations and names the project it affects. In Recent it follows the project
filter, or the current project when all projects are shown. Disabling reveals
that project's automatically hidden conversations immediately, preserves manual
archives and permits hiding them again when the policy is enabled.
A shared checkout, reused branch history, ambiguous root holder, dirty tree or
failed Git/GitHub read leaves the conversation visible.

Viewed, pinned or unread threads remain visible, as do threads with protected
client input, live processes or terminals, queued turns, background work, pending
cards or messages, unfinished goals or loops, and active, paused or undelivered
workflows. Completed workflow and delegated children can remain as history:
every retained child, including an archived child, must be idle with a completed
turn, read, and free of the same activity and input protections. Undelivered or
uncertain family results keep the parent visible. Fresh repository and family
state checks precede the archive transaction. A late child turn or wake cannot
start under an archived parent; Restore admits new work again without changing
the children's existing archive flags. The pass starts after a 90-second startup
grace and repeats at 60-second intervals after completion, admitting at most
eight candidates within a 30-second budget for proof and validation.

Automatic archive changes visibility and records its reason; it does not stop
work or remove a worktree or branch. Restore dismisses the exact PR and protects
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
or phone menu call the same RPC. Sub-threads and resident agent sessions cannot
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

jsdom is pinned to 30.0.1 because
[jsdom#4347](https://github.com/jsdom/jsdom/issues/4347) changes focus/blur ordering
when a focused element is removed, closing menus in the same tick. Recheck that
behavior before changing the pin.

`bun run e2e` exercises real-core RPC with echo, browser UI and the Windows
WebView2 shell when available. Shell automation sets `BOITE_SHELL_HIDDEN=1`.
The native shell cases require their executable and adjacent files;
`BOITE_E2E_SKIP_SHELL=1` explicitly selects a partial core/browser run.
It does not establish native macOS or Linux WebView coverage.

Windows process usage reaches the registry through a completion-port event,
or a one-second fallback after the child exits (`procs.ts`). Cleanup assertions
must wait for both the expected PID set and install leases before checking them;
the child exit callback alone does not establish that the trace row was removed.

### Contract scenarios

`tests/contract/scenarios.ts` drives RPC results and events through the same
behavioral scenarios on a temporary real core and the in-memory client.
`packages/core/test/contract.test.ts` and
`packages/ui/src/lib/fake-client.contract.test.ts` check error codes and data
keys, not message wording. `KNOWN_DIVERGENCES` contains explicit exceptions;
an exception that starts passing fails the runner until removed.

Shared refusals live in `lib/fake-client/checks.ts`, and settings validation
uses contract `checkSettingsPatch`. Side-specific lifecycle and access cases
live in `fake-client.parity.test.ts`. A fake path below a directory named
`missing` represents an absent folder.

## Rebuilding the shell executable

```sh
bun run test:shell
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
bun run e2e
```

Use Tauri to build the executable, including a no-bundle development build:
`bun run --cwd apps/shell tauri build --no-bundle`. A plain Cargo build is useful
for compile errors but does not establish the shell's packaged UI/IPC behavior.
See [releasing](releasing.md) for bundle configurations and installed layouts.

The Windows suite defaults to
`apps/shell/src-tauri/target/release/boite-shell.exe`, or
`BOITE_E2E_SHELL_EXE` when set. It rejects a missing or stale shell, UI, core or
worker before running interactions. With a shared Cargo target, preserve the
shell executable, installer, adjacent core bundle/runtime, workers and CLI
shims from the same build before another worktree replaces them. Test that copy
through `BOITE_E2E_SHELL_EXE`. Filenames and timestamps alone do not identify the
branch; inspect the running UI over CDP for installation claims.

## Staging the sidecar

`bun run stage:core` builds and stages the core. Staging copies artifacts into
the bundler resources and beside a release shell. On Windows the sidecar is
Bun's baseline runtime, with `core/main.js` and split chunks in the adjacent
`core/` directory. Other platforms use the compiled core. Windows verifies the
runtime archive's SHA-256 and executable signature and caches it under
`node_modules/.cache` for the running Bun version.

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
Development queries `?fake=1&appUpdate=ready`, `downloading` or `error`, with
`appUpdateChannel` and `appUpdateCurrentChannel`, preview those states.

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

Real-provider tests use CLI logins and spend tokens. Run selected cases from
`packages/core`, one at a time; never enable them for an ordinary fixture run.

| Variable | Test and boundary |
| --- | --- |
| `BOITE_E2E_CLAUDE=1` | `test/claude.live.test.ts`: turn, resume, native import and warm process |
| `BOITE_E2E_OPENCODE=1` | `test/opencode.live.test.ts`: ACP turn and cold resume |
| `BOITE_E2E_GROK=1` | `test/grok.live.test.ts`: default login, model/effort and cold resume; empty isolated homes can open sign-in |
| `BOITE_E2E_GROK_QUOTA=1` | `test/grok-quota.live.test.ts`: quota for the existing default login |
| `BOITE_E2E_CODEX=1` | `test/codex.live.test.ts`: app-server turn and resume |
| `BOITE_E2E_PI=1` | `test/pi.live.test.ts`: turn and resume |
| `BOITE_E2E_AGY=1` | `test/agy.live.test.ts`: model discovery and one cold default-account turn |
| `BOITE_E2E_INSTALLS=1` | `test/shipped-installs.live.test.ts`: pinned Codex/OpenCode downloads and versions |
| `BOITE_E2E_KEBACC_INSTALL=1` | `test/plugins.install.live.test.ts`: native plugin install/version/uninstall |
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
```

Both use fresh data. `--fresh-only` selects the first idle reading. Rerun before
quoting a performance figure and include its command and date.

## Architecture checks

`bun run check` includes `bun run check:architecture`; the latter uses Bun's
parser without workspace dependencies. `bun test scripts/architecture` covers
cycle detection, resolution, boundaries and source sizes. Runtime-import scope
and exclusions are documented in
[architecture](architecture.md#module-boundaries-and-complexity).

Production TypeScript, JavaScript and Svelte files have a 900-line ceiling.
Existing exceptions in `scripts/architecture/size-budget.json` may shrink.
`--write-size-budget` lowers or removes allowances; it never raises them.
`--rebaseline-size-budget` can raise them for a reviewed integration of branches
written before the limits existed. Exempt contract, client and string tables
have an explicit reason in that file.

`bun run audit:complexity --json` produces an advisory comparison for TypeScript,
JavaScript and Svelte scripts, excluding Rust. A high score requires review of
ownership and duplication, not an automatic split.

## UI spacing and motion

Use `app.css` tokens for colour, radii, spacing and motion, and mirror every
English string in all translations. Floating menus use `lib/floating.ts` and
the browser's top layer; phone controls use the shared sheets. Reduced motion
applies to panels, drawers, terminals and disclosures. Collapsed task controls
are inert. Settings pages use `--settings-width`, `--settings-padding` and
`settings-stack`; explanatory text belongs in `InfoTip`, with visible hints
reserved for current errors, counts or missing steps.

For text beside icons, put `ui-label` on the text leaf inside the flex or grid
row. The shared rule in `app.css` centres the font's cap height and alphabetic
baseline with `text-box`; it keeps padding for accents and descenders when a
label truncates. Use `ui-label-box` on padded badges or inline icon rows to
preserve their original line-height and centre the label. Trimming on the row
itself does not reach its flex items.
The existing line-height remains the fallback when a browser lacks `text-box`.
`bun test tests/e2e/text-alignment.test.ts` measures this alignment across the
eight reading fonts, desktop menus and phone controls.

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
failed call shows its diagnostic above the full input and output. A diff-producing
call stands alone and opens its diff. Codex exit codes determine command status;
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

Three animated dots cover the wait before the first assistant part and text
whose unfinished paragraph is still buffered. Streaming text owns its dots;
active reasoning and tools show their own activity. Queued turns, disconnected
clients, blocking questions and finished turns do not show typing. The dots
pause on hidden pages and become static under reduced motion.
`tests/e2e/chat-context.test.ts` checks these transitions and phone layout.

Received agent mail appears on the right with the user accent; sent agent mail
appears on the left with a neutral surface. Owner prompts keep the user style.
The letter's creation time shows its age in the app's language, updates every
minute while visible and exposes the exact date and time on hover.
`tests/e2e/collaboration-ui.test.ts` checks desktop and phone in both themes.

Calls and reasoning with no answer text between them fold into one line,
"Ran 6 commands" with the run's duration, that opens on its steps in order.
While a step runs the line names it ("Running git", "Thinking") and its clock
ticks. Reasoning with no words that took under a second is not drawn. The core
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
and preload preferences before the first paint. System choices use installed
fonts. In the shell, `Ctrl+=`, `Ctrl+-` and `Ctrl+0` control WebView zoom from
50% to 200%, restored before the window appears. The panel browser has separate
zoom; plain browsers keep their native shortcut behavior.

### File attachments

Desktop and paired devices can pick, paste or drop files. A turn accepts twenty
attachments, at most 5 MB each and 10 MB together. Base64 travels in
`turns.start`; the client rejects a frame above the 16 MB RPC limit before send.
The total cannot grow without a separate upload channel: the journal keeps a
message's attachments inline, and `threads.get` cannot page a message heavier
than its 12 MB page. PNG, JPEG, GIF and WebP use native image input. Other
files, including PDFs and archives, use `kind: 'file'` and host paths in the
prompt. Provider tools decide which formats they can read. Boite neither
extracts archives nor executes uploads.

Before those caps, the client brings an image to 2048 px on its long edge
(`lib/image-prepare.ts`): JPEG at 0.85, or PNG when that is lighter or the
picture uses transparency. An image already within 2048 px and 512 KB goes as
it is, and a GIF or an SVG is never redrawn. HEIC and HEIF become JPEG where the
browser decodes them (Safari does); elsewhere they travel as a plain file. A
source over 50 MB is refused before decoding, since a phone's canvas would not
hold it. So twenty iPhone screenshots, 2 to 4 MB each as PNG, fit one turn at
around 400 KB each.

An answer to a question with a free field takes the composer's files the same
way (`questions.answer` `attachments`); see [Providers](providers.md).

The core validates bytes and writes sanitized, content-addressed copies under
`<dataDir>/attachments/`. Copies survive resume and are currently not removed
by archive or project removal. Timeline cards download those copies. Composer
`[Image N]` references follow attachment order, preview inline and renumber after
removal. A new image accepted during send belongs to the next draft. Refused
sends retain input, attachments and edits made while sending.

Original file links in the local desktop thread may open through the system
application, with executable links retaining their explicit local behavior.
The shell resolves symlinks, checks thread containment and rejects browsed-webview
callers. Remote cores, browsers and phones retain preview/download behavior.
Published snapshots from `boite attach` use the separate safe download/open rules
in [CLI](cli.md); they do not authorize executing an uploaded file.

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
