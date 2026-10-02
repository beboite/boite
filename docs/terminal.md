# The thread terminal

Each thread has a shell under the chat, opened in the thread's working
directory. `Ctrl+J` (the `terminal` command, [keybindings.md](keybindings.md))
shows and hides it at any time. The terminal button in the thread header does
the same unless Settings, Appearance, Buttons hides it. The top edge of the
drawer sets its height, which the browser keeps per device. The cross ends the
shell; hiding the drawer does not.

## Where the shell runs

The shell is a process of the core, in a pseudo-terminal from Bun's
`Bun.spawn({ terminal })` (ConPTY on Windows), and the UI draws it with
xterm.js. xterm loads the first time a terminal opens, never at startup.

- `terminals.open` starts the thread's shell at the client's size, or attaches
  to the one already running and resizes it. The answer carries the last
  256 KiB of output, so a reload or a second window redraws the screen.
- What the shell prints arrives as `terminal.output`, what the user types goes
  back through `terminals.write`, and `terminals.resize` follows the drawer.
  The first output after a quiet moment goes out at once, so a typed key echoes
  without delay; output that keeps coming is sent every 16 ms as one event.
  The 256 KiB snapshot is exactly what those events carried so far.
- `terminals.close` stops the shell and waits for it to exit.
  `terminal.exited` follows, and the drawer closes. Descendant termination
  follows the platform limits below.
- Archiving the thread and stopping the core close its shell too.

The shell runs under the trace id `terminal:<threadId>`, apart from the
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

The owning Store keeps the xterm screen in `lib/terminal-session.svelte.ts` until
the shell ends. Hiding the drawer or switching threads detaches its element;
reopening reuses the screen, scrollback, selection and full-screen program state.

Reloading, opening another window or reconnecting replays the 256 KiB snapshot.
Truncation prefers a nearby line boundary. Output arriving before the response is
buffered; the snapshot sequence excludes events already represented. Older cores
without sequences can show overlap. Snapshot replay mutes xterm responses to
terminal queries so reopening cannot type them into the shell.

The screen fits each animation frame during a drag. A resize RPC follows 80 ms
after the last change. ConPTY snapshots include the Windows build number so xterm
can account for native line wrapping. ANSI colours use the theme's code background
with a 4.5:1 minimum contrast ratio, halved for dim text. The cursor is a blinking
bar. Refused keystrokes display their error. Reloading the same conversation
preserves terminal focus; switching conversation or draft focuses the composer.

## Keys

The shell receives Ctrl-letter shortcuts such as `Ctrl+K`, `Ctrl+N`, `Ctrl+S` and
`Ctrl+F`. The app retains `Ctrl+J` to hide the drawer and return focus to the
composer, plus its Shift/Alt chords and `Ctrl+,`.

On Windows and Linux, `Ctrl+C` copies selected text or interrupts when there is no
selection, `Ctrl+V` pastes, and `Ctrl+Backspace` deletes a word.

## Who may open one

The terminal methods are owner-only. A paired phone has no terminal button and
the core refuses its calls, since a shell on the machine is more than the thread
permissions a device holds ([phone.md](phone.md)).

## Signing in from a terminal

A provider whose login command is an interactive menu signs in through the same
shell. [accounts.md](accounts.md#signing-in-from-a-terminal) has that flow.
