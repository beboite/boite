# Keybindings

The UI defines default shortcuts; `<dataDir>/keybindings.json` stores overrides.
The core reads the file at startup and watches for changes, publishing them
through `keybindings.get` and `keybindings.updated`. Clients update keyboard
handling, palette hints, tooltips and the Keyboard settings page together.

## From Settings

The Keyboard page groups the commands (General, Side panel, Thread and
composer, Terminal, Theme) under a search field that matches a label, an id or a chord.
Clicking a chord starts recording: hold the modifiers, press the key, and the
row saves on the key press. Escape alone cancels, as does leaving the window.
A chord with no modifier is refused on the row. A chord another command
already has asks first, and "Move it here" takes it from that command. The row's
reset button returns one command to its default and its clear button leaves it
with no key; Reset all removes every known entry.

Every change goes through the core: `keybindings.set` writes one entry and
`keybindings.reset` removes one entry, or every known one. The file is deleted
only when nothing is left in it, so a file holding an unknown key survives a
Reset all. Other entries stay as written, unknown ones included, so the page and a text
editor edit the same file. The core writes a temporary file and renames it
over, reads it back at once, and announces the table like any other change. A
file that is not JSON is refused rather than overwritten, with its path, and
the page shows that message on the row.

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

The core watches the directory and reads the file 120 milliseconds after the
last write, including saves that rename a temporary file. It publishes the
whole table without a restart or reload.

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
| `palette` | `mod+k` | The command palette, also the command button at the foot of the sidebar |
| `sidebar` | `mod+s` | Fold or unfold the thread sidebar |
| `panel` | `mod+alt+b` | The right panel, on an open thread |
| `browser` | `mod+shift+j` | The browser surface, in the shell |
| `changes` | `mod+shift+c` | The changes surface, the working tree of the thread |
| `files` | `mod+shift+f` | The files surface, the tree of the working directory |
| `tasks` | `mod+shift+k` | The tasks surface, the agent's list and the project's |
| `terminal` | `mod+j` | The thread's shells under the chat ([terminal.md](terminal.md)) |
| `terminal-new` | `mod+n` | In a terminal: a shell in a new tab |
| `terminal-split` | `mod+d` | In a terminal: a shell beside the active one |
| `terminal-split-vertical` | `mod+shift+d` | In a terminal: a shell under the active one |
| `terminal-close` | `mod+w` | In a terminal: end the active shell |
| `close-surface` | `mod+w` | The active surface of the panel, never the window |
| `settings` | `mod+,` | Settings |
| `stash` | `mod+shift+s` | Put the composer text aside, or take it back |
| `send-and-draft` | `mod+enter` | Send, then a fresh draft on the same choice |
| `add-project` | none | The folder dialog in the shell, General in a browser |
| `pin` | none | Pin or unpin the open thread |
| `rename` | none | Rename the open thread |
| `retitle` | none | Ask the agent for the open thread's title again ([titles.md](titles.md)) |
| `import-session` | none | Import a Claude Code session into the open thread's project, once that experiment is on ([imports.md](imports.md)) |
| `trace` | none | The trace surface |
| `appearance` | none | The Appearance tab |
| `providers` | none | The Providers tab |
| `pair` | none | General, where a phone pairs |
| `theme-dark`, `theme-light`, `theme-system` | none | The theme |
| `archive` | none | Archive the open thread |
| `reopen-thread` | `mod+shift+t` | Restore the thread archived last and open it: those archived in this window first, newest first, then the machine's most recent one |
| `copy-answer` | `mod+alt+c` | Copy the open thread's last answer |
| `find` | `mod+f` | Search the open thread; Enter and Shift+Enter walk the matches, Escape closes |
| `thread-1` to `thread-9` | `alt+1` to `alt+9` | Open the thread in that row of the sidebar, counted from the top of what it shows |

A digit chord matches the physical key too, so `alt+3` fires on a layout
where the top row types another character without Shift. In a plain browser
tab, the browser keeps `Ctrl+Shift+T` for itself; the shell and the palette
always reach it.

The four `terminal-` commands are T3 Code's and act only while a terminal
screen has the keyboard. There they come before every other command, so
`mod+n` opens a shell rather than a draft and `mod+w` closes the shell rather
than the panel's surface; anywhere else those chords keep their app meaning.
On the Keyboard page they conflict only with each other and with `terminal`,
which also works from a terminal. A
full-screen program, in the terminal's alternate screen, still receives its
Ctrl-letter keys ([terminal.md](terminal.md#keys)).

While a writable file editor has focus, `mod+s` saves its file. Elsewhere it toggles
the thread sidebar and keeps the browser's save dialog closed. The panel button's
tooltip shows its current chord, including any custom binding.

`Ctrl+Q` in the shell, the quit hold, is not in the table and cannot move.
Neither can the shell's zoom, `Ctrl+=`, `Ctrl+-` and `Ctrl+0` (`+` and `-` of
the keypad and of any layout included), which follow the browser's own keys
([development.md](development.md#faces-and-zoom)).

## What is refused

Invalid entries appear in `errors`, on the Keyboard page under "Refused", and
in `core.log` at `warn`. Valid entries still apply. The core refuses:

- an id that is not in the table above;
- a value that is neither a string nor `null`;
- a chord the grammar refuses, with the reason (`"b" has no modifier`,
  `"mod+" names no key`, `"mod+banana" has an unknown key`).

A file that is not JSON, or is JSON but not an object, is one error and no
binding at all: the defaults stand until it is fixed. A file that does not
exist is no binding and no error.
