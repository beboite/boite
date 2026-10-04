# Linux and macOS readiness

The CI matrix builds Linux x64/ARM64 and macOS Intel/Apple Silicon. Intel
macOS is cross-built on Apple Silicon and smoke-tested under Rosetta; the core
suite still runs on an Intel runner. Passing it proves installation startup and
a local agent turn. It does not
prove every desktop interaction or real provider login.

## Installing a release

[Desktop downloads](https://github.com/beboite/boite/releases) include Windows
x64, macOS Intel and Apple Silicon, and Linux x64 and ARM64.

On macOS 13 or newer, drag Boite to Applications. Developer ID releases are
notarized. For an ad hoc build, allow the app in System Settings, Privacy &
Security, or clear its quarantine attribute once:

```sh
xattr -cr /Applications/Boite.app
```

Linux packages need glibc 2.35 or newer and WebKitGTK 4.1. AppImages also need
FUSE 2 (`libfuse2`) and must be made executable. The Debian package declares
its system dependencies.

## Installation and agent execution

`scripts/ci/desktop-smoke.ts` starts the installed Debian package, extracted
AppImage and macOS application bundle from outside the checkout. It uses a
temporary home and data directory, a system-only PATH and no separately
installed Bun runtime. It checks the bundled UI over HTTP, authenticated RPC,
discovery of a CLI in `~/.local/bin`, and an echo turn running `boite where`.
The project and filename contain spaces, apostrophes and accented characters.
The smoke also edits that file, checks the CLI's process trace, and runs a
pseudo-terminal in the project's directory.
On Linux it leaves `BOITE_DATA_DIR` unset and puts `XDG_DATA_HOME` in an
absolute directory with spaces and accents, checking the shell and core agree.
An idle child also survives several memory-guard samples under the default
limits, including on small Linux desktops.

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

`cargo test --manifest-path apps/shell/src-tauri/Cargo.toml --test macos-window`
checks real AppKit buttons on a hidden window at three sizes. They stay centered
in the 44-point toolbar, keep their native order, and leave the navigation clear.
The native layout also runs after resize, scale and focus changes; macOS owns the
sliding title bar in fullscreen. The multi-webview runtime does not apply the
webview builder's traffic-light position, so the shell sets their AppKit frames.

## Remaining gaps

| Area | Current behavior and consequence |
|---|---|
| Process ownership | The registry tracks direct children. Shutdown signals their process groups; descendants that leave those groups can survive. A hard shell exit can leave its core running. See [trace](trace.md). |
| Resource protection | The CPU cap, focus protection and audio muting are Windows-only. The memory guard runs everywhere and stops the heaviest child tree of a thread past its share ([trace](trace.md)). |
| Browser panel on Linux | Tauri packs a child webview into the window's GTK box, where it cannot be placed, so the Linux app shows no built-in browser; the panel offers the system browser instead. Windows and macOS are unaffected. |
| Dictation on Linux | WebKitGTK ships with media capture off and Tauri answers no permission request, so the Linux app says dictation is unavailable. A browser client on the same core can dictate. |
| macOS window | The window keeps the native frame and traffic lights over the title bar, and a menu bar with Edit items for copy and paste. Cmd+W and Cmd+Q belong to the page (`close-surface`, the held quit); Quit in the menu is a click. |
| Linux window | The window manager draws the native title bar and chooses the window buttons, their order, resizing and title-bar actions. The app's toolbar contains navigation and thread actions without duplicate caption buttons. |
| Environment | A desktop launch may have no locale: the core fills in a UTF-8 `LANG` when none of `LANG`, `LC_ALL` and `LC_CTYPE` is set. The macOS terminal starts a login shell, as Terminal.app does, so `~/.zprofile` (Homebrew) is read. An AppImage's runtime and GTK variables are removed from the core's environment, so agents run the system's GTK. On the NVIDIA proprietary driver the Linux shell sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, unless the user set it either way, to avoid an empty window. |
| Notifications | Native thread notifications are not implemented on Linux or macOS. A desktop toast is not guaranteed when a thread finishes out of sight. |
| CLI discovery | Desktop startup adds common installation directories. It does not source shell configuration or discover arbitrary Node version-manager directories. A CLI available only in an interactive shell may remain unavailable. |
| Provider installation | Install and login capabilities depend on each descriptor's OS profile. The bundled echo fixture does not prove a real provider's authentication or update command. See [providers](providers.md). |
| Linux data directory | Both shell and core use `$XDG_DATA_HOME/boite2` when the variable names an absolute directory, otherwise `~/.local/share/boite2`. Empty and relative values are ignored. If the old location has a journal and the XDG location has none, both keep the old location so an upgrade preserves conversations. Data is not moved automatically. The directory remains mode 0700. `BOITE_DATA_DIR` overrides either default. |
| macOS distribution | Releases are signed with a Developer ID and notarized once the Apple secrets exist; until then they are signed ad hoc, and Gatekeeper refuses the first start until the user clears the quarantine attribute or allows it in System Settings. See [installation notes](#installing-a-release) and [releasing](releasing.md#signed-update-artifacts). |
| Native webviews | Portable smoke tests fetch the UI over HTTP. They do not drive WebKitGTK or WKWebView interactions, clipboard, native dialogs, browser-panel navigation or tray behavior. |
| Older systems | Linux packages are built and smoke-tested on Ubuntu 22.04, so glibc 2.35 is their floor; older distributions cannot start them. No runner tests macOS 13, the declared minimum. |

These gaps remain separate from Windows' WebView2 end-to-end coverage. The
cross-platform core tests use fixtures and fresh data directories; live-provider
checks remain opt-in as described in [development](development.md).
