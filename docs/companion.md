# Desktop companion

An experiment (Settings, Experiments, "Desktop companion") that puts a small
character at the top of a screen in the desktop app. It shows the state of
the agents at a glance, lets the user answer their permissions and questions
without opening Boite, and answers requests of its own: the user can ask it
something, or ask it to act on the computer (open an app or a page, play
music, launch a game).

Only the desktop shell shows it. A browser or a phone with the experiment on
shows the Settings page, which says that the companion runs in the desktop app.

## Pieces

| Piece | Where |
| --- | --- |
| Window: transparent, always on top, click-through outside the drawn areas | `apps/shell/src-tauri/src/companion_window.rs` |
| Media session (Spotify first): read and control | `apps/shell/src-tauri/src/platform/media.rs` |
| Page, mounted for `index.html?view=companion` | `packages/ui/src/CompanionApp.svelte` |
| Character, panel, music pill | `packages/ui/src/components/companion/` |
| Settings, Companion | `packages/ui/src/components/CompanionSettings.svelte` |
| Preferences, mood, brain, wording, shell calls | `packages/ui/src/lib/companion/` |

The main window opens the companion's window while the experiment is on and
closes it when it is switched off (`lib/companion/follow.svelte.ts`).

## Window

`companion_window.rs` builds a 440 × 600 webview with no frame, no shadow
and no taskbar entry, labelled `companion`. It is placed on the top edge of the
work area of the chosen screen, on the left, in the centre or on the right.
A screen that is no longer connected falls back to the primary screen.

The window ignores the mouse except over the areas the page reports
(`companion_hit_rects`, from the elements marked `data-hit`). A thread polls
the cursor every 40 ms and switches `set_ignore_cursor_events`; it emits
`companion://hover` when the pointer enters or leaves those areas, since a
click-through window cannot see the pointer leave. A mouse button pressed
outside them goes to another application; the thread emits
`companion://outside`, and the page closes its panel unless "Close when
clicking elsewhere" is off. Once a second the thread lifts the window back to
the top of the topmost band (`platform::keep_on_top`): Tao applies
`always_on_top` only when its own flag changes, so a window opened later would
otherwise stay over it.

Its capability (`capabilities/companion.json`, `allow-companion-ui`) allows
reaching the core, placing itself, reading and controlling media, and bringing
the main window forward on a thread or on its settings
(`companion_show_main`). It cannot open or close itself, open browsers, read
cookies, save files, notify or quit; `acl.rs` tests this.

## Preferences

They are this computer's, in `localStorage` under `boite.companion`, like the
experiments: screen, position, agent, account, model, effort, control mode,
music, closing on an outside click, and the id of the conversation. Both webviews share the origin, so the
companion follows a change from Settings through the `storage` event.

Changing the agent, account, model, effort or control mode clears the
conversation: a thread keeps the agent and the permission mode it was made
with, so the next request starts a new one.

## Brain

The companion talks through an ordinary thread, titled "Companion", in the
drafts project. It runs like any other thread, on the chosen account, so the
core's subscription proxy (Douane) and the usual permissions apply. Nothing
is added to the core or to the RPC.

- Automatic takes the first agent that is on, present and signed in, on the
  small model titles are written with when the agent lists it, otherwise on
  the agent's default. A chosen agent that is off or signed out is reported,
  not replaced.
- "Ask before acting" creates the thread in the `default` permission mode:
  every command waits for Allow or Deny, which the companion's panel shows.
  "Act without asking" uses `bypassPermissions`.
- The UI cannot write an instructions file for the agent, so the role
  (`COMPANION_ROLE` in `brain.ts`) goes in front of the first request of a
  conversation. It asks for short plain-text answers in the user's language
  and gives the Windows recipes: `Start-Process`, `Get-StartApps`, Steam's
  `steam://rungameid/`, Spotify URIs and the media keys.

The reply bubble streams the text parts of the agent's messages from
`message.started`, `message.delta` and `message.part` on the subscribed
thread; reasoning and tool input are left out. The turn ends when the thread
leaves `queued`, `running` or `waiting`.

## Mood

`mood.ts` reads the threads, permissions and questions. The moods, in order
of priority, are:

1. worried: the core is out of reach;
2. calling: an agent is blocked on the user;
3. happy: a thread has just finished;
4. working;
5. idle.

The companion sweats when three or more threads are at work. Events other
than `thread.*` reach only subscribed threads, so the page reads the lists
again shortly after each `thread.updated` and every 15 seconds. The panel
opens by itself when a new blocking request appears, and closes again once
nothing waits, if it was the one that opened it.

## Music

With "React to music" on, the page reads the system media session every 2
seconds. While something plays, the character wears headphones, and the pill
with previous, play or pause and next appears when the pointer is on the
companion. Other systems than Windows report no session.

## Checks

- `cargo test --lib` in `apps/shell/src-tauri`: hit test, placement and ACL.
- `packages/ui/src/lib/companion/companion.test.ts`: preferences, mood, brain
  choice and wording.
- Captures: `?view=companion&fake=1` on the dev UI at 440 × 600, and Settings,
  Companion at desktop width.
