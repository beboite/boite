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

## Edge scrollbars

Native scrollbars take no room, and gutters reserved for them collapse, so
the width they held goes back to the content. One overlay draws a thumb for each scroll
container under the mouse, on the edge the pointer approaches: the right edge for vertical
scrolling, the bottom edge for horizontal. It is invisible beyond 128 px from
that edge and fades in along a smoothstep to full opacity at 20 px. A thumb
is 32 px long at least, follows wheel, keyboard and scripted scrolling while
shown, and drags like a native one. Leaving the window hides every thumb.

The overlay is a manual popover in the top layer, shown again above each menu
that opens, so lists inside menus get a thumb too. A press on a thumb is
replayed on its scroll container, the target a native scrollbar press has: a
menu stays open while its own list is dragged and closes on a press on the
chat's thumb, as before. Only a thumb at 5% opacity or more takes the pointer;
text and controls under the rest of the overlay stay reachable.

It runs only while `(hover: hover) and (pointer: fine)` matches and
`forced-colors: active` does not, and follows both as they change. Phones and
touch-only screens keep their own overlay scrollbars, and high contrast keeps
the native ones. Cost: one passive `pointermove` listener coalesced to one
animation frame, computed overflow cached per element, layout read only for the
containers on the pointer's path, and scroll and wheel listeners only while a
thumb shows. Turning it off removes the class, the overlay and every listener.

## Load on press

A thread starts opening when its row is pressed, before the click. A mouse
button stays down 60 to 120 ms, a finger longer, which on a remote machine is
most of the round trip the click used to wait for. The press asks for the page
the open would ask for, with the subscription, through the same request
builder (`store/thread-preload.ts`). On a core with bundled snapshots it sends
`open: { requests: false }`: the thread on screen stays subscribed and nothing
is marked read until the click. The open that follows takes the page over
instead of asking again, then leaves the previous thread and marks this one
read itself. Events that arrive between the page and the click
patch that page, so nothing streamed during the press is lost. Permission and
question cards are still read by the open itself. A request settled during the
press cannot come back.

A press that never becomes a click gives the subscription back: a drag, a
release elsewhere after a 400 ms grace, a scroll that takes over the finger
(`pointercancel`), or a hold longer than eight seconds. A newer press releases
the older one. Pressing the thread already on screen asks for nothing, and a
subscription held by the open thread or the agents panel is never given back
by a press. Settings and the Agents page load their code on the press.

Elements opt in with `data-preload-thread="<thread id>"` or
`data-preload-view="settings" | "agents"`; one capture listener on the window
reads them, so a sidebar row costs nothing to mark. The owning machine is the
nearest `data-machine-id`, else the active one. Thread rows, the spawn marker,
the parent chip, the resources page, workflow steps and the agents panel's
"Open thread" are marked. On a data saver or a slow-2G, 2G or 3G
link, touch presses wait for their click; the mouse keeps preloading. A row of
a machine that is no longer connected preloads nothing, and a press whose
page was refused leaves the click to ask again.

It stays off whenever `navigator.webdriver` is true, so Playwright and other
driven browsers measure the plain click even on a profile with the switch on.
Benchmarks start fresh profiles with every experiment off. Its own test
opts in with `window.__BOITE_PRESS_PRELOAD_TEST__`.

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

`edge-scrollbars.test.ts` (end to end, desktop 1280x900) checks that the
timeline takes its gutters' width back with its column still under the
composer's centre, no thumb mid-chat, rising opacity toward the edge, a mouse drag that
scrolls, every thumb gone on leaving the window, and the native bar back when
the switch goes off; headless Linux Chrome reports no mouse, so the test
answers the one gate query as a desktop would. The unit test of the same name
covers the opacity ramp, thumb geometry, the pointer and forced-colors gate and
listener cleanup. `store-preload.test.ts` checks that the click takes over the
press with one subscribe, that a turn streamed during the press is on screen,
that a released press unsubscribes, and that the agents panel's subscription
survives. `press-preload.test.ts` (end to end) measures the gain and covers a
press dragged away.
