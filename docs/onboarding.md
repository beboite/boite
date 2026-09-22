# The tour

Boite opens a six-screen tour on a new owner device, five on a paired guest.
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
| Conversation | The same history follows a change of agent | Selectable agent, dictation and diff demonstrations; inline local voice installation |
| Usage | A named provider, a five-hour limit, used percentage and reset time | An illustrated taskbar hover, no live account list |
| Reach | The host keeps working while the phone shows the same conversation | An animated desktop-to-phone illustration |
| Quiet | Agents work without taking over the screen or speakers | Notifications, close to tray, focus guard, mute |
| Privacy | Messages and files stay out of analytics | Two concise consent switches and the final welcome, owner only |

The miniatures use responsive English text, the real provider marks and theme tokens.
Tour instructions, animation controls and accessible descriptions stay localized.
Three bordered icon buttons select the conversation demonstrations. Dictation
shows microphone activation, speech, then a draft to review; agent switching
shows the picker, a follow-up and the next agent's answer. Animations stop after their demonstration, can be paused and replayed,
and show the completed state under reduced motion. The dots are the only progress
indicator. Export and deletion management remain in Settings. Pending deletion
does not prevent a fresh opt-in or leaving the consent screen.

Escape leaves, the cross leaves, Tab stays inside. The dots at the bottom walk
the screens and read as steps to a screen reader. Leaving at the first screen
counts as much as finishing the last one: the tour is not asked twice.

## Once per device

Closing it writes `boite.onboarding` in `localStorage`:

```json
{ "version": 4, "at": 1789660000000 }
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
