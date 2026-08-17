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

## Worked example: claude-account-switcher

[claude-account-switcher](https://github.com/karthiknl0/claude-account-switcher)
rotates several Claude Code accounts and prints one segment into Claude Code's
status line: which account is answering, how many of the saved ones are still
under their limit, and how long until the next one comes back.

```
⇄ alaric · 2/3 free ⏳4h20 pierre
```

It reads its width from `CLAUDE_CC_STATUSLINE_WIDTH`, then `COLUMNS`, then
`~/.claude-cc-accounts/.statusline.json` — the third being the one that works
in a Boite pane, since the first two need a host that can set environment
variables per pane:

```json
{ "width": 60, "ascii": false }
```

With a width known it drops, in order, the handle of the returning account, then
the handle of the current one, keeping the counts and the timer — the part that
decides whether you switch — down to about 24 columns. `CLAUDE_CC_STATUSLINE_ASCII=1`
swaps `⇄` and `⏳` for `<>` and `~`, and `CLAUDE_CC_STATUSLINE=0` hides the
segment without touching a status line it wraps.

A shell function or wrapper that launches `claude` from a Boite thread can also
export the width itself, since at that point the pane's size is the tty's:

```bash
export COLUMNS=$(tput cols)
```

That is a snapshot, not a subscription: it stays right until the pane is
resized, which is why the settings file is the better of the two here.
