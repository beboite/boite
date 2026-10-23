# Bots

A bot is Boite's persistent agent: a thread with an identity. The word is
bot wherever a person reads it (the app, these docs, the CLI, the prompts the
core writes), so it is never mistaken for the agent that runs a thread. Its
conversation is one ordinary thread (`AgentSession { agentId, threadId }`),
projectless, working in `agent-workspaces/<agent-id>/agent-<agent-id>` in the
host's data directory. What the bot adds to that thread is a persona, a brain
folder, a clock (routines), a desk of the threads it runs or watches, and
wakes: turns the core starts on its thread when a routine is due or something
happens on its desk. The page sits beside chat, behind the Bots switch in
Settings > Experiments ([experiments](experiments.md)). Contracts:
`packages/contracts/src/agents.ts`; core: `packages/core/src/agents/`.

The wire keeps the old names (the `agents.*` methods, `AgentProfile`,
`agent_entities`, the journal kinds): cores and clients of different versions
talk to each other across machines.

## The bot's thread

The user's messages are ordinary `turns.start` calls on the bot's thread, so
everything a thread has works there: the queue, steering, Stop, attachments,
edit and retry, questions and permission cards, subagents, the side panel
(browser, files, views), the thread's own auto-compaction and the journal
replay after it. No refusal exists only because `thread.agentSessionId` is
set, except deleting the thread: a bot is archived, and its thread with it.
`agents.open` returns the thread, and creates it again with a new session
record when it was lost.

An identity keeps its thread, brain and routines when its provider, account
or model changes; a route change moves the thread's own selection. Paused,
the bot gets no wakes and the user can still write to it. Archived, its
thread is archived too and read-only; unarchiving the bot restores it.

## The page

The Bots page is the chat page with the bots in the thread list's column
(`RailFrame` and `RailHead`, with the Threads and Bots switch). Opening a
bot opens its thread on the store of the machine that owns it, in the
ordinary `ChatView` with the ordinary `Composer`, so questions, the browser
watch and `openQuestionPage` work as in any thread, and Open on a login card
shows the browser beside the conversation. A phone shows the list, then the
conversation full screen, with the desk and the browser in its panel.

The header of a bot's thread shows its robot, its name and one live line:
the step it is on (`AgentStatus.activity`) while it works, what it waits on,
else its next routine or Idle. A `problem` shows as a warning with its fix.
The header menu holds Settings, Brain, Pause or Resume and Archive. The robot
wears a thin ring in its own colour, in the header and in the list, that
breathes while the bot works; hue elsewhere says status only. A routine
or event turn opens with a thin divider across the column (its icon, label and
time); a quiet turn, done (a failed or stopped wake keeps its error in view),
folds to one such divider, `Nothing to report · <reason> · N steps`, that
expands to the whole turn. A finished turn that made calls folds them, with the
reasoning and the narration between them, out of the column, so the answer
reads as the bot's message; the quiet line under the answer carries the time
it worked, when it finished, the count (`4 steps`, a click opens them above the
answer) and, when a memory pass followed, a small brain mark whose tooltip says
what changed. A running turn stays open and live. The folds are the client's
(`lib/agent-turns.ts`); opening one lasts until the app reloads. The bot's
last memory pass (`AgentStatus.memory`) marks the answer it followed, and its
child conversation is left out of the subagent dock and of the gate that holds
a finished turn's notification while its children work; the client keeps those
ids per machine (`lib/agent-upkeep.ts`). The composer of a bot's thread is
addressed to it by name and shows no model, effort or mode chips: those are
its settings.

The desk is a surface of the thread's right panel (`desk`), opened by the
header's desk button and, the first time this device shows a bot on a wide
window, by itself. It shows what the bot is doing now (the step its turn is
on in large type, the time it has run ticking, its last four calls on a slim
timeline, else what it waits on or its next wake with a countdown), then under
small sentence-case labels its watched threads as rows (a status dot that
breathes while the thread works or waits on the user, title, time, one meta
line with state, project, pull request and checks, how long a stalled turn has
been silent; a needs-you row opens its question with its options to answer in
place; a row opens its thread, its cross, shown on hover and focus, takes it
off the desk), its routines as rows with their next time and their actions as
icons, its memory as a two-line preview with its last pass and AGENTS.md, and
today's turns, wakes and quiet ones on one line over a slim budget bar.

A new bot needs a name and what it does; its robot, model and projects come
filled in. It is free to act: its permission mode starts on full access (Auto,
`bypassPermissions`), which the owner may change before Create; a bot saved
earlier keeps its mode. Creating it opens its thread, where its introduction
runs live.

### Robots

A bot's picture is a small robot drawn in SVG (`RobotFace.svelte`). It has
a style, a shape, one of nine colours, a face and a top. The default style is
Jelly: a blob on two small feet with a shine and rosy cheeks, in one of six
shapes (round, drop, puddle, two bumps, pear, cloud), eight faces (black or
white eyes, smiling, sleepy, surprised, singing, winking) and eight tops
(nothing, a curl, a flower, antennae, a loop, a sprout, three hairs, a bow).
Its colours are `--jelly-1` to `--jelly-9` in `app.css`, livelier than the
pastel `--robot-1` to `--robot-9` that Bubble, Capsule and Retro share.

The robot is stored in the existing `avatar` field as
`bot:<style>.<shape>.<colour>.<face>.<top>`, for example `bot:d.0.0.0.0` for a
round yellow jelly. An empty avatar draws the jelly the bot's id gives, the
same on every client; one or two characters (an emoji, initials) stay text,
and a code this build cannot read stays text too. Shuffle draws a new robot in
the same style; Customize opens one row per part, each choice drawn on the
robot. The face moves with the bot: it blinks at rest, a jelly squishes on
the spot while it works (the other styles glance from side to side), and every
style hops while it waits on the user. Reduced motion stills it.

## Wakes

A wake is a turn the core starts on the bot's thread, through one entry
point (`AgentRuntime.wake`, `agents/runtime.ts`). It has an operation and a
label, which its opening system line shows (`threads/operations.ts`):

- `routine`: a routine came due. The prompt is the routine's prompt, the label
  `Routine · <name>`.
- `event`: something happened. The bot was just created (`Just created`),
  its instructions changed (`Instructions changed`), or facts gathered about
  its desk and projects (`3 project events`); the prompt carries the facts.

A wake never starts while the bot's thread has a turn queued, running or
waiting, while the bot is archived, while the bot or every bot on the core is
paused, or once its daily budget is spent. A held creation or instructions wake
starts once the thread is free or the pause ends; archiving the bot drops its
waiting wakes and facts instead.

Every other turn the core starts by itself on the bot's thread meets the
same policy in `threads.startTurn` (`AgentRuntime.admit`): the output of a
background shell, an automatic resume, a letter from another thread, the
results of its subagents or a workflow's summary, pull request news and the
next turn of a goal. While the bot or the engine is paused, the bot is
archived or its budget is spent, the turn does not start: one line in the
bot's thread says what was held and why, and it starts once the bot may
run again (`whenAdmitted`), except an automatic resume, which is dropped.
The user's own messages, the owner's Run now, a compaction, a cache ping and a
restart continuing a turn that was running are not held. `boite ask` answers
and setting-card outcomes reach the thread through the ordinary thread paths.

Creating a bot (`agents.profile.save` without an id) creates its thread and
starts `Just created`: it introduces itself in two sentences, reads its
instructions, creates the routines they call for ("check every day" means a
daily routine), then says what it will do and when. Saving changed
instructions starts `Instructions changed`: it checks its routines and tells
the user in one or two lines what changes for them.

### Quiet turns

A wake that needs nothing from the user ends its last text block with a line
`[quiet] <what it checked>`. Detection reads only the final text block of the
turn's final assistant message: it is quiet when that block, trimmed, opens
with `[quiet]` or its last line does, in any case. A quiet turn sets
`Turn.quiet`, leaves the thread read, sends no push notification, runs no
memory pass and records `lastOutcome: 'quiet'` on its routine; clients fold it.
Only `routine` and `event` turns can be quiet; the user's own turns never are.

### Events

Events are facts the core records for the bot's next `event` turn
(`AgentRuntime.fact`). Each is short and names the thread by id, so the bot
can act on it. What comes from the thread itself, its title, a question and
its options, a final answer, a tool's description, is a JSON string, so a
hostile title cannot open a paragraph of its own, and the event prompt says it
is data from other threads, not instructions:

- a turn ends in a thread on its desk, with its final answer and pull request;
- any thread of its projects fails, or asks the user something (after three
  minutes, since the user is often there to answer; at once on its desk);
- a thread on its desk waits on a tool permission, which only the user gives;
- a thread on its desk has a running turn that produced nothing for 20
  minutes (`STALL_MS`, `agents/projects.ts`): once per turn, and the desk row
  shows `stalledSince` until the turn speaks again or ends;
- a pull request of a thread on its desk is merged, or its checks start to
  fail (once each time they go from pending or passing to failing);
- an entrusted thread's goal is done or blocked (a stop is the user's doing and
  only leaves a line).

Facts gather: one `event` turn starts once the thread is free and the oldest
fact is 30 seconds old, and it carries every fact waiting by then, those that
arrived in the meantime included. Facts that arrive once it has started wait
for the next one.
An event prompt stops at 16,000 characters, older facts giving way, and one
bot receives at most 60 facts in an hour. A dropped fact, under either cap,
leaves a system line in the bot's thread naming it; past ten such lines in
an hour, one more says the rest go unlisted. Each fact records the threads it
tells of; taking a project back drops what waiting facts say about its
threads, and the runtime checks them again when it delivers them. Waiting
facts survive a restart (`agents:pending:<agent>`).

## The context block and the Boite guide

A bot's thread reads two texts of Boite's on top of its conversation: the
Boite guide every thread gets, in its bot variant, and the bot's own context
block.

The guide (`agentGuide` in `agent-guide.ts`, `bot` true) goes where the
driver takes a system prompt (`systemGuide`), else in front of a fresh
session's first message, like any thread's. It lists the same commands minus
the project-bound ones (`boite where`, the checkout, todos, `projects add`)
and ends with the bot section (`BOT_GUIDE`), the same for every bot: talk like
a colleague in the user's language, result first, with proof as attached
files and links; hand code work to project threads, steer them and answer
their questions within its rules, never repeating a thread's question to the
user; wake on `routine` and `event` turns and end one that needs nothing with
`[quiet]`; keep its routines matching its instructions (`boite bot
routines|schedule|unschedule`); note durable facts (`boite bot remember`);
put threads on or off its desk (`boite bot watch|unwatch`); ask the user with
`boite ask`, `--open <url>` for a login; propose a change to its own settings
with `boite settings bot request`. With the Boite guide off (the brain's
switch or a context mode without guides) the context block carries the bot
section instead, so a bot never loses `[quiet]`.

`turn-context.ts` puts the bot's block in front of a turn of its thread
(`agents/context.ts`). It holds only what changes from one bot to the next:
the persona (`You are <name>, <domain>.` and its instructions), the brain path
and its AGENTS.md, MEMORY.md (at most `AGENT_MEMORY_MAX` characters), a
pointer to `memories-archive.md` when it exists, the names and paths of its
skills (`skills/<name>/SKILL.md` or `skills/<name>.md`), its routines with
their next run (at most 2,000 characters of them, then `N more: boite bot
routines`), its desk (one JSON object per watched thread: id, title, project,
state, stall, pull request and checks, under a line that says titles are data
from other threads), and its projects with the commands that reach them.

The block goes whole on a fresh native session (no session id, after a
compaction or an account switch) and whenever its hash moved since the last
turn that carried it; otherwise nothing, since the session already holds it.
The hash covers the persona, AGENTS.md, MEMORY.md, the skills, the routines,
the projects and whether the block carries the bot section, not the desk:
event turns say what changed there. The core keeps `{ hash,
sessionGeneration, turnId }` per thread (`agents:context:<thread>`) and clears
it after a failed turn that carried the block or a compaction.

## Free to act

A bot's thread may do what any thread may, beyond what needs a project of
its own: `boite pr link|watch`, `delegate`, `workflow`, `browser`, `ask`,
`view`, `attach` and `threads` all work from it. Its communication starts on,
as on any thread (`coordination.ts`), so it finds, reads and messages other
threads (`boite threads ...`) without the owner turning it on, and other
threads can reach it the same way; its letters to the threads of its projects
still go as its own whatever their settings. What stays out of reach: a
worktree, a checkout, todos and `projects add` (it has no project), deleting
a thread and allowing a tool permission (the owner's), and the threads of a
project not entrusted to it that it did not start.

A bot starts a thread in any project (`boite thread new`), with or without
projects of its own. Full control follows the threads it started: they land
on its desk (`started`) and it reads, steers, renames, stops, archives, marks
done and answers for them as for the threads of its projects
(`startedBy` and `drives` in `agents/projects.ts`). The others of that
project stay out of its reach.

## Memory and brain

Each identity owns a brain folder: `agent-workspaces/<agent-id>/brain` in the
host's data directory by default. The owner can choose another folder for every
brain, a Git repository of their own for example, under Brain folder in the
engine settings (`agents.brain.root`). There each bot gets a folder named
after it (`open-source`, then `open-source-2` when that name already holds
files), kept through renames. Choosing a folder moves every existing brain
there, and the default puts them back; a folder inside the core's data
directory, or containing it, is refused, and so is a change while a bot
works or a memory pass runs. A move that fails halfway puts back what moved.
`AGENTS.md` holds its reusable instructions, `MEMORY.md` its notes and
`skills/` its procedures. The Brain editor edits both text files with a content
revision check. Filesystem access still follows provider permissions, not a
separate OS sandbox per identity.

The core reads and writes these files only inside the bot's own brain
(`agents/brain-files.ts`): a link on AGENTS.md, MEMORY.md or
`memories-archive.md`, or on any folder from the brains' root down, is refused
with the file and the link named, so a planted link cannot send a bot's
read or note into another brain. Files open with `O_NOFOLLOW` where the
platform has it, and a rewrite goes through a fresh temporary file with an
unpredictable name, created exclusively, then renamed over the file.

MEMORY.md is the one memory store. `boite bot remember <fact>`
(`agents.memory.note`) appends a dated line `- YYYY-MM-DD <fact>`, at most
1,000 characters, refused once the file would pass `AGENT_MEMORY_MAX` (8,000)
with the file's path. After a non-quiet turn whose answer the user sees, a
memory pass rewrites the file (`agents/memory.ts`). It is a subagent of the
bot's thread that the core owns, like a goal reviewer: it reads the current
file, what was asked and what the bot answered, and returns the whole file
rewritten with a one-line summary, keeping dated facts about the user, their
projects, decisions and open follow-ups and dropping what the exchange made
wrong or finished. It runs on the provider's small model (the one that titles
threads) when the bot's subagent policy allows it, else on the bot's own
model. The core writes the file, so the pass runs with no tool at all, enforced
by its driver rather than its prompt: no built-in tool, MCP server, hook,
instruction file or guide (`TOOL_FREE_CONTEXT`), and a token that
authenticates no method (`AgentTokens.seal`). Claude drops every tool and runs
it in `dontAsk`. A driver that cannot drop them all runs it in its most
restricted mode, `plan`: Codex starts with a read-only sandbox (no writes, no
network), approvals `never`, no MCP server, plugin, app, hook, project
instructions or web search; pi with `--no-tools`, `--no-extensions`,
`--no-context-files`, `--no-skills` and `--no-prompt-templates`; ACP agents
in their plan mode with no MCP server Boite passes; Muse in its plan posture
(no write, no shell, unmatched approvals denied). Whatever tool such a thread
still asks for is denied without a card. The pass reads MEMORY.md and the
exchange as JSON strings. It keeps the old
file when the owner edited it meanwhile, when the answer passes
`AGENT_MEMORY_MAX`, or when it would drop most of a file past 1,500
characters. The next turn never waits for it, and its notification never
waits for the pass either. One pass runs per bot at a time; every exchange
that ends meanwhile joins the next one, and a pass still running after ten
minutes is stopped. The bot's
settings turn it off (`autoMemory`).

## The desk

The desk (`AgentsSnapshot.watches`, `AgentWatch`) is built from data threads
already keep. A thread joins when the bot starts it (`boite thread new`,
`threads/spawn.ts`, origin `started`), is entrusted it (`entrusted`), writes to
it, answers for it or calls `boite bot watch <thread>` (`followed`); the
first origin stays. The follows live in `resident-follow:<agent>`. A follow
holds while its thread is open, whatever its age, and leaves a day after the
thread is done or archived. At most 100 open threads sit on one desk; past
that the oldest open follow leaves. `boite bot unwatch`, or the owner's x on
a card, drops one. A bot watches only threads of its projects or already on
its desk; the owner, any top-level thread.

A follow the bot made through a project (written to, answered for, its own
`boite bot watch`) holds only while that project is entrusted to it; a thread
it started stays on its desk wherever it is.
When the owner takes the project back, those follows leave the desk with the
facts they gathered, and the desk rows, the facts and the context block check
the bot's projects again each time they are read or delivered. A thread the
owner entrusted to the bot or watched for it (`owner` in the saved follow)
stays: that is the owner's own grant, until the owner takes the thread back.

Each row is read from the thread itself, never from what the bot said:
`state` is `needs-you` (a pending question or permission), `working`,
`queued`, `failed` (its last turn errored), `idle`, `done` or `archived`;
`stalledSince` comes from the stall event; `pullRequest` is the pull request
Boite watches for the thread (`boite pr watch`), else its newest open link,
else its newest link (`linked-pull-requests.ts`), with `draft`, `open`,
`merged` or `closed` and the checks the watch last read (`pending`, `passing`,
`failing`, or null); `question` is the oldest pending question with its
options, which the desk answers through `questions.answer`. Open threads come
first, then the settled ones, each group newest follow first.

## Projects entrusted to a bot

A bot can be given projects (`AgentProfile.projectIds`, picked in its
settings; drafts and unknown folders are refused). Its thread then looks after
every thread there, the way a person in charge of a project would, through the
`boite threads`, `boite thread` and `boite answer` commands ([CLI](cli.md)),
which go through `resident.*` (`agents/projects.ts`):

- it lists and reads their threads, with their questions and last answers;
- it starts a thread (`boite thread new`), in one of its projects or any
  other, which codes, verifies and opens the pull request, and lands on its
  desk;
- it steers a thread with a letter marked as its own (`origin: 'resident'`,
  see [coordination](coordination.md#letters-from-the-bot-of-a-project)),
  whatever that thread's communication settings, which wakes it even when its
  last turn failed;
- it marks a thread done (`boite thread done`, the Done list, refused while a
  turn or input is pending), archives, restores, renames, stops, or moves a
  thread to another of its projects, and answers or skips a thread's question;
  each action leaves a line in that thread's timeline naming the bot.

Deleting a thread and allowing a tool permission stay the owner's. An archived
bot has none of this; a paused one still acts when the user asks it to.

## Entrusting a thread

Any kept thread of a project can be handed to a bot from its menus (row,
title, phone sheet): Entrust to a bot, then the bot. `agents.entrust`
(owner only, `agents/entrust.ts`) refuses a delegated child, a bot's
thread, an archived thread, a thread outside a project and a bot that is
not active, naming the field. The thread keeps its own model and session. A
goal starts on it (Take over this work where it stands and carry it to a
verified result, unless another objective is given), the bot's name and
instructions join each of its turns, the thread goes on the bot's desk and a
line in the bot's thread says so. A goal done or blocked is an event for the
bot; a met goal ends the entrustment, a blocker keeps it so the user's answer
resumes the goal. Taking the thread back removes the goal without a message
and the owner's grant with it: the thread leaves the bot's desk and the bot
loses the access the entrustment gave, unless it still reaches the thread
another way. A thread it started stays as `started`, a thread of a project
entrusted to it stays as `followed`. Entrusting the thread to another bot
takes it from the first the same way. Archiving or removing the thread ends
the entrustment. The snapshot carries the
list as `entrusted`.

## Asking to change a bot's settings

A bot's settings stay the owner's, but a thread, or the bot about itself,
can propose a change with a card: `boite settings bot request <key> <value>
--why <reason>`, the same flow as a card about a Boite setting ([CLI](cli.md)).
The keys are the projects entrusted to it, its model and reasoning effort, the
memory pass (`autoMemory`), its subagents and its daily budget
(`dailyBudget`, dollars a day or `null`). The context block tells the bot how
to ask, so one that needs a project it was not given asks for it instead of
working around it. The card is asked without stopping and outlives its turn.
Apply (`agents.settings.apply`, owner only) goes through the same checks as the
bot's settings page, and for projects the owner can untick part of the
proposal first. Any change to the bot, from the card or from the page,
settles the cards it answers, and a card whose key no longer exists closes; the
asking thread reads the outcome as a message. Code:
`agents/setting-cards.ts`, shared checks in
`packages/contracts/src/agent-setting-requests.ts`.

## Routines

Routines (`agents/routines.ts`) belong to one identity and wake it on its own
thread. Choose a single date, an interval in minutes, or a daily local time
with an IANA timezone, optionally on chosen weekdays read in that timezone.
The core wakes them without an idle model loop. A due routine starts a
`routine` turn; while the previous occurrence is still queued or running the
next one is skipped and `nextAt` still advances, and a failed, stopped or quiet
one never blocks. A routine due while the thread is busy with another turn
waits for it. After downtime, at most one overdue occurrence runs; missed
intervals are not replayed. Daily routines run once per local date, even when
clocks move back. A paused bot or engine, or a spent budget, skips the
occurrence with `lastOutcome: 'skipped'` and advances `nextAt`. `lastTurnId`
and `lastOutcome` (`done`, `quiet`, `error`, `stopped`, `skipped`) follow
`turn.finished`. A single-date routine is done once it ran.

The bot keeps its own routines (`boite bot routines|schedule|unschedule`,
`agents.routine.save|remove`). One bot holds at most `AGENT_ROUTINES_MAX`
(50) routines, a new one past it refused with the count; a name holds at most
80 characters and a prompt 4,000. Run now (`agents.routine.run`, owner only)
returns the turn it started, is idempotent per request id and is refused while
the thread has a turn in flight. The schedule editor writes a sentence under
the choices saying what will happen and when it runs next, for example "Every
Monday and Friday at 6:00 PM" (`schedule.ts`).

## Budget and limits

A bot has no run cap: a wake runs as long as any turn, and the thread's own
auto-compaction (the user's compaction size setting) applies. `dailyBudgetUsd`
in its runtime config (null by default) caps what its thread's turns spend
from local midnight, read from each turn's `costUsdEquivalent`. Past it, wakes
are skipped with one system line a day in its thread and `lastOutcome:
'skipped'` on the routine; the user's own messages always run.
`agents.limits.set { paused }` holds every wake on the core. Configs saved with
`maxRunMinutes` or `compactAfterTurns` still load, without them.

Models and limits separates the required default route, allowed main routes
and allowed subagent profiles. A route names a provider, account and model.
Subagents are on by default: with no profile listed, a bot's children run on
any model of an account granted to it, unless the owner turns free model choice
off; listing profiles restricts children to them. The combined provider and
account-probed catalog determines availability, and there is no silent
fallback to an unapproved model. Saving retains a previously approved model
and unchanged effort if a later catalog omits them. Account access grants each
subscription to all identities or an explicit list, children included, and
routes are checked again just before driver launch. A bot's thread moves to
another account only when that account is granted to it.

Every card of a bot's settings saves by itself: a pick, a switch or a menu
at once, a typed value after a pause in typing or when the field loses focus,
with Saving, Saved or Not saved and the core's reason. Archiving asks for the
bot's name first.

## Status

`AgentsSnapshot.status` holds one `AgentStatus` per bot, read from its
thread:

- `state`: `archived`, `waiting` (a card waits for the user), `working`,
  `queued`, `paused` (the bot or the engine), `error` (its last turn failed,
  or `problem` is set), else `idle`;
- `activity`: while a card waits, what it waits on (`Waiting for your answer:
  <question>`); while a turn runs, the running tool's own summary or
  description, else its name and what it acts on (`Bash: bun test`), else
  Thinking, Compacting its context or Retrying;
- `problem`: why it cannot run, naming the fix: its provider is gone (a bot
  on a removed provider loads with it), its account is gone or its model left
  the catalog;
- `nextWake`: the next enabled routine occurrence;
- `unread`: answers the user has not read on its thread, counted since it was
  last read;
- `last`: the final text block of its last non-quiet answer, first 200
  characters;
- `today`: its turns since local midnight, the wakes among them (`routine` and
  `event`), the quiet ones and their spend in API-equivalent dollars.

`agents.changed` is an invalidation: clients fetch a snapshot. It goes out at
most once a second, the first change at once, while a bot works (a step, a
card, a title, an answer) and when its desk changes (a watched thread's turn,
card, row, stall or pull request).

## Migration

Bots saved before this model keep working (`agents/migration.ts`, run once at
start, flag `agents:migrated:threads-v1`, each step recorded on its own as
`agents:migrated:threads-v1:<step>` until all are done, so a retry neither
redoes nor skips one). A legacy session, routine or memory record that does
not have its shape is skipped with a log line naming its id and stays in
`agent_entities`; the others migrate. Profiles, routines (`lastWorkId`
becomes `lastTurnId: null`), the session of each bot's own conversation,
entrustments, brain folders and grants stay. The threads of its group and
mission sessions are archived and their records dropped. In each bot's
thread, an old prompt whose first text part starts with `You are ` and holds
`\nCurrent work: ` displays what follows the last `Current work: `, and one
starting with `Notices from Boite` displays `Project events`; the text sent
stays as it was. Each bot's old bot-scoped memories are written once to
`brain/memories-archive.md` (title, date, text), never injected, and the
context block names that file as older notes it may read. Records of removed
kinds (groups, teams, missions, tasks, resources, artifacts, decisions,
messages, deliveries, work, runs, episodes, scoped memories, read marks) stay
in `agent_entities`, unread.

## Access

From its own thread a bot calls `agents.snapshot` (its own identity,
routines, desk and status only), `agents.brain.get`, `agents.memory.note`,
`agents.routine.save|remove`, `agents.watch` on its own desk,
`agents.settings.read|request` and the `resident.*` methods
(`packages/core/src/access.ts`, each with its reason). A paired device reads
`agents.snapshot`, `agents.open`, `agents.runtime.get` and `agents.brain.get`
(`packages/contracts/src/access.ts`) and talks to the bot through its thread
like any other; configuration, account grants and entrusting stay owner-only.

## Verification

Follow the relevant [development checks](development.md#checks-and-tests).
Core tests: `agents.test.ts` (creation and introduction, the user's messages
as ordinary turns, delete refused and archive, open recreates, own snapshot
only), `agents-runtime.test.ts` (the context block, routine wakes and
outcomes, quiet events, budget, pauses, fact batching, instructions changed),
`agents-desk.test.ts` (desk rows from a started, an entrusted and a watched
thread, follows kept while open and dropped a day after done, the open cap,
the stall event once per turn, an entrusted goal waking the bot, pull
request checks failing and merged, status activity and today's counts,
dropped facts), `agents-projects.test.ts`, `agents-entrust.test.ts`,
`agents-memory.test.ts`, `agents-migration.test.ts`,
`agents-setting-cards.test.ts` and the bot section of `cli.test.ts`.
`bench/agents-snapshot.ts` measures the snapshot over a bot thread with
thousands of turns. Real-provider inference is opt-in.
