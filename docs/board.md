# The project board

The board shows a project's todo list in four columns. It shares the drawer
under the chat with the terminal ([terminal.md](terminal.md)). `Ctrl+J` opens
the drawer on the tab picked last on this device, Board or Terminal, and hides
it again; the drawer's first tabs switch between the two. The header's board
button, and on a phone the title menu's Project board row, open the board
alone. The board belongs to the project, so every thread of the project shows
the same cards; the terminal stays the thread's.

The board sits behind the Reviewed goals experiment (`goal2`, Settings,
Experiments) and needs a core that sends `features.projectBoard` in its hello.

## Columns

| Column      | Cards |
| ----------- | ----- |
| To do       | open cards with no goal conversation |
| In progress | open cards whose `/goal2` conversation works |
| In review   | a goal whose reviewer is reading, and `claimed` cards that wait for the user |
| Done        | cards the user confirmed |

A card put in In progress starts a new conversation of the project with the
card's text as a `/goal2` objective. It runs on the agent, account, model,
effort and mode of the thread the board is open in, and in a worktree of its
own when that thread has one. The card is linked first (`todos.update`
`goalThreadId`), then the goal is set, so its first change reaches the board.
The card then shows the agent's model and machine, a dot while a turn runs, and
the goal's checklist as a bar (`done/total`, dropped items left out); its text
unfolds the checklist.

The core reads each linked goal again whenever it sends the list
(`Todo.goal`, never stored) and sends the list again when a linked
conversation's goal changes. A goal whose review passes after its card last
moved takes the open card to `claimed`, so it waits in In review for the user
to confirm it in Done. Only a pass does: a goal completed by hand after a failed
review claims nothing. A card moved back to In progress after that pass stays
there.

A card links one conversation at a time. When two devices put the same card in
progress, the first link wins; the other device's link is refused and it
deletes the empty conversation it made. A link to a conversation since moved to
another project is dropped, so that project's agents never read its checklist;
a removed conversation stops showing until a restore brings it back. A card in
progress whose conversation has no goal, a start cut short or a goal removed
there, reads "Goal not running" and its menu starts the goal again.

Moving a card to To do unlinks its conversation, which goes on by itself. In
review sets `claimed`, Done sets `done`, In progress on a linked card sets
`open`.

## Moving cards

On a desktop a card drags between columns. Every card also has a menu with
Move to, Open its conversation and Remove the card, which is the way on a
touch screen.

On a phone (720 px and narrower) the board shows one column a screen. A swipe
snaps to the next column, as on a home screen, and a row of dots under the
board marks the column on screen; a dot jumps to its column. Moving a card by
its menu scrolls to the column it went to. The drawer opens at half the
screen there.

## Paired devices

A paired device reads and moves the cards: `todos.list`, `todos.add`,
`todos.update` and `todos.remove` are in `DEVICE_METHODS`, and `todos.updated`
reaches it for every project. Confirming a card (`done`) and removing one are
the user's on any of the user's devices; an agent may only claim a card. A
device has no shell, so its drawer has the Board tab alone.
