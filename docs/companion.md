# Desktop companion

An experiment (Settings, Experiments, "Desktop companion") that puts a small
character on a screen in the desktop app. It shows the state of the agents at
a glance, lets the user answer their permissions and questions without
opening Boite, and answers requests of its own: the user can ask it
something, show it the screen, or ask it to act on the computer (open an app
or a page, play music, launch a game). It keeps a memory of the user, rings
the reminders it is asked for and says when another conversation finished.

Only the desktop shell shows it. A browser or a phone with the experiment on
shows the Settings page, which says that the companion runs in the desktop app.

## Pieces

| Piece | Where |
| --- | --- |
| Window: transparent, always on top, click-through outside the drawn areas | `apps/shell/src-tauri/src/companion_window.rs` |
| Full-screen app in front, last input, screen capture, global shortcut | `apps/shell/src-tauri/src/platform/desktop.rs` |
| Media session (Spotify first): read and control | `apps/shell/src-tauri/src/platform/media.rs` |
| Page, mounted for `index.html?view=companion` | `packages/ui/src/CompanionApp.svelte` |
| Character, ask bar, panel, notices, music pill, memory card | `packages/ui/src/components/companion/` |
| Settings, Companion | `packages/ui/src/components/CompanionSettings.svelte` |
| Preferences, mood, brain, conversation, senses, notices, memory, directives, screen, sounds, shell calls | `packages/ui/src/lib/companion/` |

The main window opens the companion's window while the experiment is on and
closes it when it is switched off (`lib/companion/follow.svelte.ts`).

## Window

`companion_window.rs` builds a 440 × 600 webview with no frame, no shadow
and no taskbar entry, labelled `companion`. It is placed on the top edge of the
work area of the chosen screen, on the left, in the centre or on the right,
or where the user dropped the character. A screen that is no longer connected
falls back to the primary screen.

Dragging the character moves the window (`companion_drag`: `start_dragging`,
then the shell waits for the button to come up). The shell reads where the
character's centre landed, as fractions of that screen's work area, and the
page stores it as the `free` position with its screen. A drop opens towards the
middle of the screen: the side third it is in sets the alignment, the half the
edge (`spot_layout`). Near the bottom, the page stacks its blocks upwards. The
page's paddings put the character's centre where `CHARACTER_TOP`,
`CHARACTER_BOTTOM` and `CHARACTER_SIDE` say, so a drop lands where it was let
go, kept inside the work area.

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

The same thread tells the page what goes on around it:

- `companion://cursor`: where the pointer is, in the page's pixels, for the
  eyes to follow;
- `companion://typing`: input came while the pointer stood still with no
  button down (`GetLastInputInfo`). Which key never reaches the shell;
- `companion://away`: no input for five minutes. The character sleeps then,
  and at night (23:00 to 7:00) after a minute without a sign of the user;
- `companion://fullscreen`: with "Hide during full-screen apps" on, the window
  hides while the window in front covers its screen (desktop and taskbar
  excepted), and comes back after. Only the change counts, so the shortcut
  can call the companion over a game.

`companion_configure` sets that option and the global shortcut
(`RegisterHotKey` on a thread of its own, `MOD_NOREPEAT`). The shortcut shows
the window, focuses it and emits `companion://summon`; the page opens its
panel with the field focused. A shortcut another app holds is refused, and
the page writes that to `boite.companion.status` for Settings to show.

`companion_capture` takes a screen, or a part of one, without the companion
(`SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE` while it copies),
scaled to 1568 px on the long side, and returns it as raw BGRA bytes behind an
8-byte size header. It takes the screen named `monitor`, the window's own
screen without one, or `area`, a rectangle of the window in CSS pixels. The
page makes a JPEG of each under the core's attachment limits (`screen.ts`).

`companion_cover` stretches the window over the screen under the pointer,
taskbar included, while the user picks the part to show; the window then
takes every click. With no button down, the cover follows the pointer to
another screen. Uncovering leaves the window where it is: the page places it
again.

Its capability (`capabilities/companion.json`, `allow-companion-ui`) allows
reaching the core, placing and dragging itself, its shortcut and full-screen
option, capturing and covering the screens, reading and controlling media, and
bringing the main window forward on a thread or on its settings
(`companion_show_main`).
It cannot open or close itself, open browsers, read cookies, save files,
notify or quit; `acl.rs` tests this.

## Preferences

They are this computer's, in `localStorage` under `boite.companion`, like the
experiments: screen, position and drop spot, hiding for full-screen apps, the
shortcut (one of `COMPANION_HOTKEYS`, or none), sounds, agent, account,
model, effort, control mode, music, closing on an outside click, and the id
of the conversation. Both webviews share the origin, so the companion follows
a change from Settings through the `storage` event.

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
  (`COMPANION_ROLE` in `brain.ts`) and the memory go in front of the first
  request of a conversation. The role asks for short plain-text answers in
  the user's language, gives the Windows recipes (`Start-Process`,
  `Get-StartApps`, Steam's `steam://rungameid/`, Spotify URIs and the media
  keys) and the directives below.
- Every request starts with the local date and time, and says what images
  come with it. The ask bar sends the screen when the eye is on: by itself
  when the request speaks of the screen (`mentionsScreen`), or by a click.
  The row under the bar then picks what goes, a choice kept in the
  preferences: every screen (one image per screen, the primary first), the
  screen the companion is on, or a part. A part is picked on sending: the
  window covers the screen under the pointer (`CompanionZone.svelte`), a drag
  frames the part, a click takes the whole screen, and Escape or a right click
  cancels with the request kept in the field.
- How fast an answer starts depends on the core's "Warm process minutes"
  (Advanced): at 0 the agent starts again for every request. The companion
  does not change it; its Settings page says so and links there.

The reply bubble streams the text parts of the agent's messages from
`message.started`, `message.delta` and `message.part` on the subscribed
thread; reasoning and tool input are left out. The turn ends when the thread
leaves `queued`, `running` or `waiting`; the page then reads the thread's last
messages (`threads.get`; `messages.list` needs a cursor) for the final text and
the directives of every message of the turn.

## Memory, reminders and directives

The agent adds lines of its own to a reply, which the bubble never shows
(`directives.ts`):

- `[[remember: fact]]` keeps a fact about the user;
- `[[forget: fact]]` drops the facts it names, by their words;
- `[[remind: when | text]]` sets a reminder, `when` being a delay (`+20m`,
  `+1h30m`), a time (`18:30`, tomorrow once past) or a date and time.

The memory (80 facts at most, oldest out first) and the reminders live in
`localStorage` on this computer (`memory.ts`), never in the core except as the
memory block of a first request. Settings, Companion lists both: a fact can be
added or forgotten, the whole memory cleared after a confirmation, a reminder
cancelled. Changing the memory starts a new conversation. Passwords and other
secrets are not to be kept, as the role says.

The companion's window checks the reminders every second. One that is due
shows a card with OK and "In 10 min", the character looks alert and a chime
rings, twice over; a reminder due while the companion was closed rings when it
opens. While a card waits, the chime comes back every minute, three times in
all.

## Notices

When a thread other than the companion's finishes, a card says so with the
first sentence of its last answer, without Markdown (`summaryLine`). A click
opens the thread in the main window. Notices go after 15 seconds, and stay
while the pointer is on the companion or its panel is open.

## Sounds

Short chimes made with Web Audio (sine notes, nothing recorded): the panel
called by the shortcut, an answer, an agent calling, a reminder, an error.
"Sounds" turns them off. The webview keeps audio muted until the page is
used, so the first press on the companion unlocks it.

## Mood

`mood.ts` reads the threads, permissions and questions. The moods, in order
of priority, are:

1. worried: the core is out of reach;
2. calling: an agent is blocked on the user;
3. happy: a thread has just finished;
4. working;
5. idle.

The companion looks strained when three or more threads are at work. Events other
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

- `cargo test --lib` in `apps/shell/src-tauri`: hit test, placement, drop
  spots, full-screen cover, picked area on the screen, shortcut parsing and ACL.
- `packages/ui/src/lib/companion/companion.test.ts`: preferences, mood, brain
  choice, prompt and wording.
- `packages/ui/src/lib/companion/companion-memory.test.ts`: memory,
  reminders, directives, notices' summary line, layout and screen words.
- `packages/ui/src/lib/companion/companion-talk.test.ts`, on the fake core: a
  reply's directives kept, a finished thread's first sentence, a reminder
  ringing again until answered.
- Captures: `?view=companion&fake=1` on the dev UI at 440 × 600, and Settings,
  Companion at desktop width.
