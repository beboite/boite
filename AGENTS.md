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
  `lib/strings.ts`. No native `<select>`, `window.confirm` or hard-coded hex.
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

## Documentation map

- [Documentation index](docs/README.md): one page per subject.
- [Architecture](docs/architecture.md): ownership, persistence and protocols.
- [Providers](docs/providers.md) and [accounts](docs/accounts.md): descriptors,
  executable detection, isolation and login.
- [Model switching](docs/model-switching.md) and [context](docs/context.md):
  session reuse, queued turns and compaction.
- [Phone](docs/phone.md) and [server](docs/server.md): pairing and deployment.
- [Machines](docs/machines.md): connections, browser origins and thread views.
- [Trace](docs/trace.md): process events, resource caps and Windows guards.
- [Releasing](docs/releasing.md): build artifacts, channels and installers.

Keep tracked docs in this worktree. Private working notes under `.claude` are
not tracked and do not follow a worktree; writing them by an absolute path can
change another checkout instead of this branch.
