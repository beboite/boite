# Reviewed goals

`/goal2 <objective>` starts a reviewed goal from the composer, its slash menu
or a queued prompt. The core accepts `goal: { objective, review: true }` from
any client (`threads.activity.set`). It began as the `goal2` experiment; an app
or a stored queue that still names `goal2` in its experiments has that id
dropped, not refused.

A reviewed goal runs like `/goal` (see [context](context.md#pending-prompts-goals-and-loops)) until the agent ends a
turn with `[BOITE_GOAL_COMPLETE]`. There, the core treats the marker as a claim
and does not complete the goal:

1. It starts a reviewer in a new child conversation of the thread, in the same
   checkout and permission mode, with none of the agent's history. The reviewer
   runs on the owner's delegation profile whose id or name is `reviewer`, else
   on the conversation's own model. A profile on another agent gives a
   cross-provider review, for example Codex judging a Claude goal.
2. The reviewer receives the objective and the agent's last answer, both as
   JSON data. It is told to inspect the diff, run the checks that prove the
   objective, edit nothing, and end with `VERDICT: PASS`, `PARTIAL` or `FAIL`
   under its findings.
3. PASS completes the goal. PARTIAL, FAIL or an answer without a verdict line
   (`missing`) goes back to the agent: the next goal turn carries the
   findings, as JSON data, and from the second failed review it is told to
   reconsider its approach. Only that first turn after a review carries them.
4. After five reviews without a pass, the goal stops as blocked. The user's
   reply resumes it for one more round, and so does each later reply.

`ThreadActivity.goal.review` holds the phase, the reviewer conversation running
now and every verdict with its round, its summary (2000 characters at most)
and its conversation. The goal bar labels the goal Reviewed goal, shows
Reviewing during a review, and draws one dot per verdict plus a pulsing dot for
the running review. A dot opens its reviewer conversation. The details list
each verdict with its findings.

Before a reviewer or a tracker conversation starts on a model its agent has
not listed since the last account change, the core reads that agent's models
on the account the child will use, as `boite delegate spawn` does, once per
review; the start then goes through the scheduler, so a goal replaced or paused
meanwhile is not reviewed on the old read. An account update forgets Claude's list, and a
review that started without reading it again paused the goal with "the agent
has not listed this model".

Reviewers are not subagents. Like workflow steps, they need no enabled team, a
paused team holds them, and their answer goes to the goal, never to the parent
as mail. They are not listed in the Subagents tab. Pausing, removing or
completing the goal by hand stops the running reviewer, and resuming a goal
paused during its review starts a new review. A core restart keeps the
verdicts and drops the interrupted review; the resume starts a fresh one.

## The checklist

A reviewed goal also keeps the checklist of what the user asked for, so the
agent works on the user's requests rather than on its own plan
(`goal-tracker.ts`, `goal-tracker-prompt.ts`). A tracker, one more child
conversation of the thread with none of its history, runs short passes, one at
a time, in the order they were asked for:

1. When the goal starts, it writes the list from the objective: one item per
   distinct request, in the user's language, at most 12 words, a verb and a
   visible result, with the user's own words it came from. Corrections ("or
   rather", "but", `mot*`) keep their final meaning.
2. Each later message of the user, a new prompt or a steer, adds, drops or
   changes items. The tracker answers with additions, cancellations and
   changes; the core applies them, so ids never move and a dropped item stays,
   struck through.
3. After each finished turn of the conversation, the agent's or the user's, it
   reads a digest of that turn (one line per tool call, the failed ones marked,
   and the agent's last answer) and marks the open items the turn did. An
   item the turn never touched stays open, whatever the answer claims. The
   goal's next turn or review waits for that check.

The next goal turn hears what is still open, as JSON data, in place of the
usual line about the agent's own task list. A completion claim with an open
item goes back to the agent before any review runs, and says so; each item
holds a claim back twice at most, then the review decides alone with the whole
list, statuses included, in its prompt.

The tracker runs on `Settings.goalTracker`, the Checklist model row of
Settings, General, Conversations, shown to the owner only: a provider, a model and its reasoning level, stored by
the core of that machine. Automatic (`null`) takes the newest Opus at medium on
Claude or the newest Sol at high on Codex (`GOAL_TRACKER_DEFAULTS`), the
conversation's own agent first, else the conversation's own model. A small
model is never chosen by itself: on nine real prompts of 900 to 4000
characters (2026-10-18), Haiku 5.5 at xhigh dropped or inverted about two
requests per long prompt, the same ones on every run, where Opus 5.5 at medium
dropped none. On Claude the tracker starts without the user's guides, servers
and hooks and keeps only `Read`; on every agent its rules tell it to answer
from the text alone.

`ThreadActivity.goal.checklist` holds the tracker conversation, its model, the
phase (`writing`, `checking` or `idle`), the items with their status (`open`,
`done`, `cancelled`), whether a later message `added` or `changed` them, how
often each `bounced` a claim, and the last pass's `error`. The goal bar keeps
one line: the first open item and `done/total`, dropped items left out. On the
owner's app that line opens the side panel's Tasks tab. There the checklist
sits under the goal it breaks down, in the same section: a progress bar with
`done/total`, then the items in the order asked, done ones ticked and struck,
the next open one marked. Dropped items wait folded under a "1 dropped" line,
and an icon beside it opens the tracker conversation. The Reviews section lists
each review, newest first, with what it found. A paired device, which has no
Tasks tab, unfolds the same list in the bar instead. A press on an item shows
its source. An item that bounced twice says the final review decides it. The
screen leaves out the `added` and `changed` flags. A pass
that fails, answers without its JSON block or runs past five minutes leaves the
list as it was with the reason, and the goal goes on; a first list is tried
three times at most. A core restart keeps the list and the tracker; work no
pass had read yet is lost.

This version does not run checks itself before the review: the reviewer runs
them and spends tokens doing so. It has no token budget and no detection of
the same finding repeated: the five-review stop bounds a goal instead. The
tracker adds one pass per user message and per finished turn.

## Automatic goals

The client experiment Automatic goals (`auto-goal`, off by default) starts a
reviewed goal without `/goal2`. A user prompt that starts a turn, on a thread
with no goal or loop under way (a paused one counts), starts one when it holds
at least `autoGoalMinChars` characters, 1500 by default. The owner sets that
number under the switch on the Experiments page; the core accepts 200 to 20000.
A steer, a slash command or a queued `/goal` or `/loop` never starts one, and a
subagent's thread never does.

The message stays as typed, and the goal's objective is that same prompt,
verbatim, its spaces included. The turn it starts is the goal's first: the agent
hears the prompt with the goal's rules, as a `/goal2` turn, and a claim or a
blocker it ends on counts, so no second run comes before the review. A prompt
queued with the experiment on never shares a delivery with one queued with it
off. The core decides in `threads.startTurn` from the
experiments of the app that sent the prompt (`turns.start`) or that queued it
(the composer item's `experiments`), so a queued prompt keeps its decision
across a restart and another device's switch never changes it. The goal carries
`auto: true`, and the goal bar names it "Automatic goal". Its remove button
drops it in one click.

When the thread belongs to a project and is not incognito, the core adds a card
to the project board, linked to the conversation (`goalThreadId`), with the
first line of the prompt as its text, cut to 2000 characters. The card follows
the goal as a card the board started does: In progress while it runs, claimed
(In review) once a review passes, Done when the user confirms. Removing the
goal, or replacing it with another, unlinks its cards: an open one stays in To
do, a claimed or done one keeps its column.

An agent may ask for one below the threshold: `boite goal track`
(`threads.goal.track`) starts the same goal on its own thread, its objective
the user's last prompt, a steer included. Called during the turn, it makes that
turn the goal's first, and its output tells the agent the claim marker. The
core refuses it when the desktop app has the experiment off, when a goal or a
loop is under way, and when that prompt already started a goal
(`auto-goal:<thread>` keeps its message).
While the experiment is on, the agent guide of a top-level thread says to run
it when the user's prompt lists several distinct requests.

## Verification

`goal-review.test.ts` drives reviewed goals through the real core with the
echo driver: a failed review then a pass, the five-review stop and the reply
that allows one more, pause and resume during a review, and a restart.
`goal-tracker.test.ts` drives the checklist the same way: the first list, the
checks and what the next turn hears, a claim sent back twice then reviewed,
the user's additions and cancellations, the model Settings names, a tracker
answer without JSON, a tracker stuck on a pass, a goal finished by hand during
a pass, models read again after an account change, and a restart. The opt-in
`goal-tracker.live.test.ts` (`BOITE_E2E_CLAUDE=1`) runs one real goal on Haiku
with the checklist on Automatic. `auto-goal.test.ts` covers automatic goals:
the threshold and its edge, the experiment off, a command, a steer, a queued
prompt across a restart, `goal track` and its refusals, and the card claimed
after a passing review. UI unit tests cover `/goal2` in the slash menu,
the checklist model row on General, the goal bar's verdicts and checklist, the
Automatic goals switch and its threshold row, the "Automatic goal" label, and
the fake core's reviewer, tracker and automatic goals.
