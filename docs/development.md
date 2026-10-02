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
default: `%LOCALAPPDATA%\boite2`, `~/.local/share/boite2` or
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

Fake browser fixtures do not always need a development server.
`tests/e2e/lib/ui.ts` selects a prebuilt fixture from `BOITE_E2E_FAKE_UI`, builds
one per test process with `BOITE_E2E_PREBUILT_UI=1`, or falls back to Vite.
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

New drafts use `Project.worktreeDefault`, configured by the owner through
`projects.setWorktreeDefault`. A draft's explicit choice overrides it. Moving a
draft uses the target's default unless explicitly chosen; restored drafts keep
their choice. Enabling the default requires a Git repository other than Drafts.

With `worktree: {}`, `threads.create` runs `git worktree add -b` before writing
the thread. The temporary branch is `boite/wt-<id>`, unless explicitly named;
the directory is `<project>/.boite/worktrees/wt-<id>` by default.
`settings.worktreeStorage` selects project storage or an absolute shared folder,
where `<project-name>-<project-id>/wt-<id>` separates repositories with matching
names. A changed setting affects new worktrees only. Existing threads and
prepared workspaces retain their recorded path. Nested directories are excluded
through Git's local `info/exclude`, without changing `.gitignore`.

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
`threads.focus`; a disconnected or older client cannot report parked local
input. The current UI retains unsent composer input, paused queues, preview undo
and unsaved panel drafts on automatic archive. Manual archive and deletion keep
their explicit clearing behavior.

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
owns provider defaults, accepted execution targets and context transfer.
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
Fixture harnesses set it. Explicit live-test flags opt back into host agents.

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

`jobs-worker.js`, `guard-worker.js` and both CLI shims accompany the core.
Missing workers reduce Windows tracking or disable guards; the E2E fixture
refuses stale or missing files. Run staging again after the shell build so
its output has the complete adjacent runtime.

## Captures

`tests/e2e/lib/cdp.ts` starts a muted headless browser with a disposable profile.
The browser override is `BOITE_E2E_BROWSER`. Local Windows uses native ANGLE;
CI uses CPU compositing with software GL disabled. Browser launch failure
reports early exit or the CDP deadline and saves the last 16 KiB of stderr.
Screenshots go to the ignored `tests/e2e/.artifacts/`. Open desktop and phone
captures before claiming a visual change is verified.

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

Tool cards retain full input/output on expansion. Consecutive successful calls
fold into a count-based summary in first-seen kind order; failed and denied calls
keep a diagnostic preview. A diff-producing call stands alone and opens its diff.
Codex exit codes determine command status; stderr text does not. Answered
questions expand read-only. Turn receipts mean core acceptance and first
assistant activity, not a protocol read receipt. Animations pause when hidden
and respect reduced motion.

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

Desktop and paired devices can pick, paste or drop files. A turn accepts eight
attachments, at most 5 MB each and 10 MB together. Base64 travels in
`turns.start`; the client rejects a frame above the 16 MB RPC limit before send.
PNG, JPEG, GIF and WebP use native image input. Other files, including PDFs and
archives, use `kind: 'file'` and host paths in the prompt. Provider tools decide
which formats they can read. Boite neither extracts archives nor executes uploads.

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
