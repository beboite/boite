# Persistent agents

Agents is a page beside chat. An identity keeps its instructions, memberships
and scoped memory when its provider, account or model changes. Pausing or
archiving an identity stops its current execution and prevents new work.

## Conversations and teams

A group is a shared conversation without a required project. Each agent/group
pair has its own native provider session. Direct conversations have separate
sessions too. Agents can belong to several groups and teams.

A team records members, responsibilities and projects. It may link to a group
but does not become that group. A mission belongs to a team or to selected
agents. It has an objective, expected result, tasks, resources and limits.

Group response modes are explicit:

- Selected recipients sends only to checked members.
- One response per member sends one work item to each member.
- Take turns automatically starts with the first member and passes the reply
  to the next. Explicit recipients override the initial selection.

A new user message starts an episode. Replies and decision continuations keep
that episode. Total and per-agent turn limits apply. Messages retain recipients
and delivery states, including exchange-limit refusals. A paused group keeps
queued deliveries. Pausing a running execution requires explicit resume later.

## Tasks, results and decisions

Assignment checks revision and dependencies in one transaction. A dependency
is satisfied only after the owner accepts its result. An assignment generation
rejects obsolete submissions. Review waits until the provider has stopped.

Project missions give each agent a Git worktree, reused by its later tasks in
that mission. Preparation records the branch before Git starts. Restart checks
that exact branch and directory before adoption. Projectless work uses a
directory under the core data directory. Workspaces remain for inspection and
handoff. There is no automatic merge, publication or deployment.

The owner can accept, reject or request changes with feedback, then assign new
work explicitly. Finish mission requires terminal tasks and executions.
Cancellation stops current executions, cancels queued work and closes pending
decisions. Finished and cancelled missions can be reopened. A used mission
keeps its original project. Referenced projects cannot be removed, preserving
workspaces and shared context. Accounts referenced by profiles are protected too.

Artifacts include workspace files, an optional commit and the agent's
verification report. Files must exist inside the workspace on first submission.
A retry with the same request id returns the original artifact after completion.
The interface exposes results and the execution without requiring process logs.

An agent calls `boite agent decide` to release its slot and request a durable
human decision. Needs attention shows the prompt and choices. An answer creates
one continuation in the same context. Native tool approvals still use the
existing permission cards and provider process.

## Memory and resources

Memory belongs to an agent, group, team, mission or project. Records have
revisions, source scopes, an optional source run and expiry. The Memory tab
supports search, editing and expiration. Expired records remain visible to the
owner but are not supplied to agents.

Personal memory is readable by its agent; group memory stays in its group.
A mission can read its team's and project's memory. Provenance further restricts
access: copying a private-group finding into personal memory does not make it
available to another group. Agents cannot strip provenance or widen scope.
The owner controls wider sharing.

Resources are instructions, HTTP/HTTPS URLs or existing absolute directories.
Directory paths are canonicalized. Own-context and personal resources are
supplied automatically. Select inherited team/project resources in the mission.
Declared writers serialize against readers and writers of the same URL or
overlapping directory. Interrupted executions keep their reservation until
reconciled or cancelled. The queue names the resource holder. This is not an OS
sandbox: provider permissions govern filesystem and network actions.

## Execution and recovery

The core owns the durable queue. Defaults are one run per agent and two
background runs globally. Existing scheduler, account and plugin quota limits
apply. Background work leaves one global slot for interactive turns when the
scheduler has more than one slot and does not add work ahead of its queue.

Mission turn limits count started runs and accepted reservations. The time
limit sums execution durations across agents and retries, excluding human wait
time. Token limits check reported usage between turns, not inside a provider
call. Missing usage pauses further work instead of counting it as zero. Direct
and group executions each have a ten-minute time limit.

Closing the page stops rendering. Quitting the shell leaves its core running
in the user's session. Reopening adopts that core. Background settings exposes
owner-only Stop this core, which stops all work and disconnects clients. There
is no OS service or automatic start at login. Tests and benchmarks use
`BOITE_CORE_RESIDENT=0` when they need shell-owned shutdown.

After restart, accepted work that never started is eligible again. Started
work becomes Interrupted and needs an inspection note through Review and resume.
Completed turns reconcile with their saved results. Durable decisions remain
pending; native approvals expire with their process. Arbitrary shell effects
cannot guarantee exactly-once execution and are never replayed blindly.

## Providers and tools

Profiles use existing model probing, account selection, effort and drivers.
Names such as Gemini 3.8 Flash or Muse Spark 1.3 Contributor are not hard-coded
or promised for every account: the model must appear in its current probe.

Antigravity CLI uses agy stream-json and its single default login. Print mode
has no interactive tool-approval channel. Muse Code uses MSP, including
approvals and session resume. The separate Antigravity ACP integration has its
own accounts. See [providers](providers.md) and [accounts](accounts.md).

Experimental agy account management belongs to the external kebacc-switcher
plugin. The Agents experiment is off by default. It marks dependent agents and
prevents their work when disabled. It does not copy credentials, rotate logins
or implement another switcher. Collaboration uses the provider-independent
[`boite agent` commands](cli.md).

## Interface and storage

The list and studio open the same detail panes. The Canvas 2D scene represents
agents as characters, groups as tables and teams as areas. It uses real work
states and messages. Local animation is limited to 15 frames per second while
active and stops when hidden or reduced motion is requested. HTML controls
provide keyboard and phone access. Disconnection marks the last state as stale.

Contracts live in `packages/contracts/src/agents.ts`. Schema 13 adds domain
records and receipts; schema 14 permits projectless managed threads. Records and
events commit together. Revision checks protect edits; request receipts protect
message, artifact and decision retries. Runs freeze execution and supplied
context. `agents.changed` invalidates a revision without broadcasting messages.
Agent RPC is restricted to its authenticated execution context. Paired devices
can converse, inspect and answer; configuration and shutdown remain owner-only.

## Verification

Run `bun run check`, `bun run test`, `bun run test:shell`, then
`bun run build:shell`, `bun run apps/shell/scripts/stage-sidecar.ts` and
`bun run e2e`.

Core tests cover assignments, scope isolation, receipts, decisions, resource
serialization, CLI tools, interrupted runs and workspace preparation recovery.
The UI journey creates and converses with an agent, leaves the page, edits
memory, accepts a task and answers a decision. Captures are under
`tests/e2e/.artifacts`. The shell journey finishes work after shell exit,
adopts the same PID and stops it explicitly. Real-provider inference is opt-in.
