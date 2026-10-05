# The right panel

The Panel button or [surface shortcuts](keybindings.md) open a thread's tabs
beside the chat. Tabs are stored per machine/thread; width is shared on this device.
Below 720 px it covers the chat; Back closes it. A mobile reload keeps tabs but
starts with the panel closed, without changing the stored desktop layout.
`lib/right-panel.svelte.ts` owns layout and `RightPanel.svelte` renders it;
`lib/surface-labels.ts` defines labels and availability.

## Browser tools

On Windows, the browser's screen menu selects phone, tablet and desktop
viewport sizes, portrait or landscape orientation, and the page's light or
dark appearance. It also opens diagnostics with console messages, exceptions,
failed requests and recent automation actions. These tools remain inside
Boite. The recording button captures the page at 30 frames per second, or 60,
in H.264, HEVC or AV1, chosen in the same menu; a codec the desktop cannot
encode is greyed out there. Stopping opens a video player with download and
discard actions, or says the view cannot play the codec and keeps the download. The [CLI](cli.md) exposes the same tools
to agents, including recording and attaching the result to chat.

## Floating panel and browser overlays

In the shell, the browser toolbar can detach the panel into a floating card
inside the app. Drag its top bar, including tab labels, to move it; controls keep
their actions. Resize from any edge or corner. The card stays within the app
content area. Moving, resizing, maximizing and docking keep the same page
mounted, preserving forms and history. The Dock panel control restores the side
panel from any tab, including after the last browser closes or the conversation
changes. Maximizing fills the app content area; restoring returns to the previous
size. At phone width the floating panel fills the screen.

In the shell, the native browser view paints above HTML menus. While a menu or
dialog overlaps its page, the UI parks the view and displays a screenshot
underneath the overlay. Closing it restores the same view without reloading the
page.

## Thread and tab lifetime

Switching conversations or machines and hiding the panel parks browser pages
without destroying them. Their forms, navigation history and recordings remain
in memory. The agent's own tabs are not panel pages: they live in the browser
of the machine that runs the conversation ([the agent's browser](browser.md))
and keep working whichever client is open. Closing tabs, archiving the
conversation or quitting the shell releases their pages. Reloading the UI
recreates pages from their stored addresses, without preserving live DOM state.

Manual archive here or project removal clears the thread's panel and destroys
its browser views. After the layout has been cleared, restoring the thread starts
with a fresh panel. If another client archives the open thread, it stays on
screen with its tabs and unsaved file edits, reconnects included, until this
client opens another thread or a draft. Leaving a manually archived thread drops
its layout.
Automatic merged-PR archive preserves unsent composer input and unsaved file
drafts for restoration. On reconnect, this machine's `threads.list` prunes
layouts for threads it no longer lists, except the open thread and layouts with
unsaved file drafts. A machine that has not connected keeps its own layouts.
[Automatic merged-PR archive](machines.md#merged-pr-conversations) documents
the archive conditions.

A panel with no tab yet opens on the surface the device starts with, Files or
Changes, or on its launcher. The tour's first question sets it and Settings,
Appearance, Workspace changes it ([onboarding.md](onboarding.md)). Settings,
Appearance, Buttons, or a card's right click, takes a kind off the launcher and
the new-surface menu; the palette, its keyboard shortcut and an agent still open
it, and the menu's last row, Choose the buttons, leads back to the switches.

## Surfaces

| Surface  | Tab      | What it shows                                                                 |
| -------- | -------- | ----------------------------------------------------------------------------- |
| Browser  | many     | the user's own pages, in a shell child webview with persistent cookies; test fixtures use an iframe |
| Agent browser | one | the agent's tabs on the conversation's machine, covered until Show, then live; see [browser.md](browser.md) |
| Changes  | one      | `git.status` of the working directory, a file's diff on click                 |
| Files    | one      | the working directory as a tree, `files.list` one directory at a time         |
| File     | per path | a text editor with save, an image viewer with zoom and pan, a video or audio player |
| Tasks    | one      | goal and loop, the agent's tasks, the project's todo list                     |
| Messages | one      | agent exchanges, filtered to all, sent or received; a chat count opens its burst |
| Subagents | one     | the thread's workflow runs and subagents in one list, a run's graph, a subagent's conversation, see [delegation.md](delegation.md) and [workflows.md](workflows.md) |
| Trace    | one      | the thread's processes, see [trace.md](trace.md)                              |
| Device   | one      | the simulators and emulators open in the thread, covered until Show, see [devices.md](devices.md) |

The iframe bridge belongs to browser test fixtures; ordinary web clients have
no native Browser surface. [Portability](portability.md#remaining-gaps) records
the Linux shell's system-browser fallback.

The address field accepts public hosts, local development addresses such as
`localhost:5173` or a private IPv4 server, and search terms. Loopback, private
and link-local IPv4 addresses use HTTP when no scheme is given; public hosts
use HTTPS. Loading and navigation failures appear in the toolbar. A page zoom
other than 100% has a reset button.
`lib/browser-bounds.ts` observes layout changes and follows finite layout
animations, rather than measuring the page slot on every idle frame.

### Browser profiles

A browser tab opens in a profile and keeps it. Each profile has its own cookies,
storage and logins, kept across restarts. **Default** is the profile every tab
used before there were others, so earlier logins stay there. Settings > General >
Browser profiles adds, renames and deletes the others, and chooses the one new
tabs open in. The profile button in the address bar names the tab's profile
(only its icon on a narrow bar). Its menu, like the panel's **+** menu, opens a
new tab in another profile, or a private tab. A private tab is chosen per tab,
never as the default. Private tabs share one session that keeps nothing once
the last of them closes.

The profiles belong to the desktop that shows the browser: they are stored in
the settings of the core its shell started, and a phone has no Browser surface
to choose them. Deleting a profile closes its tabs in every conversation and
erases what it kept. On Windows each profile is a WebView2 profile of the
shell's single browser process (`src/platform/webview_profiles.rs`): the
debugging port is unchanged, and WebView2 removes a deleted profile's folder
when that process exits, which is why an id is never reused. macOS keeps each
profile in a WebKit data store, which needs macOS 14. The Linux shell has no
built-in browser. `tests/e2e/browser-profiles.test.ts` checked separate cookies,
their survival across a restart and deletion in the real shell. It drove the
shell's tabs through `browser.command`, which now reaches the core's browser, so
it and `browser-native.test.ts` are skipped until they are rewritten on the
shell's `browser_protocol` command on a Windows machine.

The agent's browser runs on the machine of its conversation and keeps its own
copy of each profile there. **Copy sign-ins to agents**, on a profile's row in
the Windows desktop app, sends that profile's cookies to a machine's agent
browser ([the agent's browser](browser.md#copying-a-desktop-profiles-sign-ins)).
The agent's `boite browser profiles` and `open <url> --profile <name>` are
described in the [CLI](cli.md).

### Sign-in popups and new windows

A page that calls `window.open` with a size or a position, as "Sign in with
Google" and most sign-in buttons do, gets a real popup window
(`apps/shell/src-tauri/src/browser/popups.rs`). The popup opens in the tab's
profile, or in the private session, and keeps `window.opener`: the sign-in
answers the page through it and closes itself. Its title starts with the
host it shows, since it has no address bar. Closing the tab closes its
popups. A `target="_blank"` link, or `window.open` without a size, opens a tab
in the same panel and profile instead, and that tab has no opener. So does a
sized `window.open` while the tab already holds three popups: WebView2 has no
popup blocker. Popups are
desktop windows: an agent's browser commands and the phone's remote view see
the tab, not its popups.

Surfaces and popups show other sites without the app's bridge. On Windows
`src/platform/browser_page.rs` turns off WebView2's `chrome.webview`, and removes
the scripts Tauri and its plugins added to the webview (`__TAURI_INTERNALS__`,
`ipc`, the opener plugin's link handler) before the first page loads. That
handler used to swallow every `target="_blank"` link. macOS still injects
Tauri's scripts into a surface.

The browser keeps WebView2's own user agent. On Google's sign-in pages the
runtime already reports Chrome there, in the header and in
`navigator.userAgentData`. Edge's user agent would double the "Microsoft Edge"
brand. A DevTools override changes the headers of cross-site frames but not
their `navigator.userAgentData`, and that mismatch is the kind bot checks such as
Turnstile reject. `tests/e2e/browser-profiles.test.ts` checked the popup's opener,
profile and missing bridge, and the `_blank` tab, before it was skipped (see
Browser profiles above).

### Local HTML artifacts

`boite preview reports/index.html` opens a generated page in the integrated
browser, including relative CSS, JavaScript, images and other public web assets
under that HTML file's directory. `boite browse reports/index.html` does the
same. The agent guide includes the command for every provider.

Each entry point has its own HTTP origin and an unguessable URL. Preview scripts
cannot read the core UI's storage or connect to its authenticated WebSocket.
Paths outside the artifact directory, dotfiles, non-web file types and escaping
symlinks are refused. Files are read live, so reload reflects edits.

`boite preview-close reports/index.html` stops its server. Archiving or removing
the thread and shutting down the core also close previews. Up to 16 can be open
at once. Opening another evicts the least recently used preview; reopening a
preview or fetching one of its assets updates its recency. Run `preview` again
after eviction or a core restart to obtain a new URL. Remote
desktop clients need a direct connection to the preview's additional HTTP port;
a proxy that forwards only the core port does not forward artifact previews.

### Editing files

A text file is edited in place and saved with the Save button or the platform's
save chord through `files.write`.

An edit not saved yet stays with its tab
while another tab, another thread or a hidden panel unmounts the editor, in
memory only, and closing that tab asks first. An image opens fitted to the panel; the wheel zooms
around the pointer, a drag pans, the bar has fit, 100% and the zoom steps, and
the checkerboard behind it tells transparency from white. A video or a sound
uses the native player over the ticketed file route below. Anything else is a
size and a download link. A text file downloads too, as the editor shows it,
unsaved edits included.

Text files and diffs choose syntax highlighting from the file extension or
the file's reported language. Highlight.js loads its core and each requested
grammar on demand. Unknown languages and texts over 200,000 characters remain
plain text. The editor keeps its selection, caret and scroll in a textarea
over the colored text. Diffs render additions in green and deletions in red,
including the text, line numbers and signs; unchanged context keeps syntax
colors. Multiline tokens retain their color across folded context.

Run `bun test tests/e2e/panel.test.ts` to check the panel at desktop and phone
widths. Captures and `browser-idle.json`, which counts geometry reads across
60 idle frames, are written under `tests/e2e/.artifacts/`.

## Files from an answer

A finished turn that wrote files ends with a card listing them: new, changed
or deleted, read from the diff documents Claude and ACP agents attach, from a
Codex patch's `changes`, or from a write or edit call's path. A call that
failed or was denied lists nothing. `lib/turn-files.ts` does the reading.

A row opens its file in a File tab, which is how a phone gets at the file and
its download. In the shell on its own core, `Show in folder` hands the path to
the system file manager through the opener plugin's `reveal_item_in_dir`,
selected and never opened: a program an agent wrote is not run from here. A
file outside the thread's directory shows without the open action, since
`files.read` stays inside it.

Captures: [changes](images/panel-changes-desktop.png) · [files](images/panel-files-desktop.png) · [editor](images/panel-file-text-desktop.png) · [picture, zoomed](images/panel-file-image-zoomed.png) · [video](images/panel-cli-video.png) · [tasks](images/panel-tasks-desktop.png) · [changes at phone width](images/panel-changes-phone.png) · [editor at phone width](images/panel-file-text-phone.png) · [floating panel](images/browser-floating-desktop.png) · [floating browser menu](images/browser-floating-menu.png) · [floating panel at phone width](images/browser-floating-phone.png)

## What the core provides

Every surface reads the thread's working directory through the core, never the
browser's file system: `git.status`, `git.diff`, `files.list`, `files.read`,
`files.write`, `todos.*`, `threads.tasks.*` in `packages/contracts/src/index.ts`.
Paths are relative to the thread's cwd, or absolute inside it, and a path that
resolves outside (a symlink out, a `..`) is refused by name. `files.write` also
refuses a link to nothing, since the write would create its target.

The Changes tab reads the same checkout the agent writes in, so its git runs
with `GIT_OPTIONAL_LOCKS=0` and counts lines with `git diff-index`, neither of
which writes the index back: an agent's own `git add` or `git commit` never
meets an `index.lock` the panel took. Each of those reads has 30 seconds. A git
that has not answered by then is stopped by its own process id and the read
fails with the command and the directory; the thread's other processes are
left alone.

`files.read` answers text inline, cut at `FILE_MAX_BYTES`. A picture, a video,
a sound or another binary comes as a url on the core's HTTP server,
`GET /file/<ticket>`, where the ticket is a random value bound to one path and
good for `FILE_TICKET_TTL_MS`. The route answers range requests, which is what
lets a video seek, and is never cached. It answers `nosniff` and
`content-disposition: attachment`, so a ticket opened as a page downloads
instead of rendering. The answer carries the path only, and the UI resolves it
against the origin it reached the core by.

A ticket also records the file's real path, identity, size and modification
times. Replacing or modifying the file invalidates it, including replacing an
ancestor with a junction. An expired or invalidated ticket returns the same 404.

The shell's content security policy lets pictures and media load from the
local core and HTTP or HTTPS `/file/` routes on remote cores. A shell driving
another machine can preview its images, videos and audio through the same
short-lived tickets. Other remote image paths stay blocked.

The reads (`git.*`, `files.list`, `files.read`, `todos.list`, the tasks) are
the owner's and the thread's own agent's. A paired phone also reads `git.status`,
`git.diff` against `HEAD` only, `files.list` and `files.read`, on a thread whose
real working directory is inside its project or the core's worktree folder
([phone.md](phone.md#what-a-paired-device-may-call)). `files.write`,
`todos.remove` and a todo's `done` are the owner's alone, and `todos.updated`
goes to the owner and to the agents of that project. A paired phone has the
Panel button too, and its menu offers Changes, Files (read-only, no Save),
Subagents and Messages; Tasks and the trace stay the owner's. The Messages tab
uses the same coordination and delegation reads as the chat and fills the
screen on a phone.

## What the agent can ask

The `boite` CLI ([cli.md](cli.md)) calls `panel.open` with a surface: a file
at a line, the changes, one file's diff, a url, the tree, the trace, the tasks,
a workflow run.
The core validates it and emits `panel.requested` on every client subscribed
to the thread. The store opens that surface on that thread's panel, and opens
the panel itself when the thread is the one on screen. A thread nobody is
watching keeps the request on its panel for the next open.

## Keys

`panel` toggles the panel, `browser`, `changes`, `files`, `tasks` and `trace`
open their surface, `close-surface` closes the active tab. The defaults are in
[keybindings.md](keybindings.md). With the launcher showing, a single letter
opens a surface: A, B, C, D, F, K, M, T, W. M opens Messages, D the Device
surface and W the Agent browser.

## Experimental PR review

Settings, Experiments, **PR review** adds **Read in Boite** to each PR linked
to the conversation. The review shows the description, changed files and their
diffs, discussion and inline comments, reviews, and GitHub check results. The
same dialog works at phone width; diffs scroll horizontally and long filenames
wrap without covering their change counts.

Reads use the desktop core's existing `gh` login. A paired phone can read only
PRs already linked to that conversation; it cannot add links or make arbitrary
GitHub queries. The feature does not post comments, approve, merge, or archive
the conversation. The external GitHub link remains available for those actions.

Files load 30 at a time. Binary files without a patch are named explicitly.
Large patches and discussions show a truncation notice, and GitHub remains the
source for omitted content. Results are cached for ten seconds. Descriptions
and comments use the existing escaped Markdown renderer; remote images are
not fetched.

## Experimental recording indicators

Enable **Recording indicators** before starting a browser recording to include
fading click rings and navigation-key labels in the saved video. The collector
keeps at most twelve recent marks, omits printable key labels, and ignores
navigation keys in password and payment fields. Page contents are still part
of the recording. Stopping or closing the browser removes the collector.

The encoder receives each completed canvas frame after both the page capture
and its indicators have been drawn. `tests/e2e/browser-remote.test.ts` decodes
the saved recording and checks that a navigation-key badge is present; a
collector receiving an event alone does not verify the exported video.
