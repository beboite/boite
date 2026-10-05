# Stewards

A steward is the agent of one conversation that the owner assigns to one or
more projects, or to every project, so it looks after their threads while the
owner is away: it keeps each one moving toward a merged, verified result,
answers what they ask and tidies them up. A typical steward stays on the Boite
project overnight, checks every thread's pull request, steers what is stuck,
archives what merged and starts the nightly when main is ready.

## Granting

Open **Communication settings** of the conversation that should become the
steward and turn on **Steward**. Pick its projects or **All projects** (the
drafts project is never included), its capabilities, and whether it receives
notices. From a terminal:

```sh
boite stewards set <thread-id> boite website        # these projects
boite stewards set <thread-id> --all --can all      # every project, every capability
boite stewards set <thread-id> boite --quiet        # no notices
boite stewards                                      # every grant
boite stewards revoke <thread-id>
```

`--can` takes a comma list. Reading threads comes with any grant; the rest is
explicit:

| Capability | What it allows | Default |
| --- | --- | --- |
| `message` | Letters that reach a thread as the steward's, even when its coordination is off or paused | yes |
| `spawn` | `thread new` in its projects, without the communication-settings gates | yes |
| `archive` | Archive and unarchive | yes |
| `move` | Move threads between its projects; register a project folder, which then joins the grant | yes |
| `stop` | Stop a running turn, rename a thread | yes |
| `answer` | Answer or skip the questions agents ask the user | yes |
| `permissions` | Allow or deny tool permission requests | no |
| `remove` | Delete threads | no |

A delegated child, a workflow step, a persistent agent session and an archived
thread cannot be stewards. Archiving the steward's thread suspends its grant;
deleting it removes the grant. Revoking rejects its letters and notices that
were not delivered yet. Paired phones read the grants; only the owner sets or
revokes them.

## What the steward does

Its prompt names its projects and capabilities, and the CLI:

```
boite steward                         its own grant
boite threads [--project <p>] [--archived]
boite thread show <id>                state, questions, permissions, last answer
boite thread send <id> <text>         a letter marked as the steward's
boite thread stop|archive|unarchive|remove <id>
boite thread rename <id> <title>
boite thread move <project> <id>
boite thread new <project> <brief>
boite questions [<id>] / boite answer <id> <question-id> <option|text ...> [--skip]
boite permissions [<id>] / boite allow|deny <id> <request-id>
boite agents read <id>                the conversation itself
```

Each call carries the steward's own thread, so the access gate holds the token
to it like any agent method (`steward.*` in `packages/core/src/access.ts`).
`packages/core/src/stewards.ts` then checks the grant against the project of
the thread the call names, at the moment of the call. The steward never acts on
its own thread through these methods, and a delegated child is only stopped,
never archived, moved or renamed apart from its parent.

Every action leaves a system line in the target's timeline naming the steward:
"Archived by the steward ...", "Question answered by the steward ..., not by
the user", "Bash allowed by the steward ..., not by the user". Nothing the
steward does is recorded as the user's.

Merging a pull request or starting a nightly is ordinary shell work for the
steward (`gh pr merge`, `gh workflow run`), under the provider permissions of
its own conversation. Boite grants no GitHub rights.

## Letters, not prompts

A steward's message is an [agent coordination](coordination.md) letter with
`origin: 'steward'`, never a user prompt. Its recipient's provider reads it in
its own section: it comes from the steward the user assigned, it is not the
user, it directs the work but grants no approval the user did not give. The
timeline draws it as a forwarded message labelled as the steward's. Only the
local core marks a letter as the steward's, and only while the grant covers the
recipient; a letter from another machine never is.

Steward letters, and letters a thread sends back to the steward that covers
it, pass the communication settings of both threads (off and pause included)
and wait six hours for delivery instead of fifteen minutes. The owner pausing
the steward's own coordination still holds everything it sends and receives.

## Notices

With notices on, the core sends the steward a letter with `origin: 'notice'`
from a thread it looks after when that thread finishes a turn (with its last
answer and its pull request), fails, asks a question or waits on a permission.
Notices wake an idle steward like any letter, so it needs no polling loop. The
steward's own turns, delegated children, persistent sessions and threads
outside its projects send none. One event lands once; past 60 notices in a
rolling hour the core drops the rest and logs it.

## The owner from a terminal

The same commands work outside any thread. The owner reaches every thread
through the owner methods, and `thread send` there is the owner's own prompt,
queued behind a running turn. `thread new <project> <brief>` copies the agent
of `--thread`, else of the project's most recent thread; `--model` replaces the
model. To reach another machine, pass `--core <url>` with its token in
`BOITE_TOKEN`; the token never goes on the command line. See [the CLI](cli.md).

## Tests

`packages/core/test/stewards.test.ts` covers the grant and its capabilities,
letters through disabled coordination and back, notices waking the steward and
the answer it gives, the spawn and project gates, and the owner's terminal
commands. Run `bun test test/stewards.test.ts` in `packages/core`.
