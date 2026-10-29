# Experiments

Enable these separately in Settings > Experiments. The client switches are
off by default and belong to this device. They do not change a core's settings.
A phone has its own Experiments row under Settings, This phone.

A phone or a browser starts with the switches of the desktop app on its primary
machine, and changes when that app does. The core answers each app's report
(`client.preferences`) with the desktop app's experiments and announces their
changes (`client.desktopExperiments`); a desktop app on the machine's loopback
outranks one reached from elsewhere. Only an app on the owner's own token
counts: a paired device that calls itself a desktop app is not followed. The
core keeps them in memory, and the phone keeps the last set in
`boite.experiments.desktop`, with the id of the core that named it, so a reload
starts with it. A core that has heard no desktop app yet leaves that set in
place if it named it, and clears it if another machine did. Flipping a switch on the phone, from the page or from an agent's
card, keeps what it showed, with that flip, as its own (`boite.experiments`,
`boite.experiments.follow` set to `off`). "Same as the computer" at the top of
the phone's page follows the desktop app again. The desktop app follows no one.

A finished experiment leaves this page and its switch moves to the Settings
page it belongs to, on by default unless it changes what a familiar click does, as [chat files and previews](chat-files.md),
[open chat links](chat-files.md#open-chat-links-in-their-apps),
[preview comments](panel.md#preview-comments) and the
[pointer interactions](interactions.md) did. The agent's browser needs no switch: it runs on the machine of the
conversation ([the agent's browser](browser.md)).

## Other client switches

`EXPERIMENT_IDS` in `packages/contracts/src/setting-requests.ts` lists the
client switches; `lib/experiment-copy.ts` supplies their labels.

| Switch | What it adds |
| --- | --- |
| Grain theme (`theme-grain`) | A grain theme choice in Appearance. Disabling the experiment uses the system theme while preserving the saved choice. |
| Claude Code session import (`session-import`) | Import a terminal conversation from the project menu or palette; see [session import](imports.md). |
| Prompt cache timer (`prompt-cache`) | An idle-thread countdown based on reported writes or documented estimates; see [prompt cache](prompt-cache.md). |
| Show actions in recordings (`recording-indicators`) | Click markers and navigation keys in native browser recordings. Typed text and password input are not shown as key labels. |
| Pinned model quotas (`pinned-quotas`) | Pin the current model provider's limits in a conversation corner or below the thread list; see [placement and behavior](development.md#ui-spacing-and-motion). |

The page also has three owner-only core settings, separate from those client
switches: [Keep the prompt cache warm](prompt-cache.md#keeping-the-cache-warm)
(`cacheKeepalive`), [Background compaction](context.md#background-compaction)
(`backgroundCompaction`) and [Device live stream](devices.md#live-stream)
(`deviceStream`). They change execution on the machine picked in the bar
above them, which starts on the window's machine, and affect its clients;
none follows the desktop's experiment preferences. A thread takes the switch
of the machine it runs on: flipped for the desktop's own core, background
compaction does nothing for a thread on a server.

## Whip

A small Whip icon sits beside the other controls in the sidebar footer and
phone navigation. Throw it to pick up the animated rope from Boite Legacy:
it follows the pointer, cracks on a fast flick, and falls off screen on a click.
On a phone, drag the rope with a finger and release to drop it. Escape also drops it.
The footer control remains available to drop or rethrow while the previous rope falls.
After release, Escape resumes its usual app action.
The opening arc uses unstretched links and fits the available side of the screen.
The physics and canvas load only when the experiment is enabled; the animation
loop and audio context close when it is turned off.

A crack plays one of six recorded cracks from Boite Legacy's sprite, with a
synthesized burst as the fallback, and shakes the native Boite window before
returning it to its original position. Throwing the rope does neither. Maximized and fullscreen windows, browsers, phones and window managers
that ignore positioning shake the interface instead. Hits do not overlap.
Reduced motion disables new throws and stops any visible rope.


## Bots

The Bots page ([bots](bots.md)) and every button that leads there: the
Threads and Bots switch at the top of the sidebar, the phone's Bots tab, the command palette row and the link from a bot's
own thread. Turning
the switch off closes the page if it is open. It hides the page only: bots
already made keep their threads and routines on the core, which knows nothing
of a client's experiments.

## Contacts

The contacts column and the Contacts page ([contacts](contacts.md)). On a
desktop window the contacts stand in a column on the right edge, the thread
list keeping the left one: one row per contact with its link and what it asks.
Its title, with a house, opens the Contacts page with no contact picked, and
Add beside it the same page. A row opens that contact's page in the chat's
card, between the two lists. The column starts folded: the Contacts button at
the right end of the title bar unfolds and folds it, remembered on the device,
and shows a dot while a folded column hides a request. It slides in when
unfolded, not when the app starts or another machine is picked. The right panel leaves the column its width. A phone
has no right edge: its list shows the contacts as a section under the
projects, and the Contacts tab in the bottom navigation opens the page with no contact picked.

A contact's page shows what it asks, the projects each side shares with the
other with their read switch, then trust, the eight check words and Remove. With
no contact picked, the page lists the requests waiting for an answer, with
Accept on a picked project and Refuse with a reason; decided ones fold under a
count that says who decided. Invite makes a one-use link, copies it and says
whether Tailscale shared the machine or why it could not; Join takes a pasted
link and shows the eight words to compare. The Tailscale row says the policy
state; Configure unfolds the API key (stored or cleared, never shown back), the
policy lines to paste when it is open, and the weakest model tier a contact's
request may run on.

In a thread, a letter the core labelled with a contact shows that contact's
name in a dashed "remote" chip beside the sender. The chip is drawn whatever
the switch says: the label comes from the core. Turning the switch off closes
the Contacts page if it is open; contacts, grants and requests stay on the core.

## Reviewed goals

`goal2` adds `/goal2 <objective>` to the composer and its slash menu. With the
switch off, `/goal2` goes to the agent as typed. The switch belongs to the
client; the core accepts `goal: { objective, review: true }` from any client
(`threads.activity.set`).

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

### The checklist

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

The tracker runs on `Settings.goalTracker`, picked under the switch in
Settings, Experiments: a provider, a model and its reasoning level, stored by
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
with the checklist on Automatic. UI unit tests cover the `/goal2` switch,
the checklist model row, the goal bar's verdicts and checklist, and the fake
core's reviewer and tracker.

`whip.test.ts` covers the toggle, persistence, desktop and phone layout, drop and rethrow, whole
interface movement, rope drawing and release, cancellation and reduced motion. `shell.test.ts` verifies
native window movement and restoration, and refusal from a browser child webview.

The opt-in `codex.live.test.ts` attachment case asks a real Codex process to
discover file publication through `boite --help`. It checks the inherited CLI,
delivery during the active turn, and unchanged bytes after deleting the source.
It requires `BOITE_E2E_CODEX=1` and uses the default Codex login.

`fake-client.contacts.test.ts` covers the in-memory core's contacts: the seed,
the `contacts.updated` event after each change, the refusals with their field,
the invitation's share with and without a key, and `collaboration.ask`.
`HomePage.test.ts` renames, trusts and opens a project for reading on the seeded
contact, accepts a request through the menu, refuses one only with a reason,
removes the contact behind the confirm, creates and joins an invitation, clears
the key and moves the tier. `AgentDiscussion.svelte.test.ts` checks the remote chip.
