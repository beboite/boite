# Status lines in a pane

An agent's status line is drawn by the agent, not by Boite: it is one more row
of the PTY's output. Nothing in the terminal clips it, so a line written for a
full-screen terminal wraps or scrolls the moment the pane is a split. This page
is what a status-line author needs to know to narrow instead, and one worked
example.

## What a pane tells the process

The PTY is spawned with the pane's real `cols`/`rows`, so anything that asks
the tty — `tput cols`, `ioctl(TIOCGWINSZ)`, xterm.js' own reflow — gets the
width and gets it again after a resize. `TERM=xterm-256color`,
`COLORTERM=truecolor` and `TERM_PROGRAM=boite` are exported
(`crates/boite-core/src/pty.rs`), which is how a tool recognises the terminal it
is rendering into before it changes anything.

What a pane does **not** export is `COLUMNS`. That is a shell variable, not an
environment one, in bash and zsh alike, and a status-line hook is usually not a
child of the interactive shell anyway. So a helper that renders one line and
exits, with its stdout on a pipe rather than on the tty, has no width to read:
`process.stdout.columns` is `undefined`, `isatty(1)` is false, and the payload
the agent hands it carries no geometry either. Claude Code's status-line JSON is
one such payload.

Three ways out, in the order they are worth trying:

1. Ask the tty rather than the pipe. A helper that can open `/dev/tty` (or
   `CONOUT$` on Windows) reads the same winsize the pane resizes.
2. Let the user state the width once, through a setting or an environment
   variable of the tool's own. This is the one that works on every host,
   including remote and mobile boites where the helper runs on the server.
3. Degrade by content, not by truncation. Drop the parts that are decoration
   before the parts that carry a decision, and measure in display columns:
   a `slice()` on a JS string splits surrogate pairs and counts a CJK handle or
   an emoji as one cell when the terminal gives it two.

Unicode is safe to use — the pane is xterm.js with a UTF-8 PTY — but an ASCII
fallback still earns its keep for `TERM=dumb` captures and for transcripts read
outside a terminal. `NO_COLOR` is worth honouring for the same reason.

## Worked example: the account switcher

The switcher vendored under
[`plugins/kebacc-switch`](../plugins/kebacc-switch) keeps
several Claude Code and Codex logins on one machine and swaps between them when
one runs out of quota. Its status line
(`src/kebacc-switch-statusline.js`) is a reference consumer of the contract above:
Claude Code hands it the session payload on stdin, it prints one line, and it
never asks the network — the live window comes from the payload and everything
about the other accounts comes from the cache the switcher already wrote.

```
alaric · 5h 42% / 7d 12% · 1 free
```

`KEBACC_SWITCH_STATUSLINE_ASCII=1` swaps the `·` separator for `|`, and an
environment that does not say UTF-8 gets the ASCII form without being asked.
`KEBACC_SWITCH_ACCOUNTS` moves the pool it reads.


For a day after the switcher has updated itself, the line carries one more
segment saying which version it came from: `^5.0.0->5.1.0` (`↑5.0.0→5.1.0` when
the terminal takes UTF-8). It is read from a file the update wrote next to the
binary, so this segment costs no more than the rest of the line.

It renders one width, because Claude Code owns the truncation on its own status
line. A Boite pane that wants a narrower segment is the case the pane contract
above exists for, and the renderer is deliberately the simple end of it.

The toolkit itself is PowerShell 7, installed into `~/.claude-tools` by
`install.ps1` and removed by `uninstall.ps1`, with slash commands in
`src/commands/` for add, list, switch, remove, auto-switch and doctor. Settings
carries an Accounts tab that installs it without leaving the app: the files are
bundled into the build and typed into the shell the panel spawns, so nothing is
downloaded.
