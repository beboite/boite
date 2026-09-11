# Keybindings

Every chord Boite answers to is one row of a table, and the table has two
layers: the defaults, which live in the UI, and `keybindings.json` in the
core's data directory, which only says what differs. The core reads the file
at start and again the moment it changes, hands the result to every client
through `keybindings.get` and `keybindings.updated`, and the UI applies it
everywhere at once: the key handler, the palette hints, the tooltips, and the
Keyboard page in Settings, which lists the whole table and where the file is.

## The file

`<dataDir>/keybindings.json`, beside `journal.db` ([development.md](development.md)
says where the data directory is). A JSON object of command ids to chords,
or to `null` to take a key away:

```json
{
  "new-thread": "mod+shift+n",
  "palette": "mod+p",
  "sidebar": null
}
```

Save it and the change is live. There is no restart, no reload, no button:
the core watches the directory and reads the file again about a hundred
milliseconds after the last write, then announces the whole table. An editor
that saves by writing a temporary file and renaming it is read the same way.

## The chords

A chord is modifiers, then one key, joined with `+`, case and spaces ignored.

- Modifiers: `mod`, `ctrl`, `alt`, `shift`, `meta`. `mod` is Ctrl on Windows
  and Linux and Cmd on macOS, and is what the defaults use. `cmd`, `command`,
  `option`, `control` and `win` are read as their platform name.
- Keys: a single character (`k`, `,`, `/`), or a name: `enter`, `escape`,
  `tab`, `space`, `backspace`, `delete`, `insert`, `home`, `end`, `pageup`,
  `pagedown`, `up`, `down`, `left`, `right`, `f1` to `f24`. `comma`, `period`,
  `slash`, `minus`, `equal` and `plus` name their character; `mod++` is Mod
  and the plus key.
- A chord needs `mod`, `ctrl`, `alt` or `meta` unless its key is a function
  key. A bare letter, or Shift alone, is typing and is refused.
- A chord matches its exact modifiers: `mod+b` does not fire on Ctrl+Alt+B.
  Two commands on the same chord both fire; keep them apart.

## The commands

| Id | Default | What it does |
|---|---|---|
| `new-thread` | `mod+n` | A draft in the open project |
| `palette` | `mod+k` | The command palette |
| `sidebar` | `mod+b` | Fold or unfold the sidebar |
| `panel` | `mod+alt+b` | The right panel, on an open thread |
| `browser` | `mod+shift+j` | The browser surface, in the shell |
| `close-surface` | `mod+w` | The active surface of the panel, never the window |
| `settings` | `mod+,` | Settings |
| `stash` | `mod+s` | Put the composer text aside, or take it back |
| `send-and-draft` | `mod+enter` | Send, then a fresh draft on the same choice |
| `add-project` | none | The folder dialog in the shell, General in a browser |
| `pin` | none | Pin or unpin the open thread |
| `rename` | none | Rename the open thread |
| `retitle` | none | Ask the agent for the open thread's title again ([titles.md](titles.md)) |
| `import-session` | none | Import a Claude Code session into the open thread's project ([imports.md](imports.md)) |
| `trace` | none | The trace surface |
| `appearance` | none | The Appearance tab |
| `providers` | none | The Providers tab |
| `pair` | none | General, where a phone pairs |
| `theme-dark`, `theme-light`, `theme-system` | none | The theme |
| `archive` | none | Archive the open thread |

`Ctrl+Q` in the shell, the quit hold, is not in the table and cannot move.

## What is refused

Nothing is dropped in silence. Each entry the core cannot take is one line
in `errors`, named on the Keyboard page under "Refused" and on `core.log` at
`warn`, while every other entry of the file applies:

- an id that is not in the table above;
- a value that is neither a string nor `null`;
- a chord the grammar refuses, with the reason (`"b" has no modifier`,
  `"mod+" names no key`, `"mod+banana" has an unknown key`).

A file that is not JSON, or is JSON but not an object, is one error and no
binding at all: the defaults stand until it is fixed. A file that does not
exist is no binding and no error.
