# Working on boite

boite has a Bun core, a Svelte UI and a Tauri desktop shell. Read
[architecture](docs/architecture.md) for the runtime boundaries and
[development](docs/development.md) for setup, tests and captures.

## Commands

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run test:shell
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
bun run e2e
```

`build:shell` builds the UI and stages the core. Follow
[development](docs/development.md#rebuilding-the-shell-executable) for platform
prerequisites, adjacent runtime files and shell E2E coverage.
[CI](docs/ci.md) explains which checks run for each change.

## Boundaries

- Every agent process goes through `procs.spawn`, `procs.spawnChild` or
  `procs.spawnPiped`. The launcher owns tracing, Job Objects and the guards.
- Native process code belongs behind `ProcessPlatform` in `packages/core/src/platform/`.
  Drivers and RPC handlers must not import an OS backend. The shell's OS
  integration belongs in `apps/shell/src-tauri/src/platform/`.
- Change the contract before implementing an RPC method, event or shared type:
  the domain file in `packages/contracts/src/` (`threads.ts`, `providers.ts`),
  which `index.ts` re-exports. Update the real core and the in-memory client
  together. Follow [Adding an RPC method](docs/development.md#adding-an-rpc-method);
  a branch still editing the single `index.ts` runs
  `bun scripts/migrate/split-contracts.ts` after merging main.
- Tests and benches use a fresh temporary `BOITE_DATA_DIR`. Real data directories
  and CLI logins are only for explicitly enabled live tests.
- Kill only a process whose PID the test captured at spawn, or use
  `resources.killTree`. Never kill by executable name or path pattern.
- Launch the shell from automation only with `BOITE_SHELL_HIDDEN=1`. Browsers
  run hidden and muted. Close the processes you start.
- Reject bad descriptors, paths, origins and tokens with the file or field and
  the expected value. Rejected providers remain visible to the client.
- Keep SDKs and Workers lazy. Nothing heavy loads at core startup.
- New RPC methods are owner-only unless `DEVICE_METHODS` permits paired
  devices or `AGENT_METHODS` permits agents, both in
  `packages/contracts/src/access.ts`. Record the reason beside the permission.
- The shell owns windows, the tray, native dialogs and core startup. Execution
  and application logic belong in the core.
- Reach the main window through `window::main_window`. Tauri's
  `get_webview_window` returns `None` once a browser surface is a child
  webview of that window.
- UI colors, radii and durations come from `app.css`, strings from
  `lib/strings.ts`, which serves them in the language the app speaks. Write
  English in `lib/strings/en/<part>.ts` and mirror it in the same part of every translation
  ([docs/language.md](docs/language.md)); a branch still editing the single
  `strings.en.ts` runs `bun scripts/migrate/split-catalogues.ts` after merging
  main. No native `<select>`,
  `window.confirm` or hard-coded hex.
- Each connected machine owns its client and Store. Route actions through the
  owning Store; project and thread IDs can collide between machines.

## Check the affected paths

- Desktop and phone. A right-click-only action is unavailable on a phone.
- All affected protocols: Claude, ACP, Codex, Muse, pi and echo. Their
  drivers own runtime behavior; [providers](docs/providers.md) documents the
  current protocol limits.
- Both transports. The real core and `lib/fake-client.ts` share one contract.
- Reverse actions. Create/archive, install/uninstall, subscribe/unsubscribe,
  warm session/shutdown.
- Windows and Linux. Exact process events exist only on Windows; Linux and
  macOS track direct children and do not promise whole-tree termination.

Run the relevant checks before claiming success. Visual changes need captures
opened at desktop and phone widths. Performance claims need fresh measurements,
with the command and date. Live-provider tests spend tokens and stay opt-in.

## Follow through on pull requests

A PR marked ready gets an mtsu-patrol review; a draft gets CI only. Read every
finding and the failures
from every applicable CI job before changing code. Verify findings against the
current head, fix valid issues and explain rejected suggestions. Group related
fixes into one verified push. Integrate the base branch when a conflict or a
dependency requires it, not merely because another PR merged.

Reply with the fix commit and evidence, then resolve addressed threads. A bot's
acknowledgement is not a new finding or a prerequisite for completion. Mention
a bot only when a question needs its answer; do not request another review of
a head it is already reviewing. Diagnose a failed job before retrying it and
rerun only the failed jobs when the head is unchanged.

A pull request runs the Linux checks, plus the Windows core suite for
protection and shared toolchain inputs; the full Windows, macOS, desktop and
E2E checks run in the merge queue
([pull request runs](docs/ci.md#pull-request-runs)). A
failure there removes the pull request: fix it like any CI failure, then merge
again.

Check CI and new review findings after a push. Track CI and reviews together;
do not wait for one to finish before inspecting the other. A paused,
quota-limited or delayed review is an explicit status to report.
Finish when required checks pass, automatic reviews of the current head have
finished, or the head only answers a review that found no critical or major
issue, and actionable findings are addressed. If work
remains, report the current head, failing checks, unresolved finding links and
the next action. Never describe an unchecked head or a confirmed unresolved bug
as ready to merge.

Add a regression test for a distinct failure that existing coverage cannot
detect. Extend an existing scenario when it exercises the same behavior. Do not
multiply tests for private helpers, implementation details or equivalent inputs
without naming the additional failure they catch. Preserve meaningful coverage
and assertions when making the suite faster.

## Documentation map

- [Documentation index](docs/README.md): one page per subject.
- [Architecture](docs/architecture.md): ownership, persistence and protocols.
- [Providers](docs/providers.md) and [accounts](docs/accounts.md): descriptors,
  executable detection, isolation and login.
- [Project icons](docs/project-icons.md): what a project's folder is searched
  for, the bounds on it and how the image reaches a client.
- [Hooks](docs/hooks.md): the user's hooks on isolated accounts, what each
  driver reports and the Settings view.
- [Secrets](docs/secrets.md): the card an agent asks for a key on, refs,
  the system vault per OS, erasure rules and masking limits.
- [Agent updates](docs/agent-updates.md): version checks, the agent's own
  updater and what a remote machine does by itself.
- [Desktop updates](docs/updates.md): signed app updates and switching nightly channels.
- [Restart handoff](docs/restart-handoff.md): the 30 second wait before an update
  stops a turn, and how the next core resumes it.
- [Workflows](docs/workflows.md): JSON plans of delegated steps and their graph.
- [Bots](docs/bots.md): Boite's persistent agents, each a thread with a name,
  memory, routines and a desk, their `boite bot` commands and their guide.
- [Model switching](docs/model-switching.md) and [context](docs/context.md):
  session reuse, queued turns and compaction.
- [Phone](docs/phone.md), [Android app](docs/android.md) and [server](docs/server.md):
  pairing, the APK and deployment.
- [Android server](docs/android-server.md): the core and agents on a phone in
  Termux, driven by the Boite Server app.
- [Machines](docs/machines.md): connections, browser origins and thread views.
- [Groups](docs/groups.md): the roster of one owner's machines, invitations, tickets and the
  addresses a member gives.
- [Contacts](docs/contacts.md): another owner's Boite linked over Tailscale, the
  projects each side opens and the requests between their agents.
- [Trace](docs/trace.md): process events, resource caps and Windows guards.
- [Performance](docs/performance.md): what a remote client is sent, startup
  order and the benches behind every number.
- [Panel](docs/panel.md) and [CLI](docs/cli.md): the surfaces beside the chat
  and the `boite` command an agent uses to reach them.
- [Devices](docs/devices.md): SDK detection, `boite device` and the Device panel.
- [Windows](docs/windows.md): `boite window` captures of desktop windows, consent,
  exclusions, the Window panel and the backend on each OS.
- [Virtual desktop](docs/desktop.md): `boite desktop`, a private Linux desktop
  in memory where agent-desktop drives GUI apps, its stack, security and lifetime.
- [Admin policy](docs/enterprise.md) and [network flows](docs/network.md): the
  machine policy file, its keys and enforcement, and every outbound connection
  with the key that blocks it. A new outbound flow updates both.
- [Releasing](docs/releasing.md): build artifacts, channels and installers.

Keep tracked documentation in this worktree and verify source paths before
describing behavior. Commands, captures and reports must belong to the branch
being reviewed.
