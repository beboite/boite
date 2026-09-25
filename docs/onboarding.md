# The tour

Boite opens a seven-screen tour on a new owner device, six on a paired guest.
It waits for a connected core. Animated miniatures with SVG controls explain the features without
calling live providers, reading quotas or navigating away from the tour.

Nothing in it is a setting of its own. Every control writes through the same
function the Settings page writes through, so a choice made in the tour and one
made afterwards are the same choice, and coming back to Settings shows what the
tour set.

## The screens

| Screen | What it says | What it carries |
|---|---|---|
| Welcome | One conversation per task, and agents keep working meanwhile | Language and theme |
| Profile | Developer or not, asked plainly | Two answers, each writing a preset of existing settings |
| Conversation | The same history follows a change of agent | Selectable agent, dictation and diff demonstrations; inline local voice installation |
| Usage | A named provider, a five-hour limit, used percentage and reset time | An illustrated taskbar hover, no live account list |
| Reach | The host keeps working while the phone shows the same conversation | An animated desktop-to-phone illustration |
| Quiet | Agents work without taking over the screen or speakers | Notifications, close to tray, focus guard, mute |
| Privacy | The trade offer: anonymous counters, or the deal | Two consent rows that also close the tour, owner only |

The miniatures use the tour's language through the same strings, one markup per
scene, with the real provider marks and theme tokens. The reach scene draws the
same conversation as bars on a monitor and a phone rather than text to read.
Each scene plays in under four seconds, the two conversation demos in under five.
Three bordered icon buttons select the conversation demonstrations. Dictation
shows microphone activation, speech, then a draft to review; agent switching
shows the picker, a follow-up and the next agent's answer. Animations stop after their demonstration, can be paused and replayed,
and show the completed state under reduced motion. The dots are the only progress
indicator.

The privacy screen is Boite Legacy's: a title that turns red over ten seconds,
the trade offer clip, and two rows. "NO! Just the basic counters" keeps the
anonymous counters (or a saved opt-out on a replay), swaps to the refusal clip
and closes the tour two seconds later, at once under reduced motion. "Deal" turns
on enhanced analytics and closes it. The "turn everything off" link under both
rows saves Off and closes it. That screen has no Next button; Escape and the
cross leave the counters as they are. On a window under 640 px tall the clip
shrinks, and the line saying what is counted stays. Export and deletion
management remain in Settings.

In the shell the scrim starts under the title bar, so the window can be dragged,
minimized or closed during the tour.

## The window it opens in

The shell opens its main window at 1280 x 890, centred in the primary monitor's
work area, and at 92% of that area on a smaller screen (`centred` in
`apps/shell/src-tauri/src/lib.rs`). 890 is the tallest tour screen, the French
consent screen at 808 px, plus the scrim's margin and the title bar. A screen
that grows past it scrolls inside the panel; raise the constant with it.

Escape leaves, the cross leaves, Tab stays inside. The dots at the bottom walk
the screens and read as steps to a screen reader. Leaving at the first screen
counts as much as finishing the last one: the tour is not asked twice.

## The question

The second screen asks who is at the keyboard, in the user's words rather than
a feature list: "I'm not a developer! Don't confuse me with code and
commands!" or "I'm a developer, give me the works." The answer is a preset,
not a mode. It writes settings that already exist, and no component reads the
answer itself:

| | Not a developer | Developer |
|---|---|---|
| Composer chips pinned in the bar | none | effort and worktree |
| The app opens on | the drafts, `Documents/Boite` | the last project |
| An empty side panel opens on | Files | Changes |
| Permission mode | Ask, set once | left as it is |

`lib/work-prefs.svelte.ts` holds these per device, in `boite.work`. Picking an
answer writes it at once, so skipping the rest of the tour keeps it, and picking
the other one rewrites the whole preset. A draft still empty on screen moves
to where the answer starts.

Neither answer keeps work in one folder. New thread starts in the project on
screen with both, a project's own new thread starts there, and a draft's
project menu lists every project and "Open a folder". The drafts are where a
conversation waits until it has a folder, not the only folder a non-developer
gets.

Each piece changes on its own afterwards. On a computer the composer's Options
menu lists effort, speed and worktree with a pin beside each; a pinned option
gets its chip back in the bar. The permission mode never leaves the bar. An
option set away from its default (a worktree turned on, a non-default effort
or a speed) keeps its chip while it is set, pinned or not: a choice nobody can
see is a trap. Settings, Appearance, Workspace holds the starting point and
the panel's first surface.

A device with no record gets one the first time a core answers. A core that
already holds conversations, or a device that has already seen the tour, is an
install from before the question: everything stays pinned, the app keeps
opening on the last project, and the panel keeps its launcher. Anything else starts with the
calm bar and the drafts, the not-a-developer preset without its permission
change.

## Once per device

Closing it writes `boite.onboarding` in `localStorage`:

```json
{ "version": 6, "at": 1789660000000 }
```

The device that stores nothing, a browser refusing storage, sees the tour every
launch and forgets it every time, which is the right failure of the two.

`version` is the shape of the tour that was seen. Nothing re-opens on an
upgrade today; the number is what a later build would read to decide otherwise,
and a version it does not know still counts as seen.

Settings, General, Getting started brings it back, and so does "Replay the
tour" in the command palette. Neither forgets anything that was set.

`App.svelte` loads the component the first time the tour is due, the way it
loads the palette and the dialogs, so a device that has seen it never downloads
it again. Until it has loaded the tour holds no key: offline with a cold cache
the app stays usable and asks again on the next launch.

## In the end-to-end suite

Every browser profile the suite drives is new, so the tour would open over the
page each test clicks through. `tests/e2e/lib/cdp.ts` writes the record before
the page's first script runs, and reloads a WebView2 page it attaches to once
for the same reason. `BrowserPage.launch({ showTour: true })` leaves a profile
unseen; `tests/e2e/onboarding.test.ts` is the one test that asks for it.

The same file launches the browser with `--lang=en-US`, and the shell test
passes it to WebView2: the language setting defaults to `system`, and the
assertions are written in English whatever the machine speaks.

## The screens that read the core

Voice polls `speech.status` only while its example is selected. The owner can
start or cancel the local engine download there; no download starts without a
click. Selecting another example, leaving the step or closing the tour stops
polling, but a requested download continues in the core. The tour never requests
microphone access or sends a prompt. Privacy and the quiet switches use the
same host settings and shell command as Settings.

## Adding a screen

1. A key in `ORDER` and in `OnboardingStep`, in `lib/onboarding.ts`.
2. A block under `onboarding` in `lib/strings.en.ts`, with a `title` and at
   most one sentence, then the same block in `lib/strings.fr.ts`.
3. A branch in `Onboarding.svelte`, between the two it sits between.
4. `ONBOARDING_VERSION` up, since the tour changed shape.

The dots, the Back and Next buttons and the keyboard follow
from `steps()`. A screen that reads the core guards on `store.owner`: a paired
phone is refused those calls ([phone.md](phone.md)), and a screen offering a
button that answers nothing teaches the wrong thing.
