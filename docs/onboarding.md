# The tour

Boite opens a seven-screen tour on a new owner device, six on a paired guest,
and two on a phone ([below](#on-a-phone)).
It waits for a connected core. Animated miniatures with SVG controls explain the features without
calling live providers, reading quotas or navigating away from the tour.

Tour controls use the same settings functions as the Settings page. Choices
persist immediately and remain editable there.

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

Localized miniatures use real provider marks and theme tokens. Scenes finish
within four seconds, conversation demos within five. Their three buttons show
dictation, agent switching and diffs. Dictation ends with a draft to review;
switching shows the next provider's answer. While playing, a scene has an inner
accent glow and hover/focus pause/replay controls; touch always shows controls.
Pause retains them, completion leaves Replay, and reduced motion shows only the
completed scene. Step dots provide progress.

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

## On a phone

A browser opened below 720 px shows two screens for owners and paired devices:
Welcome selects language and theme; Reach explains execution on the computer
and links notifications and installation to Settings. It does not change the
host's profile, permissions, resource limits, focus, audio or analytics consent.

`onPhone()` in `lib/onboarding.ts` selects the layout when the tour opens.
Resizing keeps that choice. The desktop shell always shows its full tour.

## The window it opens in

The tour is a 600 x 600 panel. Every screen fits it in English and French,
the conversation demonstrations included, and the end-to-end suite fails a
screen that scrolls on a computer. A window shorter than the panel shrinks it,
and the screen then scrolls inside it. Every screen takes that same height, so
Next stays in one place from screen to screen. The privacy clip sits beside the
text saying what is counted, and above it in a panel narrower than 480 px.

The shell opens its main window at 70% of the primary monitor's work area in
width and 80% in height, kept between 1200 x 720 and 1600 x 1000 and centred
(`centred` in `apps/shell/src-tauri/src/window.rs`). A 1920 x 1080 screen gets
1344 x 826 and a 2560 x 1440 one 1600 x 1000. On a screen too small for the
floor the window takes 92% of the work area. The 720 floor holds the panel, the
scrim's margins and the 44 px title bar.

The scrim uses a flat tint. [Frame measurements](../bench/results/2026-09-30-ui-frames.md)
record the cost of window-wide blur in the animated scenes.

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
| The app opens on | the drafts, `Documents/Boite` | the last project |
| An empty side panel opens on | Files | Changes |
| Buttons | Essentials: no terminal button, no Trace card | Everything |
| Permission mode | Ask, set once | left as it is |

`lib/work-prefs.svelte.ts` holds these per device, in `boite.work`. Picking an
answer writes it at once, so skipping the rest of the tour keeps it, and picking
the other one rewrites the whole preset. A draft still empty on screen moves
to where the answer starts.

Both presets create new threads in the selected project. A draft's menu still
includes every project and Open a folder. [Drafts](drafts.md) owns the default
Documents directory and conversation-folder rules.

Each piece changes on its own afterwards. Settings, Appearance, Workspace holds
the starting point and the panel's first surface.

Settings, Appearance, Buttons lists every optional button by where it sits:
the thread header (project name, branch, context gauge, Agents, terminal), the
sidebar (limits, Add a project) and the side panel's cards. Each has a switch,
and the Essentials and Everything presets set them all at once; a device whose
buttons match neither lights neither. A button's right click offers Hide this
button and Choose the buttons, which opens that card. Hiding a button takes it
off the screen and nothing else: the palette and the chords still reach what it
opens, an open tab stays, and a hidden context gauge comes back by itself once
the context is 90 percent full. The list is `hidden` in `boite.work`, so a
button added later shows until someone hides it, and a record from before it
had one reads its old developer switch: off hides the terminal and the Trace
card. A paired device has no terminal or Add a project to hide.

Composer chips remain visible: on a computer the reasoning, the permission mode and, on a draft
in a git project, the worktree are always in the bar, and the model's fast mode
sits at the top left of the reasoning slider.

A device with no record gets one the first time a core answers. A core that
already holds conversations, or a device that has already seen the tour, is an
install from before the question: the app keeps opening on the last project,
and the panel keeps its launcher. Anything else starts with the drafts, the
not-a-developer preset without its permission change.

## Once per device

Closing it writes `boite.onboarding` in `localStorage`:

```json
{ "version": 7, "at": 1789660000000 }
```

A browser that refuses storage shows the tour on every launch.

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
phone is refused those calls ([phone.md](phone.md)), and owner-only controls must be hidden.
