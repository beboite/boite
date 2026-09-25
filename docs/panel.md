# The right panel

The panel opens to the right of the chat, per thread, from the header's Panel
button, the `panel` chord or one of the surface chords. It keeps its own tabs
and width for each thread in the browser's storage, so a thread comes back the
way it was left. `packages/ui/src/lib/right-panel.svelte.ts` is the store,
`RightPanel.svelte` the frame, one component per surface.

A thread that is archived, here or from another client, or removed with its
project, takes its layout with it, and its browser views are destroyed rather
than parked, since the UI has no way to show an archived thread again. Each
machine's `threads.list` also drops that machine's layouts for threads it no
longer lists, which covers archives made while this client was away. A machine
that has not connected yet keeps its layouts.

A panel with no tab yet opens on the surface the device starts with, Files or
Changes, or on its launcher. The tour's first question sets it and Settings,
Appearance, Workspace changes it ([onboarding.md](onboarding.md)).

## Surfaces

| Surface  | Tab      | What it shows                                                                 |
| -------- | -------- | ----------------------------------------------------------------------------- |
| Browser  | many     | a page in a child webview of the shell (persistent cookies), an iframe in a browser |
| Changes  | one      | `git.status` of the working directory, a file's diff on click                 |
| Files    | one      | the working directory as a tree, `files.list` one directory at a time         |
| File     | per path | a text editor with save, an image viewer with zoom and pan, a video or audio player |
| Tasks    | one      | goal and loop, the agent's tasks, the project's todo list                     |
| Trace    | one      | the thread's processes, see [trace.md](trace.md)                              |

The Browser is the shell's child webview and shares the main webview's profile
directory, which is why a login survives a restart. A plain browser gets an
iframe with the sites that allow it. [machines.md](machines.md) has the origins
and the bridge.

A text file is edited in place and saved with the Save button or the platform's
save chord through `files.write`. An edit not saved yet stays with its tab
while another tab, another thread or a hidden panel unmounts the editor, in
memory only, and closing that tab asks first. An image opens fitted to the panel; the wheel zooms
around the pointer, a drag pans, the bar has fit, 100% and the zoom steps, and
the checkerboard behind it tells transparency from white. A video or a sound
uses the native player over the ticketed file route below. Anything else is a
size and a download link. A text file downloads too, as the editor shows it,
unsaved edits included.

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
to the agents of that project. A paired phone has no Panel button.

## What the agent can ask

The `boite` CLI ([cli.md](cli.md)) calls `panel.open` with a surface: a file
at a line, the changes, one file's diff, a url, the tree, the trace, the tasks.
The core validates it and emits `panel.requested` on every client subscribed
to the thread. The store opens that surface on that thread's panel, and opens
the panel itself when the thread is the one on screen. A thread nobody is
watching keeps the request on its panel for the next open.

## Keys

`panel` toggles the panel, `browser`, `changes`, `files`, `tasks` and `trace`
open their surface, `close-surface` closes the active tab. The defaults are in
[keybindings.md](keybindings.md). With the launcher showing, a single letter
opens a surface: B, C, F, K, T.
