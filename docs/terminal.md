# The thread terminal

Each thread has a shell under the chat, opened in the thread's working
directory. `Ctrl+J` (the `terminal` command, [keybindings.md](keybindings.md))
shows and hides it, and so does the terminal button in the thread header. The
top edge of the drawer sets its height, which the browser keeps per device. The
cross ends the shell; hiding the drawer does not.

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
- `terminals.close` kills the shell with everything it started and waits for
  it to exit. `terminal.exited` follows, and the drawer closes.
- Archiving the thread and stopping the core close its shell too.

The shell runs under the trace id `terminal:<threadId>`, apart from the
thread's own processes. Stopping a turn ends what the agent started and leaves
the user's shell alone. Like every process, it goes through `procs` into a Job
Object and the trace ([trace.md](trace.md)).

The shell is PowerShell 7 when `pwsh.exe` is on the `PATH`, else Windows
PowerShell, else `cmd.exe`. On Linux and macOS it is `$SHELL`, then `/bin/bash`,
then `/bin/sh`. `BOITE_TERMINAL_SHELL`, set in the core's environment, names
another one; the core tests set it to `cmd.exe` or `/bin/sh`, so nothing they
type lands in the user's PowerShell or bash history.

## Who may open one

The terminal methods are owner-only. A paired phone has no terminal button and
the core refuses its calls, since a shell on the machine is more than the thread
permissions a device holds ([phone.md](phone.md)).

## Signing in from a terminal

A provider whose login command is an interactive menu signs in through the same
shell. [accounts.md](accounts.md#signing-in-from-a-terminal) has that flow.
