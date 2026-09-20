# Importing a session

A conversation started in Claude Code's own terminal can become a Boite
thread: its history is read from the transcript the CLI kept, and the thread
carries the CLI's session id, so the next turn resumes it.

## Where the sessions come from

Claude Code writes one file per session under its config directory:
`<config dir>/projects/<folder>/<session id>.jsonl`, where `<folder>` is the
working directory with every character outside `A-Za-z0-9` replaced by `-`
(`D:\Dev\Collab\boite` becomes `D--Dev-Collab-boite`). The config directory is
the account's: its isolation directory for an isolated account, `~/.claude`
(or `CLAUDE_CONFIG_DIR`) for the default login ([accounts.md](accounts.md)).

`imports.list` takes a project and walks that folder for every Claude account,
newest file first. Each entry names the account, the session id, the file, its
size and last write, the time of the first prompt, the title, and the thread
that already carries the session if one does. A file with no prompt is left
out, and one whose first prompt was recorded in another directory is skipped
with a line on the log. The listing parses the first prompt and the title
records only, so a folder of long sessions answers in well under a second.

Only Claude Code keeps transcripts Boite reads today. OpenCode, Codex, pi,
Antigravity, Grok and Muse Code have their own stores; none is read yet.

## What is imported

`imports.run` reads the whole file and writes one thread in one transaction,
so no client ever sees it empty:

- one finished turn per prompt, timed on the transcript's own timestamps, with
  the user's text and images;
- one assistant message per turn holding, in order, the reasoning (`thinking`
  parts), the tool calls (`tool` parts with the input, the result the CLI
  recorded, `done` or `error` as the CLI marked it, the output cut at 20 KB)
  and the text, consecutive text blocks joined;
- subagent conversations (the `isSidechain` records) left out;
- a call the transcript never answered closed as an error, "no result in the
  transcript";
- the title: the CLI's own (`ai-title` or `summary` record, source `agent`)
  when it wrote one, the first line of the first prompt otherwise (source
  `prompt`, [titles.md](titles.md));
- the model the last answer names when the provider lists it, the default
  otherwise;
- `sessionId` set, so the first turn started on the thread passes `resume` to
  the CLI and the conversation goes on where the terminal left it.

Usage is not recovered: the turns carry none, and the Usage page counts only
what Boite ran itself.

## From the UI

The import is an experiment: it shows once `Claude Code session import` is on
in Settings, Experiments, a switch kept per machine in the browser's
`localStorage` ([the Experiments page](../packages/ui/src/lib/experiments.ts)
lists the ids). With it off, the menu has no row, the palette no command, and
the `import-session` chord does nothing.

`Import a Claude Code session` sits in a project's menu (right click, or the
dots beside its name) and in the palette, where it takes the open thread's
project, else the draft's, else the first one. The dialog lists the sessions
with the account and the time of the last write; a session already imported
is greyed with `Imported`; picking one imports it and opens the thread. The
`import-session` command has no default chord ([keybindings.md](keybindings.md)).

## What is refused, by name

- the account's agent is not Claude;
- the session id carries anything but letters, digits, dashes and underscores;
- no file at the path the folder rule gives, which the error prints;
- the file has no prompt;
- the session is already a thread, which the error names.

## Proof

`packages/core/test/imports.test.ts` files a fixture transcript under an
isolated account and checks the listing, the import, the second attempt and
each refusal. The browser e2e does the same from the project menu on the real
core. `claude.live.test.ts`, behind `BOITE_E2E_CLAUDE=1`, runs one real turn,
removes the project so the session is free, imports it from the user's own
`~/.claude/projects` and resumes it: the agent repeats the word it said.
