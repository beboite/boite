# The tour

Boite opens a tour the first time it runs on a device: nine owner screens, each one
carrying the switch or the button for what it explains, so reading it and
setting it up are the same pass. It waits for a core to be connected, because half its controls
would be dead against a connection that is not there.

Nothing in it is a setting of its own. Every control writes through the same
function the Settings page writes through, so a choice made in the tour and one
made afterwards are the same choice, and coming back to Settings shows what the
tour set.

## The screens

| Screen | What it says | What it carries |
|---|---|---|
| Welcome | One conversation per task, and agents keep working meanwhile | Language and theme |
| Privacy | Basic counters start enabled on new hosts; enhanced usage requires consent | The same telemetry controls as Settings, owner only |
| Agents | The model or the provider changes mid-thread, the history follows | A still of the composer's chip row |
| Voice | Press the microphone, read the text before it is sent | `speech.status`, then Voice settings when it is not set up |
| Panel | Changes, files, tasks and a browser, one key away | The four surfaces with their live chords, and Keyboard settings |
| Usage | One bar per subscription, with the hour it resets | One switch per account, `quotas.configure` |
| Reach | A phone pairs with a QR code, another Boite connects from this app | The LAN switch, and the two settings pages |
| Quiet | Its title only | Notifications, close to tray, focus guard, mute |
| Project | The folder an agent works in | The folder picker, or the count already open |

One sentence per screen, and a row is its label alone: the hint under a
switch stays on the Settings page it writes to. A reader keeps one idea per
screen and skims the rest, so the tour says what the feature is and where it
lives, never how it works.
Privacy keeps the consent details beside its switches so the owner can read
what each mode collects before opting in.

Escape leaves, the cross leaves, Tab stays inside. The dots at the bottom walk
the screens and read as steps to a screen reader. Leaving at the first screen
counts as much as finishing the last one: the tour is not asked twice.

## Once per device

Closing it writes `boite.onboarding` in `localStorage`:

```json
{ "version": 3, "at": 1789660000000 }
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

Voice asks `speech.status` and Usage asks `quotas.list`, each one when its
screen opens and never again, which is what the `untrack` around those readers
is for: both write the state they guard on, so a tracked read would have the
effect answer itself for ever.

Voice says "ready to dictate" or offers the Voice settings tab, rather than
describing a feature that may want a 200 MB download first. Panel prints the
chord each surface has today, read from `store.keyLabel`, so a chord moved in
`keybindings.json` shows moved here too.

## Adding a screen

1. A key in `ORDER` and in `OnboardingStep`, in `lib/onboarding.ts`.
2. A block under `onboarding` in `lib/strings.en.ts`, with a `title` and at
   most one sentence, then the same block in `lib/strings.fr.ts`.
3. A branch in `Onboarding.svelte`, between the two it sits between.
4. `ONBOARDING_VERSION` up, since the tour changed shape.

The header count, the dots, the Back and Next buttons and the keyboard follow
from `steps()`. A screen that reads the core guards on `store.owner`: a paired
phone is refused those calls ([phone.md](phone.md)), and a screen offering a
button that answers nothing teaches the wrong thing.
