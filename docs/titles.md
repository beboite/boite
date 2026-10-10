# Titles

`titleSource` records who named a thread: `prompt` for the first user line,
`agent` for generated text, or `user` for a manual rename. Automatic naming
can replace the prompt title during the first turn. It preserves manual names.

## Where each title comes from

- A thread is created with the first line of its prompt, cut at sixty
  characters on a word, and `titleSource: 'prompt'`. A thread with no prompt
  yet keeps the title the client sent.
- When the first user turn starts, the core asks a driver with a `title` hook
  for a title in parallel with the main agent (see
  [which model writes it](#which-model-writes-it)). The prompt asks for 2 to
  6 words, under forty characters, so the title fits one
  sidebar line. The echo driver answers with `Echo:` and the first five words
  of the prompt, its directives cut. The Claude driver sends one short call,
  one turn, no tools, no session written. The Codex driver starts its own
  app-server for an ephemeral thread, read-only sandbox, no approvals, `low`
  effort, and closes it after the answer; the thread's warm session is left
  alone. Each attempt takes thirty seconds at most and is spawned under the thread so
  the trace carries them. The request includes the first message and its
  images when the title provider supports images. The model returns JSON
  with `title` and `needsRefinement`, plus an English `branch` slug when an
  automatically named worktree is pending; plain titles from older hooks still
  work and need no refinement. The title is cleaned (the first line, a `Title:`
  prefix, quotes, backticks, a trailing period, cut at sixty characters on a
  word) and saved with `titleSource: 'agent'`. A failed or empty call gets two
  retries, after two and four seconds. Exhausted retries write one warning on
  `core.log` and retain the current title.
- The model asks for refinement only when the subject is still unknown: an
  unresolved link, an unexplained image, or a request such as "fix this".
  After the first turn ends `done`, a second call can resolve that subject
  from the first request and all assistant text in that turn. Clear requests
  use one title call. If the response finishes before initial naming, the core
  waits for that decision, then refines if needed. Later user turns do not
  trigger automatic naming or refinement.
- `titleState` stores the revision and pending refinement decision in the
  journal. A restart resumes pending refinement on completed, idle threads.
  `threads.update` with a `title` saves it with `titleSource: 'user'`, advances
  the revision and clears refinement. An in-flight call cannot overwrite a
  newer rename, even when the user types the same name or changes it back.

Drivers without a `title` hook (Muse Code, OpenCode, Antigravity, the
Antigravity CLI, Grok, pi today) keep the prompt's title when Automatic is
chosen, so their threads read as they always did. `ProviderSummary.titles`
says which providers have the hook.

## Which model writes it

Settings, General, Conversations, `Title model` stores `settings.titleModel`,
a provider and a model, or `null` for Automatic.

- Automatic: the thread's own provider and account, on its small model
  (`packages/contracts/src/title-models.ts`). Each provider names model
  families, not ids: the newest Haiku the Claude account lists, the newest Luna
  for Codex, then the newest `-mini` when it lists no Luna. Newest compares the
  version numbers in the id, a release date left out, so `claude-haiku-5-5`
  wins over `claude-haiku-4-5-20251001` and `gpt-6-luna` over `gpt-5.6-luna`.
  An account that lists none of the family is asked for the fallback:
  Claude's `haiku` alias, which its CLI resolves to its newest Haiku, and
  `gpt-6-luna` for Codex.
- A pick: every title goes to that model, on the thread's own account when
  the thread uses the same provider, else on that provider's first account
  signed in. A pick whose provider is gone, not installed or signed out falls
  back to Automatic for that title.
- Neither: a thread whose provider is not installed, or whose provider has
  every account signed out, starts no title call and keeps the prompt's title.
  A thread whose own account signed out writes on the account its next turn
  would use ([accounts.md](accounts.md#a-conversation-follows-its-agent)).

`settings.update` refuses a `titleModel` whose provider is not loaded or has
no `title` hook, and a blank or over 200 characters model. The menu lists
each provider with the hook, installed and signed in, its small model first,
from the models already probed: opening Settings starts no agent.

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
It also generates the initial title during the first turn and protects newer
manual renames with the same revision check.

The initial call reads only the first user message. Refinement and explicit
regeneration read that first turn's assistant text, stopping at the next user
message. The model is asked to keep the user's subject and desired outcome,
using assistant findings only to resolve an unnamed subject. It does not
decode the remaining history to name the conversation.
`bun run bench/retitle.ts` measures this path on a temporary core with
5,000 messages and the offline echo driver.

## Worktree branches

New automatic worktrees start on `boite/wt-<8 characters>`. The title writer
also returns a short English branch name in the same call, using the selected
title model. Naming happens while the first turn runs and keeps the checkout
path, files, commits and provider session unchanged. Explicit branch names,
branches already renamed in Git, and branches with an upstream or known remote
ref are preserved. Collisions receive a numeric suffix. Invalid branch output
leaves the temporary branch usable; explicit title regeneration can retry it.
The pending naming flag survives a core restart.

Boite-created branch names are at most 48 characters, including their prefix
and collision suffix. Longer explicit names are refused before a thread or
worktree is created. Generated names shorten their slug to leave room for the
suffix. Existing Git branches remain usable, including recovery of a worktree
whose directory disappeared. The header, Changes panel, sidebar and phone
conversation list truncate long names in the available space and keep the full
name in the tooltip.
