# The tour

Boite opens a tour the first time it runs on a device: seven owner screens, each one
carrying the switch for what it explains, so reading it and setting it up are
the same pass. It waits for a core to be connected, because half its controls
would be dead against a connection that is not there.

Nothing in it is a setting of its own. Every control writes through the same
function the Settings page writes through, so a choice made in the tour and one
made afterwards are the same choice, and coming back to Settings shows what the
tour set.

## The screens

| Screen | What it says | What it carries |
|---|---|---|
| Welcome | What Boite is, and that agents run on the machine hosting the core | Language and theme |
| Privacy | Basic counters start enabled on new hosts; enhanced usage requires consent | The same telemetry controls as Settings, owner only |
| Agents | The model changes in the middle of a thread, and the history stays | A still of the composer's chip row |
| Usage | Providers report what is left of a subscription, drawn as bars | One switch per account, `quotas.configure` |
| Reach | A phone pairs with a key of its own, and another Boite connects beside this one | The LAN switch, and the two settings pages |
| Quiet | Boite is built to run while you work on something else | Notifications, close to tray, focus guard, mute |
| Project | A project is the folder an agent works in | The folder picker, or the count already open |

Escape leaves, the cross leaves, Tab stays inside. The dots at the bottom walk
the screens and read as steps to a screen reader. Leaving at the first screen
counts as much as finishing the last one: the tour is not asked twice.

## Once per device

Closing it writes `boite.onboarding` in `localStorage`:

```json
{ "version": 2, "at": 1789660000000 }
```

The device that stores nothing, a browser refusing storage, sees the tour every
launch and forgets it every time, which is the right failure of the two.

`version` is the shape of the tour that was seen. Nothing re-opens on an
upgrade today; the number is what a later build would read to decide otherwise,
and a version it does not know still counts as seen.

Settings, General, Getting started brings it back, and so does "Replay the
tour" in the command palette. Neither forgets anything that was set.

## The voice screen

An eighth screen, dictation, is written and translated and does not show:
`VOICE_STEP` in `packages/ui/src/lib/onboarding.ts` is `false` while that
feature is built on its own branch. Turning it to `true` puts the screen in the
order, in both languages, and the only other thing it needs is its button
pointing at the Voice settings tab that branch adds.

## Adding a screen

1. A key in `ORDER` and in `OnboardingStep`, in `lib/onboarding.ts`.
2. A block under `onboarding` in `lib/strings.en.ts`, with a `title`, then the
   same block in `lib/strings.fr.ts`.
3. A branch in `Onboarding.svelte`, between the two it sits between.

The header count, the dots, the Back and Next buttons and the keyboard follow
from `steps()`. A screen that reads the core guards on `store.owner`: a paired
phone is refused those calls ([phone.md](phone.md)), and a screen offering a
button that answers nothing teaches the wrong thing.
