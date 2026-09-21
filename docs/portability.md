# Linux and macOS readiness

The native CI matrix builds Linux x64/ARM64 and macOS Intel/Apple Silicon.
Passing it proves installation startup and a local agent turn. It does not
prove every desktop interaction or real provider login.

## Installation and agent execution

`scripts/ci/desktop-smoke.ts` starts the installed Debian package, extracted
AppImage and macOS application bundle from outside the checkout. It uses a
temporary home and data directory, a system-only PATH and no separately
installed Bun runtime. It checks the bundled UI over HTTP, authenticated RPC,
discovery of a CLI in `~/.local/bin`, and an echo turn running `boite where`.

Three portability regressions have dedicated coverage:

- Linux and macOS package resources live apart from executables. The shell
  supplies the CLI resource directory and the core executable path; the POSIX
  shim preserves spaces and arguments. `scripts/ci/installed-cli.test.ts` and
  the installed smoke test cover this path.
- A directory or a non-executable POSIX file cannot mask a working provider
  candidate. `packages/core/test/providers.test.ts` checks fallback selection.
- POSIX environment names are case-sensitive. A variable named `Path` must
  not divert the CLI entry from `PATH`. `packages/core/test/agent.test.ts`
  checks this while preserving Windows behavior.

## Remaining gaps

| Area | Current behavior and consequence |
|---|---|
| Process ownership | Only direct agent children are tracked and stopped. Grandchildren can survive a stopped turn. A hard shell exit can leave its core running. See [trace](trace.md). |
| Resource protection | CPU and memory caps, focus protection and audio muting are Windows-only. Enabling their settings adds no protection on POSIX. |
| Notifications | Native thread notifications are not implemented on Linux or macOS. A desktop toast is not guaranteed when a thread finishes out of sight. |
| CLI discovery | Desktop startup adds common installation directories. It does not source shell configuration or discover arbitrary Node version-manager directories. A CLI available only in an interactive shell may remain unavailable. |
| Provider installation | Install and login capabilities depend on each descriptor's OS profile. The bundled echo fixture does not prove a real provider's authentication or update command. See [providers](providers.md). |
| Linux data directory | The current default is `~/.local/share/boite2`; it does not honor `XDG_DATA_HOME`. Use `BOITE_DATA_DIR` for a different location. Both shell and core must keep using the same directory. |
| macOS distribution | CI uses ad-hoc signing. Developer ID signing, notarization and Gatekeeper testing remain release prerequisites. See [releasing](releasing.md). |
| Native webviews | Portable smoke tests fetch the UI over HTTP. They do not drive WebKitGTK or WKWebView interactions, clipboard, native dialogs, browser-panel navigation or tray behavior. |
| Older systems | The current native matrix does not test the oldest supported macOS version or older Linux distributions. A successful current-runner build does not establish their compatibility. |

These gaps remain separate from Windows' WebView2 end-to-end coverage. The
cross-platform core tests use fixtures and fresh data directories; live-provider
checks remain opt-in as described in [development](development.md).
