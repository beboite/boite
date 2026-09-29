# Windows installer template

`installer.nsi` comes from [Tauri CLI 2.11.4](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi),
under the MIT license in `LICENSE-tauri`. The version matches
`@tauri-apps/cli` in `apps/shell/package.json`.

Local changes preserve pinned shortcuts during updates:

- `.onInit` treats an existing executable in the selected installation directory
  as an update, including when the installer was downloaded manually.
- `PageReinstall` skips the uninstall-first choice for updates.
- The directory page keeps updates at the path used by existing pins.
- The shortcut functions return before saving a link whose target is already
  the current executable. Binary-name migrations still update old links.

When updating the Tauri CLI, compare this file with the new upstream template
and reapply these changes. Keep its MIT notice. Run `bun run build:shell` and
`bun test scripts/ci/installer-shortcuts.test.ts scripts/ci/installer-hooks.test.ts`
on Windows. Set `CARGO_TARGET_DIR` when using a shared Cargo target directory.
