# Pointer interactions

Two interactions that `lib/interactions.ts` starts once the app has mounted.
Both left the Experiments page on 2026-10-24.

## Edge scrollbars

Settings, Appearance, **Edge scrollbars** is on by default on a desktop.

Native scrollbars take no room, and gutters reserved for them collapse, so
the width they held goes back to the content. One overlay draws a thumb for each scroll
container under the mouse, on the edge the pointer approaches: the right edge for vertical
scrolling, the bottom edge for horizontal. It is invisible beyond 128 px from
that edge and fades in along a smoothstep to full opacity at 20 px. A thumb
is 32 px long at least, follows wheel, keyboard and scripted scrolling while
shown, and drags like a native one. Leaving the window hides every thumb.

Thumbs live in two overlays. A container outside the top layer draws in a
fixed layer under it, so an open menu covers that container's thumb as it
covers the container. A list inside a menu or dialog draws in a manual popover,
shown again above each menu that opens, and skips a thumb that a menu opened
after its own would cover. A press on a thumb is
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

Always on, with no switch.

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
by a press. Settings and the Bots page load their code on the press.

Elements opt in with `data-preload-thread="<thread id>"` or
`data-preload-view="settings" | "agents"`; one capture listener on the window
reads them, so a sidebar row costs nothing to mark. The owning machine is the
nearest `data-machine-id`, else the active one. Thread rows, the spawn marker,
the parent title in a subagent's header, the resources page, workflow steps and
the agents panel's subagent rows are marked. On a data saver or a slow-2G, 2G or 3G
link, touch presses wait for their click; the mouse keeps preloading. A row of
a machine that is no longer connected preloads nothing, and a press whose
page was refused leaves the click to ask again.

It stays off whenever `navigator.webdriver` is true, so Playwright, the end-to-end
harness (`tests/e2e/lib/cdp.ts` marks every page it launches) and other
driven browsers measure the plain click. Its own test opts in with
`window.__BOITE_PRESS_PRELOAD_TEST__`.

## Verification

`edge-scrollbars.test.ts` (end to end, desktop 1280x900) checks that the
timeline takes its gutters' width back with its column still under the
composer's centre, no thumb mid-chat, rising opacity toward the edge, a mouse drag that
scrolls, a menu over the edge that covers the timeline's thumb while its own
list gets one on top, every thumb gone on leaving the window, and the native bar back when
the switch goes off; headless Linux Chrome reports no mouse, so the test
answers the one gate query as a desktop would. The unit test of the same name
covers the opacity ramp, thumb geometry, the pointer and forced-colors gate and
listener cleanup. `store-preload.test.ts` checks that the click takes over the
press with one subscribe, that a turn streamed during the press is on screen,
that a released press unsubscribes, and that the agents panel's subscription
survives. `press-preload.test.ts` (end to end) measures the gain and covers a
press dragged away.
