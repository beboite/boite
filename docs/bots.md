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

Opening the conversation does not require its saved provider or account to
still exist. The warning's Fix it button opens Settings, where choosing a new
default also replaces that missing default's allowed route and removes other
allowed routes whose provider or account is gone. Starting a turn still
requires an available provider and an account belonging to it.

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
The header menu holds Settings, Brain, Pause or Resume and Archive.

In the list, a bot's row is its robot beside two lines, the messenger way:
its name over what it does this second, with a glyph for the kind of step
(a command, a file read or edited, a search, the web, a subagent, thinking,
a pause). That line is in the accent while it works and the right side
counts the time it has worked; it shows the question in the waiting colour
while it needs the user, the failure in danger, Paused asleep, else the last
thing it said, bold while unread. A driver that reports only the running
tool's name ("Bash") reads as the call's title from the snapshot, else as
the tool's family in words (`liveActivity`, `lib/agents.svelte.ts`).

The ring around the robot, in the list, the header and the desk, says how the
bot stands (`AgentMood`): an accent arc turning while it works, a dashed
accent ring while queued, the waiting colour pulsing while it needs the user,
danger after a failure, a full accent ring over answers not read, a dashed
grey ring asleep (paused), a hairline in the robot's own colour at rest. The
face moves with it.
A routine
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
window, by itself. It keeps what the bot is doing now above three tabs: Work,
Routines and Memory. The current step and elapsed time stay visible; the
step count unfolds the last four calls. When idle, the card shows what it
waits on or its next wake with a countdown. Work opens by default and shows
its followed threads as rows (a status dot that
breathes while the thread works or waits on the user, title, time, one meta
line with state, project, pull request and checks, how long a stalled turn has
been silent; a needs-you row opens its question with its options to answer in
place; a row opens its thread, its cross, shown on hover and focus, takes it
off the desk). Routines holds scheduled work and its actions; Memory holds
the memory preview, its last update and AGENTS.md. A failed memory update
marks its tab, with the full error inside. Arrow keys, Home and End change
tabs; switching tabs preserves unfinished forms. Today's spend stays in a
summary that unfolds the turn counts and budget bar. Reaching the budget
opens that summary so its warning stays visible.

A new bot needs a name and what it does; its robot, model and projects come
filled in. It is free to act: its permission mode starts on full access (Auto,
`bypassPermissions`), which the owner may change before Create; a bot saved
earlier keeps its mode. Creating it opens its thread, where its introduction
runs live.

### Robots

A bot's picture is a small robot drawn in SVG (`RobotFace.svelte`). Its
style is only its body: Jelly (a blob on two small feet with a shine), Bubble
(a round body rising from the bottom of the disc), Capsule (a light face
plate, tilted, on a coloured ground) and Retro (a head with a dark screen, on
a neck, with ears), six shapes each. Every other part is shared by every
style: each body gives a rig, where its eyes, mouth, cheeks, crown and sides
sit, and the part is drawn there. On a Retro screen the face is lit in the
LED colour rather than inked. A part added once fits every style.

| Part | Choices |
| --- | --- |
| Colour | 18: the lively `--jelly-1` to `--jelly-9`, then the pastel `--robot-1` to `--robot-9` |
| Eyes | 16: beans, sparkles, dots, pills, googly, happy, sleepy, glancing, winking, stars, hearts, a visor, anime, determined, dizzy, bored |
| Mouth | 12: none, smile, small smile, laugh, surprised, cat, smirk, tongue, flat, fang, singing, grin |
| Top | 18: none, antenna, antennae, curl, loop, flower, sprout, three hairs, tuft, bow, halo, headphones, propeller, beanie, crown, cat ears, party hat, side pods |
| Cheeks | 4: none, blush, freckles, hearts |
| Gear | 5: none, round glasses, shades, monocle, bandage |

The robot is stored in the existing `avatar` field as
`bot:<style>.<shape>.<colour>.<eyes>.<top>.<mouth>.<cheeks>.<gear>`, for example
`bot:d.0.0.0.0.1.1.0` for a round yellow smiling jelly. A four-part code
written before parts were shared (`bot:<style>.<shape>.<colour>.<face>.<top>`)
keeps its look: its face becomes the eyes and mouth it drew, its top the
shared top (a Bubble's glasses become gear), its colour the set it wore. An
empty avatar draws the jelly the bot's id gives, the same on every client
and the same as before the change; one or two characters (an emoji,
initials) stay text, and a code this build cannot read stays text too, so an
older client shows a new code as initials. Shuffle draws every part anew in
the same style, dizzy eyes aside, gear and freckles kept rare; Customize opens
one row per part, each choice drawn on the robot. The face moves with the
bot: it blinks at rest, a jelly squishes on the spot while it works (the
other styles glance from side to side), every style hops while it waits on
the user, shuts its eyes and breathes slowly asleep, and goes dizzy after a
failure. Reduced motion stills it.

## Wakes

A wake is a turn the core starts on the bot's thread, through one entry
point (`AgentRuntime.wake`, `agents/runtime.ts`). It has an operation and a
label, which its opening system line shows (`threads/operations.ts`):

- `routine`: a routine came due. The prompt is the routine's prompt, the label
  `Routine · <name>`.
- `event`: something happened. The bot was just created (`Just created`),
  its instructions changed (`Instructions changed`), facts gathered about
  its desk and projects (`3 project events`), or a service outside Boite sent
  an event ([outside events](#outside-events)); the prompt carries the facts.

A wake never starts while the bot's thread has a turn queued, running or
waiting, while the bot is archived, while the bot or every bot on the core is
paused, or once its daily budget is spent. A held creation or instructions wake
starts once the thread is free or the pause ends; archiving the bot drops its
waiting wakes and facts instead.

Every other turn the core starts by itself on the bot's thread meets the
same policy in `threads.startTurn` (`AgentRuntime.admit`): the output of a
background shell, an automatic resume, a letter from another thread, the
results of its subagents or a workflow's summary, pull request news and the
next turn of a goal. The turn's origin decides which ones count
(`autonomousSource` in `threads/turn-origin.ts`); a request id never does. While the bot or the engine is paused, the bot is
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
  only leaves a line);
- a service outside Boite sends one ([outside events](#outside-events)).

Only the facts that are the bot's own business wake it at once
(`AgentFact.urgent`): those about a thread on its desk as `started`,
`entrusted` or `followed`, and outside events. The others, a thread it only
wrote to or answered for (`touched`) and any other thread of its projects,
wake it only when its `eventWakes` setting is on, which it is not by default:
then they wait, durably, for its next routine, which carries them under its
own prompt. An event turn carries only the facts that woke it; the waiting
ones stay for the routine. Permission checks run again when either delivers
them. A bot that should hear every project event as it lands asks for
`eventWakes true` ([settings](#asking-to-change-a-bots-settings)).

Facts gather: one `event` turn starts once the thread is free and the oldest
waking fact is 30 seconds old, and it carries every waking fact waiting by
then, those that arrived in the meantime included. Facts that arrive once it
has started wait for the next one.
An event prompt stops at 16,000 characters, older facts giving way, and one
bot receives at most 60 facts in an hour. A dropped fact, under either cap,
leaves a system line in the bot's thread naming it; past ten such lines in
an hour, one more says the rest go unlisted. Each fact records the threads it
tells of; taking a project back drops what waiting facts say about its
threads, and the runtime checks them again when it delivers them. Waiting
facts survive a restart (`agents:pending:<agent>`).

### Outside events

A service outside Boite, a CI job, a monitor, a script, wakes a bot with
`agents.event { agent, key?, text }` (`boite bot event <bot> [--key <key>]
<text>`, [CLI](cli.md#commands)). The owner and paired devices may call it,
never an agent token: threads and bots already reach a bot through letters.
`agent` is the bot's id or name, `key` is 1 to 64 letters, digits, dots,
underscores or hyphens (`external` by default) and `text` holds at most 16,000
characters. Quoted, it may grow (a control character becomes six), so Boite
cuts it until the wake it makes fits in 16,000 characters and says where it
cut. The paired device's name is quoted in at most 120 characters, cut the
same way. The event lands as an urgent fact under `external:<key>`, so it
wakes the bot whatever `eventWakes` says, under the same hourly cap; a second
event with the same key replaces one still waiting, keeping its place. The
prompt quotes the text as data from outside Boite, never the user speaking,
and names who sent it: the paired device by the name it gave when it paired,
or the owner's token.

Pair one device per outside service, under the service's name, and give that
service its own session key: the prompt then names it, and revoking that one
device (`sessions.revoke`, [phone](phone.md#older-links)) cuts that service alone. A
paired device can do more than send events ([access](#access)), so keep its
key where only that service reads it.

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
with `boite settings bot request` as soon as one stops fitting (the user's
words contradict its instructions, most wakes end in `[quiet]`, its model or
effort costs more than its work needs), rather than working around it in its
memory, routines or the brain. With the Boite guide off (the brain's
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
1,000 characters, refused once the file would pass `AGENT_MEMORY_MAX` (16,000)
with the file's path. After a non-quiet turn whose answer the user sees, a
memory pass rewrites the file (`agents/memory.ts`). It is a subagent of the
bot's thread that the core owns, like a goal reviewer: it reads the current
file, what was asked and what the bot answered, and returns the whole file
rewritten with a one-line summary. A bot stays on for months, so the file is a
map rather than a store: where things are (projects, folders, files, URLs,
threads, accounts, each with its path or id and where it stands), then dated
facts about the user, decisions and open follow-ups. A detail stays in the
place that holds it and the line points there; the pass drops what the
exchange made wrong or finished. It aims under `MEMORY_TARGET` (three
quarters of the cap) and is told the file's current size. It runs on the provider's small model (the one that titles
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
`AGENT_MEMORY_MAX` (an answer past it first goes back once to the same pass,
which is asked to cut its rewrite under `MEMORY_TARGET`; past it twice, the
old file stays), or when it would drop most of a file past 1,500
characters. The next turn never waits for it, and its notification never
waits for the pass either. One pass runs per bot at a time; every exchange
that ends meanwhile joins the next one, and a pass still running after ten
minutes is stopped. The bot's
settings turn it off (`autoMemory`).

## The desk

The desk (`AgentsSnapshot.watches`, `AgentWatch`) is built from data threads
already keep. A thread joins when the bot starts it (`boite thread new`,
`threads/spawn.ts`, origin `started`), is entrusted it (`entrusted`), writes to
it or answers for it (`touched`), or calls `boite bot watch <thread>`
(`followed`); the first origin stays, except that a watch upgrades `touched` to
`followed`. Only `touched` threads do not wake the bot at once
([events](#events)). A follow saved as `followed` by an older core for a thread
the bot only wrote to stays `followed`, and wakes it, until it leaves the desk. The follows live in `resident-follow:<agent>`. A follow
holds while its thread is open, whatever its age, and leaves a day after the
thread is done or archived; a removed thread leaves every desk at once,
whatever its origin. At most 100 open threads sit on one desk; past
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
stays: that is the owner's own grant, and an entrusted one lasts until its
entrustment ends.

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

## Projects of the other machines of the group

A bot can also look after projects of another machine of its
[group](groups.md): the server that hosts it, say, minding the PC's game
project. Only the bot's owner entrusts one, like a local project (its
settings, or a card the bot asks with `boite settings bot request projects
+<machine>/<project>`); the profile keeps it as `<core-id>/<project-id>` and
`boite settings bot projects` lists those projects as `<machine>/<name>`.

**That machine decides.** Its own `groupBots` setting, **Bots from the other
machines** on the Machines page, off by default, is the permission that
counts (`agents/group-host.ts`). It is separate from `groupThreads`: letting
the other machines start a thread here is not letting their bots steer every
thread of a project. While it is off the machine refuses every request of a
bot, and turning it off cuts at once: requests are refused from that moment,
the events waiting for the bots are dropped and the letters a bot wrote that
no thread has read yet go nowhere. The grants stay, so turning it on again
needs nothing from the bots' owner. A machine leaving the group, or removed
from it, loses the same way, since every request is checked against the group
as it is now.

**What crosses.** Every request goes over the group's sealed and signed link
(`bot.lease`, `bot.threads`, `bot.thread`, `bot.send`, `bot.act`,
`bot.answer`, `bot.start`, `bot.event`, see [coordination](coordination.md)); no key or
token is copied from one machine to the other. Each request carries the bot's
lease: its name, its thread, the projects of that machine its owner entrusted
and the threads there on its desk, numbered so an older lease never replaces a
newer one. The bot's machine sends it again whenever the bot's projects or
desk change, and with no project of that machine left it sends an empty one,
which ends the bot's access there. The other machine keeps only the projects
of the lease that are still there, open and not drafts.
A send includes its intended watch before the request leaves, so a concurrent
lease sync cannot erase it while the answer is in flight. A rejected send drops
that intent; a successful one keeps the thread on the bot's desk.

**What the bot may do there** is what it may do in a project of its own
machine, and no more: list and read the threads with their questions, write
to a thread (a letter marked `resident`, as from the bot of a project), mark
it done, archive, restore, rename, stop, move it between the bot's projects
there, answer or skip its questions, and start a thread in one of its
projects there (below).
Deleting a thread, deciding a tool permission and that machine's settings stay
its owner's, refused there whatever the request says. The CLI names such a thread `<machine>/<thread-id>`, and `boite
threads` gives `machine=<name>` on its row. Code: `agents/group-bots.ts` on the
bot's machine, `agents/group-host.ts` on the other.

**Starting a thread there.** `boite thread new <machine>/<project> <brief>`,
with the project as `boite threads` and `boite settings bot projects` name it
(its `<core-id>/<project-id>` works too), or `boite thread new <project>
<brief> --machine <machine>` with its name there, starts a thread in a project
of that machine entrusted to the bot. Both machines refuse a name shared by
several entrusted projects and list their ids; use an id to choose one. The bot's machine checks the project is
one of its grants there (rereading that machine's project names once when it
does not know the name) and sends `bot.start` with the lease; that machine
checks it as any other request of the bot (its `groupBots`, the lease covering
that project, the bot's machine still a member) and starts an ordinary thread
of the project, on the bot's provider and model under the rules of `thread new
--machine` (the provider signed in there, the model when that machine lists
it, else its default). The thread's first message carries the bot's note and
link, naming the bot's machine; it is on the bot's desk on both machines before
its first turn, so that turn's answer reaches the bot once, as a desk event,
never as a letter. Without explicit model, effort or speed, `groupThreads`
plays no part. Passing `--model`, `--effort` or `--speed` first reads that
machine's model list and requires `groupThreads` too; the requested model,
effort and speed must match that list, or no thread starts. A retry with the same
`--request-id` answers the same thread, on the bot's machine and on the other
one. When the answer to `bot.start` is lost, that machine keeps the thread
watched until a lease of the bot lists it: the next lease sync's answer, or the
event of its first turn, puts it back on the bot's desk, and that answer still
reaches the bot once. A thread taken off the desk (`boite bot unwatch`) before
that is let go there too: the bot's leases name what it took off. A project of that machine not entrusted to the bot is refused with the
ones it may use there; a machine with `groupBots` off, too old for `bot.start`
or not answering is named as for every other request. The thread there
obeys that machine's rule: it starts nothing until the user writes in it.

**Events.** A thread there the bot wrote to, answered, started or watched goes
on its desk. That machine sends a `bot.event` when a turn of a thread on the desk
ends, when any turn of the bot's projects there fails, when one of their
threads asks a question and when a thread on the desk waits on a tool
permission (which stays the owner's to decide), and the bot's machine turns it
into a fact like a local one (keys start `remote:<core-id>:`), with the row
the desk shows. An event that cannot leave waits in an outbox per machine
(`OUTBOX_MAX`, the oldest leave first), retried after 5 s, 15 s, 1 min, then
every 5 min, and at once when the bot's machine sends any request again; an
event already delivered never wakes the bot twice.

**A machine that does not answer** is named, never skipped: `boite threads`
ends with `unavailable: <machine> is unreachable (...)`, a command on one of
its threads fails with the same reason and says its events arrive once it is
back, and the desk rows of its threads keep the last row it sent, marked
unreachable. A machine with `groupBots` off says so the same way, with the
command that asks its owner to turn it on.

Limits: a machine does not check which of its projects the bots' owner
entrusted, it trusts the lease the bot's machine sends (the owner of both is
the same person); its project names reach the bot's machine only once it
allows bots, so the settings and cards offer its projects from then on; a
remote desk row carries no question nor stall time, and opens only on a
client that reaches that machine; a stalled turn there wakes no one; the letters the bot sends there do not
appear in its own machine's mail view; a bot starts threads on another machine
only in the projects there entrusted to it.

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
resumes the goal. Taking the thread back removes the goal without a message.
However the entrustment ends (a met goal, a take-back, the thread archived or
removed, the thread entrusted to another bot), the owner's grant ends with it
(`AgentProjects.release`): the bot loses the access the entrustment gave. A
watch it had before the entrustment, followed or started, stays as it was,
and so does a watch the owner adds while the thread is entrusted, a grant of
its own kept as `followed`;
the one the entrustment made stays only when the thread's project is
entrusted to the bot, as `followed`, and otherwise leaves the desk. The news
of a met goal still reaches the bot. The snapshot carries the list as
`entrusted`.

## Asking to change a bot's settings

A bot's settings stay the owner's, but a thread, or a bot about itself or
another bot (`--bot <name>`), can propose a change with a card: `boite settings
bot request <key> <value> --why <reason>`, the same flow as a card about a
Boite setting ([CLI](cli.md)). The keys are its name, its role (`domain`), its
instructions (`--instructions-file <path>` for a long text), its picture
(`avatar`: one or two characters, a robot code, or `""`), its `status`
(`active`, `paused` or `archived`), the projects entrusted to it, its model and
reasoning effort, the memory pass (`autoMemory`), its automatic event wakes
for every project and desk fact (`eventWakes`, off by default), its subagents and its daily budget (`dailyBudget`, dollars a
day or `null`). A name another bot holds is refused, when the card is drawn and
again when it is applied. The context block tells the bot how to ask and when:
one the user asks to rename itself draws the card, one that needs a project it
was not given asks for it, and one whose settings no longer fit its work (the
user's words contradict its instructions, most wakes end quiet, its model or
effort costs more than the work needs) proposes the change on its own instead
of working around it. The card is asked without stopping and outlives its turn.
Apply (`agents.settings.apply`, owner only) goes through the same checks as the
bot's settings page, and for projects the owner can untick part of the
proposal first. A model is named `<provider>/<model>` (`codex/gpt-6.1-sol`),
on any provider signed in on the machine; a model id of the bot's own provider
needs no prefix. On its own provider the bot keeps its account, on another it
takes that provider's signed-in default; an account the owner granted only to
other bots is refused. A model outside the bot's allowed routes can be
proposed: applying the card is the owner allowing it, so the route joins
the allowed routes and becomes the default one. Apply checks the model again
and refuses a move to another provider once that provider is turned off or
signed out; a model of the bot's own provider passes, as on its settings
page, which takes one whatever the provider's state. A model card
drawn before cards named the provider holds a model id of the bot's provider
and settles on that id. Any change to the bot, from the card or from the page,
settles the cards it answers, and a card whose key no longer exists closes, as
does one about a bot archived since, except the card that archived it; the
asking thread reads the outcome as a message. Code:
`agents/setting-cards.ts`, shared checks in
`packages/contracts/src/agent-setting-requests.ts`.

A thread asked to set up a bot creates it itself, with no card: `boite settings
bot create <name>`, with its role, instructions, model and projects
([CLI](cli.md)). `agents.create` makes it exactly as the Bots page does, full
access, its conversation and its "Just created" first turn included, and
returns its id and conversation so the thread briefs it with `boite threads
send`. The owner allowed this on 2026-10-24: a thread asks only when something
about the bot is unclear. Changing the bot afterwards still goes through a
card. Code: `agents/create.ts`, shared checks in
`packages/contracts/src/agent-create.ts`.

## Routines

Routines (`agents/routines.ts`) belong to one identity and wake it on its own
thread. Choose a single date, an interval in minutes, a daily local time
(optionally on chosen weekdays), a day of each month, or a month and day of
each year. Recurring calendar schedules use an IANA timezone. Months without
the requested day are skipped, as are non-leap years for February 29.
Nonexistent local times at a clock change are skipped. The form previews the
same next instant as the core, including for routines saved in another timezone.
The owner can assign these in the schedule editor, or ask the bot in its
conversation; it saves the reminder through `boite bot schedule` before confirming.
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
in its runtime config (null by default) caps what the bot spends from local
midnight: the turns started on its thread and on every thread below it, its
subagents at any depth (`parent_thread_id`), the steps of workflow runs rooted
there and its memory pass. `agentSpend` in `packages/core/src/agents/spend.ts`
is the only reader of that sum, for the budget and for the status's
`today.costUsd`. It prices each turn with the usage page's rule
([the API estimate](usage.md#the-api-estimate)): the model's public rates
first, else the cost the agent reported, so a Codex bot, whose turns report
no cost, spends what its tokens cost. A turn on a model the price list does
not know that reported no cost adds nothing, so a bot that only runs such
turns never reaches its budget. Past the budget, wakes are skipped with one
system line a day in its thread and `lastOutcome: 'skipped'` on the routine;
the user's own messages always run. The budget counts the subagents' turns
but never holds them: a subagent spawned during the user's message, a
workflow step or a memory pass still starts.
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
(`packages/core/src/access.ts`, each with its reason); `resident.*` reaches
the projects of another machine through that machine's `groupBots`
permission. A paired device reads
`agents.snapshot`, `agents.open`, `agents.runtime.get` and `agents.brain.get`
(`packages/contracts/src/access.ts`), sends it outside events
(`agents.event`) and talks to the bot through its thread like any other;
configuration, account grants and entrusting stay owner-only.

## Verification

Follow the relevant [development checks](development.md#checks-and-tests).
Core tests: `agents.test.ts` (creation and introduction, the user's messages
as ordinary turns, delete refused and archive, open recreates, own snapshot
only), `agents-runtime.test.ts` (the context block, routine wakes and
outcomes, quiet events, budget, pauses, fact batching, instructions changed,
an outside event from a paired device),
`agents-desk.test.ts` (desk rows from a started, an entrusted and a watched
thread, follows kept while open and dropped a day after done, the open cap,
the stall event once per turn, an entrusted goal waking the bot, pull
request checks failing and merged, status activity and today's counts,
dropped facts), `agents-group.test.ts` (two cores of one group: a bot of
one sees, steers and hears a thread of the other, owner-only actions refused,
an offline machine named and its events delivered on return, access cut when
`groupBots` goes off), `agents-projects.test.ts`, `agents-entrust.test.ts`,
`agents-memory.test.ts`, `agents-migration.test.ts`,
`agents-setting-cards.test.ts` and the bot section of `cli.test.ts`.
`bench/agents-snapshot.ts` measures the snapshot over a bot thread with
thousands of turns. Real-provider inference is opt-in.
