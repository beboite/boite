# Teams

A team is a few bots ([bots](bots.md)) and the owner talking in one group.
Each bot answers from its own thread, with its own identity, memory and the
live context of its work; the team only carries posts between them. A post
wakes the bots it names, and a bot answers either in the group, which every
member reads, or privately to one member or the owner.

Teams sit behind the Teams switch in Settings > Experiments
([experiments](experiments.md)). While it is off, every `teams.*` method and
every `boite team` command refuses with the reason `experiment-off`. The core
reads the desktop app's experiments.

Contracts: `packages/contracts/src/teams.ts`; core:
`packages/core/src/teams/` (store, journal tables, prompt, RPC) and
`packages/core/src/team-cli.ts`.

## Model

- A member is keyed by the core it runs on and its bot id,
  `<coreId>/<botId>`, everywhere: members, post authors, recipients, cursors
  and delivery states. The owner is `owner`, which only the owner's RPC
  writes. This version takes bots of this machine only (see
  [Limits](#limits)), but the keys already read the same on every machine.
- A team has a name (up to 60 characters, unique among live teams, case
  ignored), a brief of what it is for (up to 1,000 characters), 1 to 12
  members, each with the seq it joined at, a paused and an archived flag,
  and `createdBy`: the owner, or the bot whose card the owner accepted. Every
  change bumps its `version` and emits `teams.changed`.
- The team chat is a projectless thread with `teamId` that runs no agent.
  `requireAgent` (`threads/agentless.ts`) refuses there every call that would reach a
  provider: `turns.start`, `turns.steer`, `turns.recover`,
  `threads.retitle`, `threads.compact`, `threads.rewind`, `threads.fork`,
  `threads.move`, `threads.btw`, `threads.btw.fork`, `threads.update`,
  `threads.activity.set` and `threads.goal.track`. The composer posts through
  `teams.post`.
  Each post is one finished turn there, carrying the post. It holds the
  owner's view, private posts included, so coordination never lists it: the
  directory, search and `send` leave team threads out, and a bot reaches a
  team only through `boite team`, filtered to what it may see.
- A post has an id its writer picks (a retry with the same id and content
  returns the first post, other content under that id is refused), a seq
  (the team's order, from 1), an author, 1 to 4,000 characters of text, an
  audience (`team` or `private`), its recipients `to`, the rule that picked
  them (`routedBy`), an optional `inReplyTo`, the bot turn that wrote it, and
  a notice when it woke nobody.
- A bot's post marks the team chat unread, as a finished turn does, unless a
  client has it open; the owner's own posts do not. A bot's private post to
  the owner also sends the owner a notification, `<bot>: <text>`; group posts
  do not.
- A member may read group posts and the private posts it wrote or received.
  The owner reads every post and, alone, the delivery state of each post per
  recipient: waiting, delivered, held, expired, rejected or unreachable.

## Group or private

- A group post (`boite team say`) is read by every member in its next
  delivery. `@name`, `@tous` and `@everyone` wake; the rest read it only when
  something wakes them.
- A private post (`boite team dm <team> <member|owner> <text>`) has one
  recipient, always wakes it, and enters no other bot's delivery. It is not
  secret from the owner: the team chat shows every post.
- The bots' guide asks for the group for what changes what a teammate does
  or knows, in one to three lines, and private for what only one reader
  needs. Long content goes by path. A group post costs every member tokens
  at its next turn, and a delivery is capped (below), so noise pushes useful
  posts out to `boite team read`.

## Routing

The first rule that applies picks who a post wakes
(`routeTeamPost`). The author is never a recipient of its own post: when
the author is the only one a rule picks, the post wakes nobody.

0. A private post goes to its one recipient.
1. `@name` (a member's live name, case ignored, ending at a non-word
   character), `@tous` or `@everyone` (every member but the author), or the
   recipients the owner's composer picked.
2. A reply goes to the author of the post it answers.
3. An owner post in a team of one bot goes to that bot.
4. Otherwise an owner post wakes nobody and carries the notice "Nobody was
   pinged: name a bot with @name, or everyone with @tous."; a bot post wakes
   nobody, and teammates read it in their next delivery.

A later version replaces rule 4 for owner posts with a dispatcher that picks
the recipients from the roster and the brief.

## Delivery

A post addressed to a bot puts a team letter in that bot's inbox on the
coordination transport ([coordination](coordination.md)), through
`TeamLetters.accept` (`coordination-team.ts`), never through `send`, whose 4,000-character
cap stays. The letter keeps the operation `coordination`, so a team wake has
the whole letter lifecycle: the hook, the waiter, the steer into a running
turn, the wake, recovery after a restart and settlement.

- A bot holds at most one waiting team letter per team. A later addressed
  post joins it as another trigger and moves its expiry to six hours after
  the newest trigger, so a burst of mentions takes one batch slot.
- A letter with an owner post among its triggers starts its turn as the
  owner's own message. Any other waits while the bot or all bots are paused,
  and the daily budget gates its wake as for any letter.
- A letter reaches its bot only while the team exists, is neither paused nor
  archived, and still has the bot. Unpausing sends the held letters; a
  removal, a leave or an archive rejects them with the reason.
- Rendering freezes a snapshot: the triggers, whole and oldest first, then
  the posts the bot may read above its cursor that are neither seen nor held
  by another snapshot in flight, newest back. One team letter renders at most
  16 KB in UTF-8 and a batch takes at most two team letters, the others
  waiting for the next batch. Triggers that do not fit move to a new waiting
  letter; context that does not fit is named with `boite team read` and
  counts as seen. Two teams render apart.
- The hook and the waiter mark the snapshot seen when the letter is
  delivered. A steer and a wake hold it in flight, then mark it seen once the
  provider takes it, or release it when the wake ends without that (a
  refusal, an error, a stop, a restart). A released post renders again in
  the next delivery: a post can reach a bot twice when an outcome stays
  uncertain, never zero times.
- The post is written before its letters. A recipient whose letter a
  failure or a stop left unwritten gets it when the post is retried with the
  same id, or at the next start: a delivery still `waiting` whose post no
  received or uncertain team letter of that bot carries is handed again.
  Posts older than a letter's six hours are left as they are.
- At each start, snapshots in flight whose letter nothing will settle any
  more (a steer no provider acknowledged, a wake whose turn ended) are
  released; their letter stays as it is.
- A bot's own coordination switch (mode off, no remote, paused) leaves its
  team letters and their wakes alone: the team decides who receives.
- Each member's cursor moves up across seen posts and posts it may not read,
  so a private post between two others never pins it. A new member starts at
  the seq it joined at; older posts stay readable with `boite team read`.

## Reply

A wake records a reply envelope on its turn when every team letter it took
shares one channel: one team, and either the group or private with one
author. The turn's final answer then becomes a post on that channel, with an
id derived from the turn id, so a restart or a retried publication never
posts twice. An envelope stays pending until its answer is posted or found
to have none; the next start, and the end of any later turn, post what a stop
or a failure left pending. A final answer of `[quiet]` posts nothing; that is also how two
bots end an exchange.

A batch that mixes teams or private authors, and a letter steered into a
running turn, get no envelope: the prompt names each channel and the bot
answers with `boite team say` or `boite team dm`. A turn without an envelope
never posts to a team.

## The owner

Owner methods: `teams.create`, `teams.update`, `teams.archive`,
`teams.members.add`, `teams.members.remove`, `teams.pause`, `teams.post` and
`teams.list` and `teams.read` without a thread. Members are named by bot id
or name. `teams.create`, `teams.members.add` and `teams.members.remove` take
the `card` of a bot's proposal, which applies it and settles the card.

## Commands

A bot posts, reads and proposes from its own thread; an agent token may only
name its own thread.

```sh
boite team list
boite team say <team> <text> [--reply <post-id>] [--request-id <id>]
boite team dm <team> <member|owner> <text> [--request-id <id>]
boite team read <team> [--before <seq>] [--limit <n>]
boite team propose --name <name> --members <bot,bot> [--brief <text>]
boite team invite <team> <bot>
boite team leave <team>
```

`say` and `dm` print the post's seq and id and whom it wakes. `read` prints
the posts the bot may see, oldest first, and the command for the older page.
`propose`, `invite` and `leave` draw a card in the bot's thread and return at
once; the owner's choice arrives as a message, and without one nothing
changed. A team is named by id or name. A member written `<machine>/<bot>` is
refused: members on other machines come in a later version.

The bots' guide gains three lines while the experiment is on: answer
`[quiet]` when nothing needs saying, group or private, and when to propose,
invite or leave.

## Limits

- Members are bots of the machine that holds the team. Other machines of the
  group come later, with the same member keys.
- No dispatcher: an owner post that names nobody, in a team of more than one
  bot, wakes nobody and says so.
- Posts carry no attachments; long content goes by path.
- Two bots that answer each other stop only when one answers `[quiet]`; the
  daily budget is the other bound.
- The experiment gates the methods and the commands, not delivery: letters
  already in an inbox still go out after the switch is turned off.
- Private keeps a post out of the other members' letters and
  `boite team read`. It is not secret from a bot allowed to read the
  recipient's own conversation (`collaboration.read`), which shows what that
  bot received, like a message the owner sends it directly. The team chat
  itself stays out of coordination.
- The app draws no team chat or team settings yet; the contracts and the
  in-memory client carry the methods for it.
