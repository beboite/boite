# Desktop companion

An experiment (Settings, Experiments, "Desktop companion") that puts a small
character on a screen in the desktop app. It shows the state of the agents at
a glance, lets the user answer their permissions and questions without
opening Boite, and answers requests of its own: the user can ask it
something, show it the screen, or ask it to act on the computer (open an app
or a page, play music, launch a game). Those who answer are agents of the
Agents page, up to four side by side, each with its own look, conversation
and memory. It rings the reminders they set and says when another thread
finished.

Only the desktop shell shows it. A browser or a phone with the experiment on
shows the Settings page, which says that the companion runs in the desktop app.

## Pieces

| Piece | Where |
| --- | --- |
| Window: transparent, always on top, click-through outside the drawn areas | `apps/shell/src-tauri/src/companion_window.rs` |
| Full-screen app in front, last input, screen capture, global shortcut | `apps/shell/src-tauri/src/platform/desktop.rs` |
| Media session (Spotify first): read, cover and control | `apps/shell/src-tauri/src/platform/media.rs` |
| App in front, and whether it is a game | `apps/shell/src-tauri/src/platform/games.rs` |
| Page, mounted for `index.html?view=companion` | `packages/ui/src/CompanionApp.svelte` |
| Character and its accessories, agents row, ask bar, panel, notices, music pill, HUD, pomodoro and focus, history, Settings' agents and reminders cards, dropped files, task cards, confetti | `packages/ui/src/components/companion/` |
| Settings, Companion | `packages/ui/src/components/CompanionSettings.svelte` |
| Preferences, mood, brain and role, agents (`crew.ts`, `crew.svelte.ts`), each agent's conversation (`talk.svelte.ts`), looks (`skin.ts`), senses, notices, HUD, pomodoro, focus, history, reactions, reminders, directives, screen, dropped files, tasks, sounds, shell calls | `packages/ui/src/lib/companion/` |

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
outside them goes to another application; when it comes up, and only if the
press never crossed those areas (`outside_click`), the thread emits
`companion://outside`, and the page closes its panel unless "Close when
clicking elsewhere" is off. A file dragged from elsewhere onto the companion
is therefore not a click elsewhere. Once a second the thread lifts the window back to
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
  can call the companion over a game;
- `companion://foreground`: the app in front, as its exe name and whether it
  is a game (`platform/games.rs`), checked twice a second, sent on each change
  and again every 5 seconds for a page that reloaded. Never a window title. The companion's own window
  in front keeps the last value.

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

The webview is built with `disable_drag_drop_handler`, so files dragged from
Explorer reach the page as HTML5 `dragover` and `drop` events instead of
Tauri's own. Windows does not focus a window a file is dropped on, so the page
calls `companion_focus` after a drop to take the keyboard.

Its capability (`capabilities/companion.json`, `allow-companion-ui`) allows
reaching the core, placing and dragging itself, its shortcut and full-screen
option, capturing and covering the screens, reading and controlling media, and
bringing the main window forward on a thread or on its settings
(`companion_show_main`), and taking the keyboard after a drop
(`companion_focus`).
It cannot open or close itself, open browsers, read cookies, save files,
notify or quit; `acl.rs` tests this.

## Preferences

They are this computer's, in `localStorage` under `boite.companion`, like the
experiments: screen, position and drop spot, hiding for full-screen apps, the
shortcut (one of `COMPANION_HOTKEYS`, or none), sounds, agent, account,
model, effort, control mode, music, quotas and the ones hidden, closing on an
outside click, the pomodoro's work and break minutes, focus during work, and
the agents of the row (`agents`, four at most, the leader first). Both
webviews share the origin, so the companion follows a change from Settings
through the `storage` event.

The provider, account, model, effort and control mode are what a new agent
of the companion's gets. An agent already in the row keeps its own, changed
in its page in Agents.

## Agents

The companion talks through agents of the Agents page (`docs/agents.md`):
their conversations, memories, models and looks are the ones that page shows
and changes, and opening one from the companion turns the "Resident agents"
experiment on. They run like any other agent, on their own account, so the
core's subscription proxy (Douane), its limit on agent work running at once
and the usual permissions apply. Nothing is added to the core or to the RPC.

- The row (`CompanionCrew.svelte`): the agents stand side by side, the leader
  first. A click on one opens the panel to talk to it; with the panel open, a
  click on another switches to it. Each keeps its own bubble, request
  in flight and history. The first time the companion runs without agents it
  makes one, Bots, in the classic look, and moves the facts it kept on this
  computer into Bots's memory. Settings, Companion, Agents makes another one
  (on the provider below), adds an existing agent, draws a new look for one,
  opens its page, or takes it off the row, except the last one. An agent taken
  off stays an ordinary agent, and its instructions lose the role.
- Looks (`skin.ts`, `BoxTop.svelte`): each agent stands as the companion's
  box in its own robot's colours, with a body colour, lid, eyes and an
  accessory on the lid (`ROBOT_PARTS.box`); the robot picker in Agents draws
  the same boxes. A robot of another family becomes a box of its colour. A new
  agent, or "New look", gets a body colour nobody in the row wears
  (`freshSkin`) and an accessory; Bots keeps the classic box. The accessory
  steps aside for the headphones and the headset.
- The role (`COMPANION_ROLE` in `brain.ts`) sits in the instructions of each
  agent of the row, between `<!-- boite-companion -->` marks, after what the
  user wrote, with Boite's projects for `[[task: …]]` (`roleBlock`,
  `withRole`). The companion writes it again when it or the projects change,
  and takes it out whole (`withoutRole`) when the agent leaves the row. It
  asks for short plain-text answers in the user's language, gives the Windows
  recipes (`Start-Process`, `Get-StartApps`, Steam's `steam://rungameid/`,
  Spotify URIs and the media keys) and the directives below.
- For a new agent, Automatic takes the first provider that is on, present and
  signed in, on the small model titles are written with when it lists it,
  otherwise on its default. A chosen provider that is off or signed out is
  reported, not replaced. "Ask before acting" makes the agent in the
  `default` permission mode: every command waits for Allow or Deny, which the
  companion's panel shows. "Act without asking" uses `bypassPermissions`.
- A request goes to the agent's direct conversation (`agents.message.send`)
  and ends with a `[[context: …]]` line (`contextLine`): the local date and
  time, then the paths of the images and files that go with it. An agent's
  turn takes paths, not attachments, so the shell keeps each file in the
  system's temporary folder, under `boite-companion`, for a day
  (`companion_keep`), and the agent opens it with its file-reading tool.
  Outside the shell no image or file goes.
- The ask bar sends the screen when the eye is on: by itself
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

The answer streams into the agent's bubble from the thread the agent works
its conversation in (`message.started`, `message.delta` and `message.part` on
that subscribed thread; reasoning and tool input are left out). The agent's
message that replies to the request ends it, and a work that ends without
one makes the bubble say so. The agents snapshot is read again on
`agents.changed`, after 150 ms while an answer is awaited and 1.2 s
otherwise. The conversation shows in Agents as the user typed it: the context
line and the directives are left out there too (`visibleReply`).

## Memory, reminders and directives

The agent adds lines of its own to a reply, which the bubble never shows
(`directives.ts`):

- `[[remember: fact]]` keeps a fact about the user;
- `[[forget: fact]]` drops the facts it names, by their words;
- `[[remind: when | text]]` sets a reminder, `when` being a delay (`+20m`,
  `+1h30m`), a time (`18:30`, tomorrow once past) or a date and time;
- `[[timer: duration | label]]` starts a countdown (`25m`, `50m`, `1h30m`, up
  to 4 h; the label is optional), `[[stopwatch: label]]` a stopwatch,
  `[[pomodoro: duration | label]]` a pomodoro (the duration, its work time,
  is optional), and `[[timer: stop]]` stops whichever runs;
- `[[focus: on]]` and `[[focus: off]]` turn focus on and off;
- `[[task: project | instruction]]` launches a Boite thread in that project
  (three per reply at most; see "Launching threads").

The facts go to the memory of the agent that answered (`agents.memory.save`;
a forget expires the memories it names, the way the Agents page deletes one),
which the core gives the agent with its requests; they are seen and changed
in its page in Agents. The reminders live in `localStorage` on this computer
(`memory.ts`); Settings, Companion lists them and cancels one. Passwords and
other secrets are not to be kept, as the role says.

The companion's window carries out each answer's directives once, the marks
of the answers already read kept under `boite.companion.marks`. An answer it
first sees more than two minutes after it was written, because the companion
was closed, only keeps and forgets facts and sets reminders: a timer, focus
or a thread launched late would surprise the user.

The companion's window checks the reminders every second. One that is due
shows a card with OK and "In 10 min", the character looks alert and a chime
rings, twice over; a reminder due while the companion was closed rings when it
opens. While a card waits, the chime comes back every minute, three times in
all.

## Notices

When a thread other than the ones the row's agents work in finishes, a card
says so with the
first sentence of its last answer, without Markdown (`summaryLine`). A click
opens the thread in the main window. Notices go after 15 seconds, and stay
while the pointer is on the companion or its panel is open.

## Sounds

Short chimes made with Web Audio (sine notes, nothing recorded): the panel
called by the shortcut, an answer, an agent calling, a reminder, an error, the
end of a pomodoro phase (three falling notes). "Sounds" turns them off. In
focus, only an agent calling, a reminder and the pomodoro's chime ring
(`audible`). The webview keeps audio muted until the page is
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

The pill shows the track's cover when the session has one: the shell scales
the thumbnail to 96 px on its longer side, encodes it as JPEG and returns it
as a data URL. It is read once per track (title, artist and app), and once
more 4 seconds later, since players often hand the new title before its
cover. Paused, the cover turns grey. Other systems have no cover, and the pill
keeps its bars. The title and the artist scroll when they are longer than the
pill (`Marquee.svelte`); with reduced motion they stop at an ellipsis.

## Reactions

What goes on around the character changes it for a while (`reactions.ts` for
the rules, `reactions.svelte.ts` for the page):

- **Gaming headset**, while a game is in front (`companion://foreground`). A
  game is a known exe (Overwatch, Valorant, Counter-Strike 2...), or anything
  under `steamapps\common`, the Epic Games, Battle.net, Riot Games or Xbox
  games folders, the launchers and their helpers excepted. It is drawn apart
  from the music's headphones and wins when both apply. On a break the tea
  wins over both.
- **Morning coffee**, a steaming cup for the first 10 minutes after the day's
  first sign of the user (a key, the pointer), between 5:00 and 11:00. The
  day turns at 5:00, so a late night does not take the next morning's coffee.
  The first sign is kept under `boite.companion.day`, for a reload.
- **Confetti**, when another thread finishes (the notices' path) and its final
  answer says the tests pass, in English or French ("all 42 tests passed",
  "42 pass, 0 fail", "les tests passent"). A failure or a negation anywhere
  in the answer stops it: in doubt there is none. A short burst in the theme's
  colours with a joyful pose; with reduced motion, the pose alone. Nothing
  during a focus.

## HUD

A pill beside the character (`CompanionHud.svelte`, `hud.ts`), in the manner
of a "Dynamic Island". It sits under the character in the centre, and beside
it, towards the middle of the screen, on the left and the right; near the
bottom it goes above, or level with it. It stays in the page's flow, so it
never covers the panel, the cards or the music pill, and the character keeps
its place.

Folded, it shows how many threads are at work (queued, running or waiting,
the companion's own left out), the title of the one whose request started
last, its step and how long it has been at it. The step is
`ThreadSummary.progress`, which `thread.updated` brings to every client: the
phase in the words of the chat's turn summary, with its detail (a tool, most
of the time). `thread.activity` reaches only the clients subscribed to a
thread, so the HUD does not read it. The time counts from the user's request,
as the sidebar does, once a second while the pill shows and the page is seen.

On hover (the shell's `companion://hover`, and the pointer on the pill) or
keyboard focus, the outline morphs into a card listing every thread at work
with its project, step and time; a click opens it in Boite
(`companion_show_main`). Without threads at work, the pill is gone, or only
the gauges stay.

With "Show quotas" on and the core's subscription proxy set to a Douane, it
carries one small gauge per subscription (`hudGauges`), each beside its
provider's logo (`ProviderLogo.svelte`): what is left of the window nearest
its limit, amber past 80 % used, red past 95 %, each with a label for screen
readers; the open card spells them out. Settings lists the subscriptions under
"Show quotas", one switch each: the ones turned off are kept by id in
`hiddenQuotas` (`shownGauges`), so one the gateway adds later shows. The page
reads `subscriptionProxy.quotas` on start and every minute, and takes every
`subscriptionProxy.quotasUpdated`. With no proxy, or another kind, there is
no gauge. The key is never read.

## Timers

A timer sits beside the activity pill (`CompanionTimer.svelte`, `pomodoro.ts`,
with the clock in `focus.svelte.ts`). It is a pomodoro, a countdown or a
stopwatch, one at a time, each with its icon. It shows the phase, the time
left (the time so far for a stopwatch) and what it is for. On hover or
keyboard focus it unfolds pause or resume, skip the break, and stop. A
pomodoro starts from the row under the ask bar (`CompanionTools.svelte`) with
the minutes set in Settings (25 and 5 by default). The agent's `[[pomodoro: …]]`
also starts one, and its work time wins; `[[timer: …]]` starts a countdown and
`[[stopwatch: …]]` a stopwatch. A countdown that ends rings as a reminder, with
its label; a stopwatch stops at 24 h.

One pomodoro is a work phase, then a break, then the end. Each phase rings the
phase chime when it ends. During the break the companion takes it with the
user: it sits back with a cup of tea, and a card says "Break, 5 min" with Skip
(`CompanionFocusCards.svelte`). The state is a few numbers in `localStorage`
under `boite.companion.pomodoro`. A reload finds the timer where it was, and a
phase that ended while the window was closed rings when it opens.

## Focus

Focus is on in three cases:

- the user turns it on from the row under the ask bar;
- the agent writes `[[focus: on]]`;
- a pomodoro is in its work phase and "Focus during work" is on.

Turning it off by hand holds until the next pomodoro starts. While it lasts:

- the character is smaller and paler, eyes half shut, breathing slowly; an
  agent calling or the core out of reach still shows at full size;
- a finished thread's card is set aside (`NotesHost.setAside`);
- only an agent calling, a reminder and the pomodoro ring;
- permissions, questions and reminders get through as usual, and the panel
  still opens by itself for them.

When it ends, one card lists what was set aside: "During focus: N threads
finished". A click on one opens it in Boite. The threads set aside, the recap
and the user's choice are kept under `boite.companion.focus`.

## History

The row under the ask bar shows the last 20 exchanges with the agent being
talked to (`CompanionHistory.svelte`, `history.ts`): each request of the
user's in its direct conversation, from the agents snapshot, with the
agent's message that replies to it. Nothing is copied locally; the whole
conversation is in its page in Agents.

A request reads as the user typed it, without its context line. A reply reads
as the bubble showed it (`visibleReply`). A click puts the reply back in the
bubble.
The list closes when a new permission or question opens the panel.

## Dropping files

Files and images dropped on the character or the panel go with the next
request (`drop.svelte.ts`, `CompanionAttachments.svelte`). The page takes a
drop only over the areas marked `data-hit`, the ones the window does not let
through; elsewhere the drag is refused, so a file never replaces the page.
While files hover over those areas the character opens its eyes wide (the
`startled` face) and a dashed row says where to let go.

A drop opens the panel with the field focused. Each file shows as a chip
under the ask bar, with a thumbnail for images and a button to take it back.
An image becomes a JPEG the way a capture does (`imageOfFile` in `screen.ts`:
1568 px on the long side, under the room left); any other file follows the
composer's contract (`readAttachmentFile`). The core's caps are checked as
each file comes (`ATTACHMENT_MAX_BYTES`, `ATTACHMENTS_PER_TURN`,
`ATTACHMENTS_TOTAL_MAX_BYTES`, with the screen's images on sending), and a
refusal names the file and the cap in the composer's words; the other files
stay. The request's context line says where they were kept for the agent. A
request that does not go puts the text and the files back.

## Launching threads

The role lists Boite's projects, drafts and
archived ones left out (`taskProjects`). The agent launches a thread with
`[[task: project | instruction]]` (`tasks.ts`, `tasks.svelte.ts`):

- The project is found by its name, accents, case and punctuation aside:
  exactly, then by a unique start or part, then by a unique close spelling.
  An unknown project makes the bubble say so, with the close names or, when
  none is close, the known ones.
- The thread gets what the main window would give a new one
  (`newThreadChoice`, mirroring `Models.defaultChoice`): the composer's agent
  and account when they are usable, otherwise the first agent that is on and
  signed in, its default model, effort and speed, and the composer's
  permission mode. A project whose new threads use a worktree gets one.
  Then `threads.create` and `turns.start` with the instruction.
- In "Ask before acting", a card shows the project and the instruction with
  Launch and Cancel; in "Act without asking" the thread starts at once.
- A "Thread launched in project" card (three at most) opens the thread in the
  main window on a click. The end of the thread comes as any other through
  the notices.

Nothing is added to the core or the RPC.

## Checks

- `cargo test --lib` in `apps/shell/src-tauri`: hit test, placement, drop
  spots, full-screen cover, picked area on the screen, shortcut parsing and ACL,
  the cover's size and per-track cache, which apps are games, and when a press
  is a click elsewhere.
- `packages/ui/src/lib/companion/companion.test.ts`: preferences and the row,
  mood, brain choice, the context line, the role's marks, and wording.
- `packages/ui/src/lib/companion/companion-memory.test.ts`: memory,
  reminders, directives, notices' summary line, layout and screen words.
- `packages/ui/src/lib/companion/companion-crew.test.ts`: the look each agent
  wears and the fresh ones, the row, replies, memory kept and forgotten, the
  agent the companion makes, and the notes (an agent's own thread left out, a
  reminder ringing again until answered).
- `packages/ui/src/lib/companion/skin.test.ts` and `packages/ui/src/lib/robots.test.ts`:
  the box's colours, lid, eyes and accessories, and boxes in the robot codes.
- `packages/ui/src/lib/companion/companion-hud.test.ts`: the HUD's threads,
  steps and order, the gauges, their levels and providers, the ones hidden in
  Settings, and following the quotas on the fake core's HUD demo.
- `packages/ui/src/lib/companion/companion-focus.test.ts`: the timer and
  focus directives and durations, the pomodoro's phases, the countdown and the
  stopwatch, pause, storage and
  chimes across a reload, what focus sets aside and lets ring, its
  preferences, and the history's requests and replies, read from an agents
  snapshot.
- `packages/ui/src/lib/companion/companion-reactions.test.ts`: the answers
  that say the tests pass or not, in English and French, the day's first sign
  and the coffee's hours, the confetti's timing, and a finished thread's
  answer handed over by the notes on the fake core.
- `packages/ui/src/lib/companion/companion-drop.test.ts`: dropped files under
  the caps and with the screen, the request naming the kept files, the role
  naming the projects, the
  task directive, finding a project, the new thread's agent and model, and
  launching in both control modes on the fake core.
- Captures: `?view=companion&fake=1` on the dev UI at 440 × 600 (`&hud=1`
  seeds a Douane and three threads at work for the HUD), and Settings,
  Companion at desktop and phone widths.
