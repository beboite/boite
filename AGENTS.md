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

`build:shell` builds the UI and sidecar. The staging command after it also puts
that sidecar beside a newly built shell for end-to-end tests.
[CI](docs/ci.md) explains which checks run for each change.

## Boundaries

- Every agent process goes through `procs.spawn`, `procs.spawnChild` or
  `procs.spawnPiped`. The launcher owns tracing, Job Objects and the guards.
- Native process code belongs behind `ProcessPlatform` in `packages/core/src/platform/`.
  Drivers and RPC handlers must not import an OS backend. The shell's OS
  integration belongs in `apps/shell/src-tauri/src/platform/`.
- Change `packages/contracts/src/index.ts` before implementing an RPC method,
  event or shared type. Update the real core and the in-memory client together.
- Tests and benches use a fresh temporary `BOITE_DATA_DIR`. Real data directories
  and CLI logins are only for explicitly enabled live tests.
- Kill only a process whose PID the test captured at spawn, or use
  `resources.killTree`. Never kill by executable name or path pattern.
- Launch the shell from automation only with `BOITE_SHELL_HIDDEN=1`. Browsers
  run hidden and muted. Close the processes you start.
- Reject bad descriptors, paths, origins and tokens with the file or field and
  the expected value. Rejected providers remain visible to the client.
- Keep SDKs and Workers lazy. Nothing heavy loads at core startup.
- New RPC methods are owner-only unless `packages/core/src/access.ts` explicitly
  permits paired devices. Record the reason beside the permission.
- The shell owns windows, the tray, native dialogs and core startup. Execution
  and application logic belong in the core.
- UI colors, radii and durations come from `app.css`, strings from
  `lib/strings.ts`, which serves them in the language the app speaks. Write
  English in `lib/strings.en.ts` and mirror it in every translation
  ([docs/language.md](docs/language.md)). No native `<select>`,
  `window.confirm` or hard-coded hex.
- Each connected machine owns its client and Store. Route actions through the
  owning Store; project and thread IDs can collide between machines.

## Check the affected paths

- Desktop and phone. A right-click-only action is unavailable on a phone.
- All affected drivers. Claude, ACP, Codex, pi and echo have different limits.
- Both transports. The real core and `lib/fake-client.ts` share one contract.
- Reverse actions. Create/archive, install/uninstall, subscribe/unsubscribe,
  warm session/shutdown.
- Windows and Linux. Exact process events exist only on Windows; Linux and
  macOS track direct children and do not promise whole-tree termination.

Run the relevant checks before claiming success. Visual changes need captures
opened at desktop and phone widths. Performance claims need fresh measurements,
with the command and date. Live-provider tests spend tokens and stay opt-in.

## Follow through on pull requests

Opening a PR triggers automated reviews. Read every finding and the failures
from every applicable CI job before changing code. Verify findings against the
current head, fix valid issues and explain rejected suggestions. Group related
fixes into one verified push. Integrate the base branch when a conflict or a
dependency requires it, not merely because another PR merged.

Reply with the fix commit and evidence, then resolve addressed threads. A bot's
acknowledgement is not a new finding or a prerequisite for completion. Mention
a bot only when a question needs its answer; do not request another review of
a head it is already reviewing. Diagnose a failed job before retrying it and
rerun only the failed jobs when the head is unchanged.

Check CI and new review findings after a push. Default to the initial review
and one follow-up, with at most 15 minutes spent waiting for bots across both.
This limits waiting, not bug fixes or CI verification. A paused, quota-limited
or delayed review is an explicit status to report, not a reason to poll forever.
Stop when required checks pass and actionable findings are addressed. If work
remains, report the current head, failing checks, unresolved finding links and
the next action. Never describe an unchecked head or a confirmed unresolved bug
as ready to merge.

## Documentation map

- [Documentation index](docs/README.md): one page per subject.
- [Architecture](docs/architecture.md): ownership, persistence and protocols.
- [Providers](docs/providers.md) and [accounts](docs/accounts.md): descriptors,
  executable detection, isolation and login.
- [Hooks](docs/hooks.md): the user's hooks on isolated accounts, what each
  driver reports and the Settings view.
- [Agent updates](docs/agent-updates.md): version checks, the agent's own
  updater and what a remote machine does by itself.
- [Desktop updates](docs/updates.md): signed app updates and switching nightly channels.
- [Workflows](docs/workflows.md): JSON plans of delegated steps and their graph.
- [Model switching](docs/model-switching.md) and [context](docs/context.md):
  session reuse, queued turns and compaction.
- [Phone](docs/phone.md) and [server](docs/server.md): pairing and deployment.
- [Machines](docs/machines.md): connections, browser origins and thread views.
- [Trace](docs/trace.md): process events, resource caps and Windows guards.
- [Performance](docs/performance.md): what a remote client is sent, startup
  order and the benches behind every number.
- [Panel](docs/panel.md) and [CLI](docs/cli.md): the surfaces beside the chat
  and the `boite` command an agent uses to reach them.
- [Releasing](docs/releasing.md): build artifacts, channels and installers.

Keep tracked docs in this worktree. Private working notes under `.claude` are
not tracked and do not follow a worktree; writing them by an absolute path can
change another checkout instead of this branch.
