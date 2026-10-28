# The project board

The board shows a project's todo list in four columns. It shares the drawer
under the chat with the terminal ([terminal.md](terminal.md)). `Ctrl+J` opens
the drawer on the tab picked last on this device, Board or Terminal, and hides
it again; the drawer's first tabs switch between the two. The header's board
button, and on a phone the title menu's Project board row, open the board
alone. The board belongs to the project, so every thread of the project shows
the same cards; the terminal stays the thread's.

A contact's page shows the four counts of each project shared with that
contact and opens its board in the project's last conversation
([contacts](contacts.md#projects-and-requests)).

The board needs a core that sends `features.projectBoard` in its hello.

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

## Shared board protocol

An active [shared project](contacts.md#completion-protocol) has a board only
after both endpoint owners enable its `board` consent. This is separate from
transcript reading and compute permission. Local cards remain local; adding a
shared card uses `sharedBoard.apply`. Shared cards project into the same `Todo`
and goal shapes with `Todo.shared`, including their canonical association.
`todos.update/remove` require `sharedProjectId` when changing a shared card.
IDs of local cards and of other associations never select that card implicitly.

The proposing project's original core is the immutable authority. It commits
the command receipt, one increasing revision and the card or tombstone in one
SQLite transaction. A command's actor, association and request ID identify it;
reusing that ID with different content is refused. Retrying returns its
original receipt without applying it again. Text and status updates patch only
their specified fields. Concurrent edits of one field take authority arrival
order; wall clocks never choose a winner. Removal is terminal for that card ID,
even after restart. A new card needs a new ID. History, receipts and tombstones
currently have no retention pruning.

A claim compares `expectedRevision`, requires an open unassigned card and
reserves a canonical worker on its own endpoint. The same worker cannot hold
another card of this association. Competing claims get one applied receipt;
the other gets conflict. A queued receipt never authorizes execution.
On a member endpoint, the worker's canonical core/thread and public gateway
address differ. Clients obtain both from the scoped directory after creating
the local worker; they never derive authority by parsing an alias. The board
and immutable claim authority remain on the original endpoint cores.
The authority returns a claim ID scoped to association, actor, card and request.
Use the assignment's returned ID for start, release and progress; a request ID
alone is not a claim ID, since different agents may reuse it.
`sharedBoard.start` names the reserved worker as `threadId`, rechecks the
authority and host execution policy, and persists its one-time `/goal2` start
with the existing activity state. Restart pauses that activity as usual;
replaying the start does not resume or replace it. Loss of the authority never
elects a replacement. File protection captures the checkout and grant revision
before starting the goal, and children retain that scope after its replacement.
Only echo in default mode is admitted: Claude, Codex, ACP, Muse and pi have no
implemented selective secret-file isolation and protected board execution is
refused. This remains a feature gap, rather than an external provider sandbox.

A release first asks the exact worker host to stop that claim. A durable stop
marker fences delayed starts, then the host removes only its core-tagged shared
goal and waits for the captured scheduler/process records to exit. A replacement
goal or another activity is left alone and the assignment remains held. An
unreachable or uncertain host never frees the claim on a timeout. The ordinary
local board's unlink behavior is unchanged. Process coverage remains the platform's:
Linux/macOS direct records do not prove termination of an untracked descendant.

Disabling board consent or revoking the association fences pending commands
and delayed starts durably. The host removes only the goal still carrying
that exact shared claim and stops its protected descendants. A replacement
owner activity and unrelated local turns continue. Claims are not freed or
reassigned by a revocation timeout. Recovery applies the same local fences
without restarting goal or reviewer inference.

Worker activity supplies the existing checklist and review projection. Only
the assigned host can report it. Persisted per-claim sequences reject late
progress; duplicates return their original receipt. Only a completed goal
with a passing review advances an open card to claimed. A manual completion
does not. A pass timestamp identifies the worker's verdict; it is never compared
with the authority's clock. A pass already observed cannot claim the card again
after the user resumes it. The user confirms Done, and an agent cannot remove or reopen a
confirmed card. The assignment retains the worker host's model and machine
labels; each view resolves its person's contact name locally.

Edits on a replica enter a durable outbox before a network wait. After 100 ms a
slow response returns `queued`, and the local snapshot overlays pending text,
status, additions and removals. Claims wait for an authority answer or a
transport failure. An offline snapshot says `authorityAvailable: false`.
Pending commands replay in local enqueue order on the existing Contacts flush
and reconnect path; current source and bilateral board grants are rechecked.
Commands queued during an in-flight flush are drained before that flush ends.
Policy refusal closes pending operations; network loss retains them. Revoked
associations stay revoked, including after a later project grant.

The authority coalesces revision hints for 50 ms. An acknowledged hint produces
no idle board traffic; a failed hint retries with Contacts. A replica reaches
the announced revision before acknowledging, including when a newer
hint arrives during an older pull. A hint beyond the authority's history is refused.
Replicas pull contiguous deltas from their durable cursors, at most 64 changes and 128 KiB per
page, with one larger valid card allowed alone. Checklist bounds are the
existing 80-item, 160-character text and 300-character source bounds; control
characters become spaces. The 256 KiB signed/sealed transport limit is unchanged.
Hints and imported deltas never generate new authority revisions or echo
hints. Restart/reconnect also reconciles the replica cursor. Reads and
in-flight replies recheck active grants. Agent `todos.list/updated` projections
apply the same shared-project source policy while preserving ordinary local
cards. There is no new polling interval, SDK or process for replication.

`packages/core/test/shared-board.test.ts` uses real loopback cores, HTTP/WS and
signed/sealed Contacts exchanges. It covers claim/start races, restart and lost
acknowledgements, offline convergence, terminal deletion, progress ordering,
revocation, paired actions, bounded paging and quiescent traffic. Client/fake
transport and shared board controls are integrated separately from this core
protocol.
