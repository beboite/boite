# The right panel

The panel opens to the right of the chat, per thread, from the header's Panel
button, the `panel` chord or one of the surface chords. It keeps its own tabs
and width for each thread in the browser's storage, so a thread comes back the
way it was left. Under 720 px the panel is a sheet over the whole chat, so a
reload there opens on the chat with the panel shut and its tabs kept for the
next open, and Back shuts it. That reload-time shut is held in memory beside
the stored layout, so a wider window of the same browser still finds its panels
open after the phone has used its own. `packages/ui/src/lib/right-panel.svelte.ts` is the store,
`RightPanel.svelte` the frame, one component per surface. The frame's launcher,
resize handle and tab icon are `SurfaceLauncher.svelte`, `PanelResizeHandle.svelte`
and `SurfaceIcon.svelte`; `lib/surface-labels.ts` names each surface and says where
it is available.

A thread that is archived, here or from another client, or removed with its
project, takes its layout with it, and its browser views are destroyed rather
than parked: a thread restored from Archived threads comes back with a fresh
panel, never with what it had open. The one
exception is the thread on screen when another client archives it: it stays
open with its tabs and unsaved file edits, reconnects included, and its layout
goes when this client opens another thread or a draft. Each machine's
`threads.list` also drops that machine's layouts for threads it no longer
lists, which covers archives made while this client was away, except the open
thread's. A machine that has not connected yet keeps its layouts.

A panel with no tab yet opens on the surface the device starts with, Files or
Changes, or on its launcher. The tour's first question sets it and Settings,
Appearance, Workspace changes it ([onboarding.md](onboarding.md)). Settings,
Appearance, Buttons, or a card's right click, takes a kind off the launcher and
the new-surface menu; the palette, its keyboard shortcut and an agent still open
it, and the menu's last row, Choose the buttons, leads back to the switches.

## Surfaces

| Surface  | Tab      | What it shows                                                                 |
| -------- | -------- | ----------------------------------------------------------------------------- |
| Browser  | many     | a page in a child webview of the shell (persistent cookies), an iframe in a browser |
| Changes  | one      | `git.status` of the working directory, a file's diff on click                 |
| Files    | one      | the working directory as a tree, `files.list` one directory at a time         |
| File     | per path | a text editor with save, an image viewer with zoom and pan, a video or audio player |
| Tasks    | one      | goal and loop, the agent's tasks, the project's todo list                     |
| Subagents | one     | the thread's workflow runs and subagents in one list, a run's graph, a subagent's conversation, see [delegation.md](delegation.md) and [workflows.md](workflows.md) |
| Trace    | one      | the thread's processes, see [trace.md](trace.md)                              |

The Browser is the shell's child webview and shares the main webview's profile
directory, which is why a login survives a restart. A plain browser gets an
iframe with the sites that allow it. [machines.md](machines.md) has the origins
and the bridge.

The address field accepts public hosts, local development addresses such as
`localhost:5173` or a private IPv4 server, and search terms. Loopback, private
and link-local IPv4 addresses use HTTP when no scheme is given; public hosts
use HTTPS. Loading and navigation failures appear in the toolbar. A page zoom
other than 100% has a reset button.
`lib/browser-bounds.ts` observes layout changes and follows finite layout
animations, rather than measuring the page slot on every idle frame.

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
at once. After a core restart, run `preview` again to obtain a new URL. Remote
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

Captures: [changes](images/panel-changes-desktop.png) · [files](images/panel-files-desktop.png) · [editor](images/panel-file-text-desktop.png) · [picture, zoomed](images/panel-file-image-zoomed.png) · [video](images/panel-cli-video.png) · [tasks](images/panel-tasks-desktop.png) · [changes at phone width](images/panel-changes-phone.png) · [editor at phone width](images/panel-file-text-phone.png)

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

The shell's content security policy lets pictures and media load from
`http://127.0.0.1:*` and nothing wider. A shell driving a core on another
machine therefore reads and edits text there, and shows no picture or video
from it; a browser opened on that core's own address shows them.

The reads (`git.*`, `files.list`, `files.read`, `todos.list`, the tasks) are
the owner's and the thread's own agent's. `files.write`, `todos.remove` and a
todo's `done` are the owner's alone, and `todos.updated` goes to the owner and
to the agents of that project. A paired phone has the Panel button too, and its
menu offers the Subagents surface, the one it may follow.

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
opens a surface: B, C, F, K, T, W.
