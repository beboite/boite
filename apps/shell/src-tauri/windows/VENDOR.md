# Windows installer template

`installer.nsi` comes from [Tauri CLI 2.11.4](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi),
under the MIT license in `LICENSE-tauri`. This is the template's upstream
version. The current `@tauri-apps/cli` dependency in `apps/shell/package.json`
is 2.11.5; updating that dependency does not refresh this vendored file.

Local changes preserve pinned shortcuts during updates:

- `.onInit` treats an existing executable in the selected installation directory
  as an update, including when the installer was downloaded manually.
- `PageReinstall` skips the uninstall-first choice for updates.
- The directory page keeps updates at the path used by existing pins.
- The shortcut functions return before saving a link whose target is already
  the current executable. Binary-name migrations still update old links.
- The finish-page checkbox can recreate a missing desktop link on request;
  automatic update calls still leave missing links absent.
- `.onInit` also counts the executable of the previous install's registered
  `MainBinaryName` as an update, so a binary rename (Boite Dev's
  `boite-shell.exe` to `boite-dev-shell.exe`) keeps the in-place path.
- The install and uninstall sections skip `CheckIfAppIsRunning`, which finds
  and kills processes by file name, when `hooks.nsh` defines
  `BOITE_HOOKS_CLOSE_SHELL`: the hooks close this install's shell by its path.

When updating the Tauri CLI, compare this file with the new upstream template
and reapply these changes. Keep its MIT notice. Run `bun run build:shell` and
`bun test scripts/ci/installer-shortcuts.test.ts scripts/ci/installer-hooks.test.ts`
on Windows. Set `BOITE_CI_INSTALLER_REQUIRED=1` to fail when NSIS or the
generated installer fixtures are missing. If Cargo uses a shared target,
point `CARGO_TARGET_DIR` at that existing target so the tests find its fixtures.
