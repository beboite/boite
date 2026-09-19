# Titles

A thread's title is one of three things, and `titleSource` on its summary says
which: `prompt`, the first line of what the user typed; `agent`, what the agent
wrote after reading the first exchange; `user`, a name the user gave. The rule
is that a name the user gave is never overwritten, and a title from the prompt
is replaced once by the agent's, right after the first finished turn.

## Where each title comes from

- A thread is created with the first line of its prompt, cut at sixty
  characters on a word, and `titleSource: 'prompt'`. A thread with no prompt
  yet keeps the title the client sent.
- When the first turn ends `done`, the core asks the thread's driver for a
  title, if the driver has a `title` hook. The echo driver answers with
  `Echo:` and the first five words of the prompt, its directives cut. The
  Claude driver sends one short call to the `haiku` alias, one turn, no tools,
  no session written, thirty seconds at most, spawned under the thread so the
  trace carries it. The answer is cleaned (the first line, a `Title:` prefix,
  quotes, backticks, a trailing period, cut at eighty characters on a word)
  and saved with `titleSource: 'agent'`. An agent that says nothing, or fails,
  is one line on `core.log` at `warn` and the prompt's title stands.
- `threads.update` with a `title` saves it with `titleSource: 'user'`. The
  agent's answer never touches it again, unless the user asks.

Drivers without a `title` hook (Codex, OpenCode, Antigravity, the Antigravity CLI, Grok, pi today)
keep the prompt's title, so their threads read as they always did.

## Asking again

`threads.retitle` runs the same call on demand, on any thread with a prompt,
whatever its source: the thread menu in the sidebar and the title menu in the
header carry `Regenerate title`, the palette has `Regenerate the title of
this thread`, and the `retitle` command in [keybindings.md](keybindings.md)
takes a chord. While the agent writes, the item reads `Writing a title` and is
disabled; a second call on the same thread is refused. A thread with no user
message yet is refused too, by name. When the agent answers nothing, the
prompt's title is saved again with `titleSource: 'prompt'`.

The fake client in `?fake=1` answers `threads.retitle` after two hundred
milliseconds with the echo rule, so the UI can be worked on without a core.
