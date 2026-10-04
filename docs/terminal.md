# The thread terminal

Each thread has shells under the chat, opened in the thread's working
directory. `Ctrl+J` (the `terminal` command, [keybindings.md](keybindings.md))
shows and hides the drawer at any time. The terminal button in the thread header
does the same unless Settings, Appearance, Buttons hides it. The top edge of the
drawer sets its height, which the browser keeps per device. The cross ends the
shell that has the keyboard, a tab's cross every shell of the tab; hiding the
drawer ends none.

## Tabs and splits

As in T3 Code, the drawer holds tabs in the order they were opened, and a tab is
one shell or a split of up to four. The plus opens a shell in a new tab, the two
split buttons put one beside the active shell or under it, and the line between
two panes resizes them. A thread runs at most 16 shells. Tabs have no names of
their own: `Terminal 1`, `Terminal 2 | 3`. When the shell with the keyboard ends,
the keyboard goes to its neighbour, and the drawer closes with the last one.

Where the shells sit (tabs, splits, shares and the active pane) is kept per
device in localStorage, keyed by the core's data directory and the thread on its
machine. On a reload, a reconnection or a new window, `terminals.list` says
which shells still run: the layout drops those that ended and adds a tab for any
it did not know, and each screen redraws from its snapshot. A new shell takes
the lowest number no running shell holds, so two windows never share one by
mistake. A thread that had
the single shell of earlier versions finds it as its first tab.

On a phone (720 px wide or less) a split is never drawn: each shell is a tab of
its own, and the desktop split comes back on a wider screen.

## Where the shell runs

The shell is a process of the core, in a pseudo-terminal from Bun's
`Bun.spawn({ terminal })` (ConPTY on Windows), and the UI draws it with
xterm.js. xterm loads the first time a terminal opens, never at startup.

- `terminals.open` starts a shell of the thread at the client's size, or attaches
  to the one already running and resizes it. The answer carries the last
  256 KiB of output, so a reload or a second window redraws the screen.
- What the shell prints arrives as `terminal.output`, what the user types goes
  back through `terminals.write`, and `terminals.resize` follows the drawer.
  The first output after a quiet moment goes out at once, so a typed key echoes
  without delay; output that keeps coming is sent every 16 ms as one event.
  The 256 KiB snapshot is exactly what those events carried so far.
- `terminals.open` names the shell by an optional `terminalId`, `term-2` to
  `term-16`, and refuses any other; without it, it opens the thread's first
  shell, so an older client keeps working. Its answer carries the shell's `id`
  (`terminal:<threadId>` or `terminal:<threadId>:term-N`), which `write`,
  `resize` and `close` take. `terminals.list` returns the thread's running
  shells, oldest first. A core without it runs a single shell per thread, and
  the drawer then offers no tab or split.
- `terminals.close` stops the shell and waits for it to exit.
  `terminal.exited` follows, and the drawer closes. Descendant termination
  follows the platform limits below.
- Archiving the thread and stopping the core close its shells too.

A shell runs under the trace id `terminal:<threadId>`, or
`terminal:<threadId>:term-N` for the others, apart from the
thread's own processes. Stopping a turn ends what the agent started and leaves
the user's shell alone. It launches through `procs`: Windows Job Objects track
descendants exactly, while Linux and macOS register direct children and signal
their process groups. A descendant that leaves its group can survive. See
[trace](trace.md) for tracking and shutdown limits.

The shell is PowerShell 7 when `pwsh.exe` is on the `PATH`, else Windows
PowerShell, else `cmd.exe`. On Linux and macOS it is `$SHELL`, then `/bin/bash`,
then `/bin/sh`. `BOITE_TERMINAL_SHELL`, set in the core's environment, names
another one; the core tests set it to `cmd.exe` or `/bin/sh`, so nothing they
type lands in the user's PowerShell or bash history.

## The screen

The owning Store keeps each xterm screen in `lib/terminal-session.svelte.ts` until
the shell ends. Hiding the drawer or switching threads detaches its element;
reopening reuses the screen, scrollback, selection and full-screen program state.

Reloading, opening another window or reconnecting replays the 256 KiB snapshot.
Truncation prefers a nearby line boundary. Output arriving before the response is
buffered; the snapshot sequence excludes events already represented. Older cores
without sequences can show overlap. Snapshot replay mutes xterm responses to
terminal queries so reopening cannot type them into the shell; keys typed during
the replay, or while a new split attaches, reach the shell once it is drawn.

The screen fits each animation frame during a drag. A resize RPC follows 80 ms
after the last change. ConPTY snapshots include the Windows build number so xterm
can account for native line wrapping. The program draws at exactly the columns
and rows that fit, with no scrollbar over them.

The screen looks like Windows Terminal's: Cascadia Mono, then Consolas, SF Mono
and Menlo, on the solid `--color-terminal-background` of `app.css`, edge to edge
with a few pixels of padding. The 16 ANSI colours are the `--ansi-*` tokens of
each theme; 256-colour and truecolour output draws as the program sends it, with
a 4.5:1 minimum contrast ratio, halved for dim text. The cursor blinks, an
outline when the screen has no keyboard; Settings, Appearance makes it a bar
(the default), a block or an underline, per device, and a program that asks for
a shape still gets it. URLs and OSC 8 links open in the browser on a click.
Refused keystrokes display their error. Reloading the same conversation
preserves terminal focus; switching conversation or draft focuses the composer.

Full-screen programs get the alternate screen, colours and the mouse. On
Windows the inbox ConPTY keeps a program's mouse modes to itself, so a click
never reaches vim or htop there; the alternate screen and colours do.

## Keys

The shell receives Ctrl-letter shortcuts such as `Ctrl+K`, `Ctrl+S` and `Ctrl+F`.
The app retains `Ctrl+J` to hide the drawer and return focus to the composer,
plus its Shift/Alt chords and `Ctrl+,`.

While a terminal has the keyboard, T3 Code's chords act on the drawer ahead of
the app's: `Ctrl+N` opens a shell in a new tab, `Ctrl+D` splits beside,
`Ctrl+Shift+D` splits below and `Ctrl+W` closes the shell. They no longer reach
the shell prompt, so `Ctrl+D` does not end it; `exit` does. A full-screen
program, in the alternate screen, still receives its Ctrl-letter keys. Settings,
Keyboard rebinds or clears the four under Terminal ([keybindings.md](keybindings.md#the-commands)).

On Windows and Linux, `Ctrl+C` copies selected text or interrupts when there is no
selection, `Ctrl+V` pastes, and `Ctrl+Backspace` deletes a word.

## Who may open one

The terminal methods are owner-only. A paired phone has no terminal button and
the core refuses its calls, since a shell on the machine is more than the thread
permissions a device holds ([phone.md](phone.md)).

## Signing in from a terminal

A provider whose login command is an interactive menu signs in through the same
shell. [accounts.md](accounts.md#signing-in-from-a-terminal) has that flow.
