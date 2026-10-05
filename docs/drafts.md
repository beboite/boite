# Drafts

Not every conversation belongs to a code project. Someone writing a letter,
sorting receipts or planning a trip has no folder to open first, so the app
starts them in the drafts: a project the core makes in the Documents folder of
the machine it runs on, `Documents/Boite`.

## Where a draft lives

- The first launch opens a draft in the drafts, not a folder picker. Nothing is
  written to disk until the first send: the client then calls `projects.drafts`,
  which makes the folder and the project once and answers the same project on
  every later call.
- Each conversation started there gets a folder of its own inside the drafts,
  named after the local day and the first words of its title:
  `2026-09-23 Plan the trip to Lisbon`. A second one with the same name on the
  same day becomes `2026-09-23 Plan the trip to Lisbon 2`. The agent runs in that
  folder, so what it writes stays with the conversation. The folder is never
  renamed, even when the title changes later.
- A name keeps only what a Windows folder can hold: `<>:"/\|?*` and control
  characters become spaces, the first six words are kept, cut at 60 characters.
  The date comes first, so a title can never make a reserved name like `CON`.
- The drafts folder is not a git repository. The worktree switch is hidden
  there, and `threads.create` with `worktree` on the drafts project is refused
  by name.

## Finding Documents

| Machine | Folder |
| --- | --- |
| Windows | What `SHGetKnownFolderPath(FOLDERID_Documents)` answers, so a folder moved by OneDrive or by hand is followed. It costs 3 ms on first use (2026-09-23). |
| Linux | `XDG_DOCUMENTS_DIR` from `~/.config/user-dirs.dirs`, `$HOME` expanded; a value equal to the home means the desktop turned it off. |
| macOS, or anything unreadable | `~/Documents`. |

`BOITE_DRAFTS_DIR` replaces the whole path. The test harness and the e2e cores
set it inside their temporary data directory, so no test writes to a real
Documents folder.

## In the app

- The drafts show as `Drafts` in English and `Brouillons` in French, whatever
  name the core stored. `Project.kind` is `drafts` on that one project, read
  from the path on every answer.
- The draft heading's project menu lists the drafts first, made or not, then
  the projects, then `Open a folder` for the owner. Under the composer,
  `Work in a folder of mine` opens the same folder dialog.
- A paired phone may start a draft: `projects.drafts` is on the device list,
  since the core picks the folder and the device names no path.

## Incognito

A conversation that should leave nothing behind starts incognito: the owner
turns on `Incognito` at the right of the draft's header before the first send.
The switch is offered in the drafts only, and a draft taken to a project leaves
it behind.

- `threads.create` with `incognito: true` gives the thread a folder of the
  core's data directory, `incognito/<thread id>`, instead of a dated folder in
  Documents. It is refused on any other project, with `cwd` or `worktree`, and
  from a paired device, which could never erase it: `threads.remove` is the
  owner's.
- The thread carries `incognito: true`. The sidebar, the command palette and
  the phone's lists leave it out, and the device's unsent-text journal keeps
  nothing typed into it or into its draft.
- Leaving it erases it. Opening another thread or a new draft, archiving it or
  deleting it makes the client call `threads.remove`, and the core deletes its
  history, events included, and its folder at once. `thread.removed` says
  `undoable: false`, and the deleted list never shows it.
- A core that stops, or starts after a crash, erases every incognito
  conversation it still holds and the whole `incognito` folder.
- Forking or moving one is refused: either would keep a copy.

What the agent's own CLI writes outside that folder, such as its session
transcripts in its home directory, is out of Boite's reach and stays.
