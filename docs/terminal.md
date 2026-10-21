# The thread terminal

Each thread has shells under the chat, opened in the thread's working
directory. `Ctrl+J` (the `terminal` command, [keybindings.md](keybindings.md))
shows and hides the drawer at any time. The terminal button in the thread header
does the same unless Settings, Appearance, Buttons hides it. The top edge of the
drawer sets its height, which the browser keeps per device. The cross ends the
shell that has the keyboard, a tab's cross every shell of the tab; hiding the
drawer ends none. With the Reviewed goals experiment on, the project board
shares the drawer: its first tabs switch between Board and Terminal, and
`Ctrl+J` opens the tab picked last ([board.md](board.md)).

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
- What the shell prints arrives as `terminal.output`, only on the connections
  that attached that shell; its `terminal.exited` reaches every owner window,
  so one that lays the pane out without having attached it drops it. What the
  user types goes back through `terminals.write`, and `terminals.resize`
  follows the drawer.
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
  `terminal.exited` follows, and the drawer closes. On Linux the core first
  signals the shell's descendants, checked by birth time, because a job started
  in the background has its own process group and outlives the shell's hang-up.
  Other descendant termination follows the platform limits below.
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

## Shell integration

A thread's bash and PowerShell start with a few lines from
`packages/core/src/terminal-integration.ts`, the way VS Code and Windows
Terminal mark a shell. Nothing is written into the user's files:

- bash runs `--rcfile <dataDir>/shell-integration/boite.bash -i`. That file
  sources `~/.bashrc` first (Debian's `/etc/bash.bashrc` still loads before
  it), then wraps `PROMPT_COMMAND`, `PS1` and `PS0`. It also turns on
  `histappend` and runs `history -a` at each prompt, so every command reaches
  `~/.bash_history` as it runs and a second shell's up arrow finds it.
- PowerShell 7 and Windows PowerShell get the script as `-NoExit
  -EncodedCommand` after their profile, which no execution policy blocks. It
  wraps `prompt`, whatever the profile set (oh-my-posh, starship), and
  PSReadLine's `PSConsoleHostReadLine`.

Each prompt then prints OSC 133 `A` where it starts and `B` where the input
starts, `C` when a command runs and `D;<status>` when it ends; OSC 633
`P;Cwd=<path>` reports the directory and, once, `P;HistoryFile=<path>` the
history file. An empty line ends no command. cmd, sh, zsh, fish and a login
bash (macOS's, which skips `--rcfile`) start as they are, and
`BOITE_TERMINAL_INTEGRATION=0` turns the integration off. `TerminalState.shell`
names the shell and says whether it is integrated.

`terminals.history` reads the end of that history file (512 KiB), else the
shell's default one (`HISTFILE` or `~/.bash_history`; PSReadLine's
`ConsoleHost_history.txt`), and returns up to 500 commands, newest first and
each once. PSReadLine's backtick continuations join into one command, bash's
`#<seconds>` timestamp lines are skipped. A shell without a history file gets
an empty list. PSReadLine takes its path from the profile folder and ignores
`APPDATA`; `BOITE_TERMINAL_HISTORY` gives the integrated PowerShell another
file, and the core tests use it with `HISTFILE` to stay out of the user's.

## The screen

The owning Store keeps each xterm screen in `lib/terminal-session.svelte.ts` until
the shell ends.

It draws on the GPU with xterm's WebGL renderer, loaded with the screen. A
browser that refuses a WebGL context, or loses it, falls back to the DOM
renderer for that screen and asks for no other. Settings, Appearance, "Draw
terminals on the GPU" turns it off per device for the screens opened next. The
cursor blink then comes from xterm's own timer rather than a CSS animation.
Unicode 11 widths keep emoji and East Asian text at the two cells the shell
counts. The end-to-end pages run the DOM renderer, whose rows they read, unless
a test asks for `terminalGpu`. Hiding the drawer or switching threads detaches its element;
reopening reuses the screen, scrollback, selection and full-screen program state.
A detached screen gives its WebGL context back at once (Chromium keeps sixteen
at most): xterm's addon only removes its canvas, so the screen loses the
context itself through `WEBGL_lose_context`. It takes a new one when it shows
again, which draws it once. After
five minutes detached (`HIDDEN_RELEASE_MS`) the whole xterm goes and the shell
keeps running; shown again, the screen is drawn from the core's snapshot, so its
scrollback is the snapshot's 256 KiB rather than 10,000 lines, and its selection
and find matches start over. The shell's exit is still heard while released.
Its status and directory never come from xterm: for the session's whole life,
`ShellStatusReader` (`terminal-status.ts`) reads the OSC 133, 633, 7 and 9;9
sequences from the raw output with `OscScanner` (`terminal-marks.ts`), ending
each where xterm.js 6 does, so a hidden tab's dot turns red or stops spinning
when its command ends. The status starts from the first snapshot, and again
after the socket dropped, on a parser of its own: until that snapshot lands,
the output waits, up to the 256 Ki characters a snapshot holds, and the seed
parses what is newer than the snapshot as its continuation, so a sequence the
snapshot leaves open still ends. Output that leaves that buffer is kept as
what it changes: the phase it leads to from each phase it could start from,
the last command's status and the newest directory, each with its sequence.
It also keeps how it starts, as the rest of a sequence: the characters
`OscScanner` counts there (C0 controls are dropped uncounted) up to the first
that ends it, at most `MAX_OSC` + 2, and its first raw character, which
decides whether a snapshot ending on a bare ESC opens a sequence. When all of it follows the snapshot and
the snapshot leaves a sequence open, they end that sequence on the snapshot's
parser before the summary applies. After the seed each event is read as it arrives, once. xterm parses later than
the output arrives, so a mark it had only queued when the tab was released
still counts; its own handlers draw the dots on the lines and nothing else.

Reloading, opening another window or reconnecting replays the 256 KiB snapshot.
Truncation prefers a nearby line boundary. Output arriving before the response is
buffered; the snapshot sequence excludes events already represented. Older cores
without sequences can show overlap. Snapshot replay mutes xterm responses to
terminal queries so reopening cannot type them into the shell; keys typed during
the replay, or while a new split attaches, reach the shell once it is drawn.
The local attachment records where replay ends. Buffered live output follows it
with responses enabled, so a cursor query arriving while the opening response
travels back still gets its answer rather than leaving PowerShell waiting.

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

With the shell integration, each command gets a dot in the margin left of its
prompt, green when it ended with status 0, red otherwise (its tooltip says the
code) and the accent, breathing, while it runs; the same colours tick the
scrollbar. The header names the shell and follows its directory, a tab is
named after the directory of its shells, and a dot after the name breathes
while a command runs or turns red once the last one failed. The screen also
reads OSC 7 `file://` reports and Windows Terminal's OSC 9;9, so a zsh or fish
that sends them updates the directory too.

The magnifier, or `Ctrl+Shift+F`, opens a find bar over the screen: matches are
highlighted as the query is typed, on the screen and down the scrollbar, and
Enter steps up the scrollback (Shift+Enter down). The clock, or
`Ctrl+Shift+H`, opens the shell's recent commands (`terminals.history`) with a
search that keeps every word in any order. Enter replaces what is typed at the
prompt with the command and runs it, Shift+Enter leaves it there to edit. The
line is emptied first with End and Ctrl+Home in PSReadLine on Windows, Ctrl+E
and Ctrl+U in readline and PSReadLine's Emacs mode, Escape in cmd. The command
goes in as a paste, bracketed when the shell asked for it. In the alternate
screen the list types nothing. `Ctrl+Up` and `Ctrl+Down` scroll to the
previous and next prompt.

A right click copies the selection, or pastes when nothing is selected, as in
Windows Terminal; Shift+right click keeps the browser's menu. Alt+click moves
the prompt's cursor to the pointer.

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
the shell prompt, so `Ctrl+D` does not end it; `exit` does. `Ctrl+Shift+F`
finds, `Ctrl+Shift+H` lists the recent commands, `Ctrl+Up` and `Ctrl+Down`
jump between commands and reach the shell when it marks none. The up arrow and
`Ctrl+R` stay the shell's own history. A full-screen program, in the alternate
screen, still receives its Ctrl-letter keys. Settings, Keyboard rebinds or
clears the eight under Terminal ([keybindings.md](keybindings.md#the-commands)).

On Windows and Linux, `Ctrl+C` copies selected text or interrupts when there is no
selection, `Ctrl+V` pastes, and `Ctrl+Backspace` deletes a word.

## Who may open one

The terminal methods are owner-only. A paired phone has no terminal button and
the core refuses its calls, since a shell on the machine is more than the thread
permissions a device holds ([phone.md](phone.md)).

## Signing in from a terminal

A provider whose login command is an interactive menu signs in through the same
shell. [accounts.md](accounts.md#signing-in-from-a-terminal) has that flow.
