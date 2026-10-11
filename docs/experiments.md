# Experiments

Enable these separately in Settings > Experiments. Switches are off by default
and belong to this client device. They do not change another machine's settings.
A phone has its own Experiments row under Settings, This phone.

A finished experiment leaves this page: it turns on by default and its switch
moves to the Settings page it belongs to, as [chat files and previews](chat-files.md)
did. The agent's browser needs no switch: it runs on the machine of the
conversation ([the agent's browser](browser.md)).

## Open chat links

`open-chat-links` enables the same rich link parsing as
[Chat files and previews](chat-files.md): Markdown file links, bare web URLs,
absolute paths, `file:///` links and paths inside inline code. Either switch
enables this parsing; enabling both adds no further link types.

On the owning local desktop, this switch also makes an explicit click open a
file or folder in its associated application, including Windows shortcuts and
absolute paths outside the checkout. On a remote machine or phone, links still
use the inline preview and its existing owner and working-directory checks.
They never open a file on the device displaying the conversation.

Pages in the integrated browser and agent RPCs cannot invoke the native action.
Network and device paths are refused before and after path resolution.

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


## Resident agents

The Agents page ([agents](agents.md)) and every button that leads there: the
Threads and Agents switch at the top of the sidebar, the phone menu entry, the command palette row and the link from an agent's
own thread. Turning
the switch off closes the page if it is open. It hides the page only: agents
already made keep their routines and missions on the core, which knows nothing
of a client's experiments.

## Preview comments

Open a Browser tab in the integrated panel and choose Reference an element.
Clicking an element inserts an `@element` mention at the cursor in the
existing composer. Write around it and send normally. Draft text,
attachments and queued messages stay intact. On a phone-sized window, selection
returns to the composer. There is no separate comment form.

References stay inline with the text, in the accent color, in drafts and sent
messages. Editing a mention removes its element association. Click
one to reopen its thread's browser and highlight the element. A closed tab is
reopened at the captured URL; a surviving tab that changed pages is refused.
Missing elements and inaccessible pages report errors. Open shadow roots are
supported, including sibling elements within them. The highlight follows scroll
and resize for three seconds. Existing references remain clickable with the
experiment switched off.

Each message carries up to eight typed references. The core validates the URL,
mention positions, selector, shadow-root path, selected text and viewport bounds, then supplies
them as labeled untrusted context to every agent. The visible message keeps
only the user's prose and inline mentions. References survive queued sends,
failed sends, idempotent retries and prompt recall. Stashing a referenced draft
or sending it with `/goal` or `/loop` is refused explicitly, preserving the draft.

Escape cancels selection. Switching off the experiment or leaving the surface
cancels the picker. Desktop child webviews support selection across origins.
The iframe test bridge only inspects accessible same-origin documents and
reports inaccessible pages explicitly. Selected page content is untrusted data;
it never grants the page access to host commands. This version does not attach
a screenshot to the reference.

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

Reviewers are not subagents. Like workflow steps, they need no enabled team, a
paused team holds them, and their answer goes to the goal, never to the parent
as mail. They are not listed in the Subagents tab. Pausing, removing or
completing the goal by hand stops the running reviewer, and resuming a goal
paused during its review starts a new review. A core restart keeps the
verdicts and drops the interrupted review; the resume starts a fresh one.

This version does not run checks itself before the review: the reviewer runs
them and spends tokens doing so. It has no token budget and no detection of
the same finding repeated: the five-review stop bounds a goal instead.

## Verification

`artifacts.test.ts` covers publication, path boundaries and byte preservation in
the core. The end-to-end tests `artifacts.test.ts` and
`preview-comments.test.ts` cover desktop and phone-sized interfaces. Preview
unit tests cover owning-machine boundaries and selection validation.
No live provider login is required.

`goal-review.test.ts` drives reviewed goals through the real core with the
echo driver: a failed review then a pass, the five-review stop and the reply
that allows one more, pause and resume during a review, and a restart. UI unit
tests cover the `/goal2` switch, the goal bar's verdicts and the fake core's
reviewer.

`whip.test.ts` covers the toggle, persistence, desktop and phone layout, drop and rethrow, whole
interface movement, rope drawing and release, cancellation and reduced motion. `shell.test.ts` verifies
native window movement and restoration, and refusal from a browser child webview.

The opt-in `codex.live.test.ts` attachment case asks a real Codex process to
discover file publication through `boite --help`. It checks the inherited CLI,
delivery during the active turn, and unchanged bytes after deleting the source.
It requires `BOITE_E2E_CODEX=1` and uses the default Codex login.
