import type { ContextPreset, ContextRequest, ThreadContextMode } from './context-mode';
import type { AgentLetter } from './coordination';
import type { AccountId, MessageId, ProjectId, ProviderId, ThreadId, Timestamp, TurnId } from './ids';
import type { AgentShape } from './imports';
import type { Attachment, Message, MoveNotice, PendingMove, PreviewReference } from './messages';
import type { PermissionRequest } from './permissions';
import type { ThreadCapabilities } from './providers';
import type { PullRequestWatch } from './pull-requests';
import type { BackgroundTask, BackgroundTaskObservation, BackgroundWait, QuestionRequest } from './questions';
import type { MemoryEvent } from './scheduler';
import type { DeletedThreadSummary } from './settings';
import type { Turn } from './turns';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'yolo' | 'plan' | 'dontAsk';

export type ThreadStatus =
  | 'idle'
  /** A turn is waiting for a scheduler slot. */
  | 'queued'
  | 'running'
  /** A permission request is waiting for the user. */
  | 'waiting'
  | 'error';

export interface ThreadLoad {
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
}

/**
 * Who wrote the thread's title. `prompt` is the first line of the first
 * prompt, what a client sends on `threads.create`; `agent` is what the agent
 * itself answered after the first turn or on `threads.retitle`; `user` is a
 * `threads.update` with a title, after which nothing rewrites it unasked.
 */
export type TitleSource = 'prompt' | 'agent' | 'user';

/**
 * How full the agent's context is, as of the last request it made: `tokens`
 * is what that request carried (input plus cache reads and writes), `window`
 * the model's context window when the agent says it, null when it does not.
 * Null on a thread whose agent never reported it.
 */
export interface ContextUse {
  /** Disjoint counts from the last request, when the provider reports them. */
  breakdown?: { input: number; cache: number; output: number };
  tokens: number;
  window: number | null;
  at: Timestamp;
}

/**
 * How long the provider keeps the conversation's prompt prefix cached after the
 * last turn. A request inside that time reads the prefix from the cache at a
 * fraction of the input price; after it, the provider processes the whole
 * context again. Every hit restarts the clock, so `at` belongs to the turn
 * that last touched the cache, not the turn that first wrote it.
 */
export interface PromptCache {
  /**
   * When the turn that last used the cache sent its last main-loop request,
   * as the driver reports it (`TurnResult.cacheAt`), or when that turn
   * finished for a driver that reports none.
   */
  at: Timestamp;
  /** Seconds the prefix is kept after `at`. */
  ttlSeconds: number;
  /**
   * Seconds the provider may keep it on a best-effort basis beyond
   * `ttlSeconds` (OpenAI: up to an hour under low load). Absent when the
   * lifetime is fixed.
   */
  maxSeconds?: number;
  /**
   * `reported`: the agent's own usage named the lifetime of this request
   * (Claude's `cache_creation.ephemeral_1h_input_tokens`). `documented`: the
   * provider's published lifetime for what this agent sends.
   */
  source: 'reported' | 'documented';
  /** Tokens the last turn read from the cache, zero on a turn that started cold. */
  readTokens: number;
  /** The model and account the cache belongs to: another model or account starts cold. */
  model: string | null;
  accountId: AccountId;
}

/** Latest observed execution event of the current turn, never a synthetic heartbeat. */
export interface ThreadProgress {
  turnId: TurnId;
  phase: 'starting' | 'thinking' | 'compacting' | 'retrying' | 'tool' | 'working' | 'waiting';
  detail: string | null;
  at: Timestamp;
  /** When the current phase began: `at` of its first event in a row. An older core leaves it out. */
  since?: Timestamp;
  /** Latest provider signal, including status notifications that do not advance activity. */
  providerAt?: Timestamp | null;
}

export interface ThreadArchiveReason {
  type: 'pr-merged';
  number: number;
  url: string;
  archivedAt: Timestamp;
}

/**
 * The core removed the worktree this thread worked in while it was archived.
 * `cwd` still names the folder, which no longer exists: the thread can be read
 * and restored but not continued there.
 */
export interface ThreadWorktreeRemoval {
  /** The folder that was removed, the thread's `cwd` at the time. */
  path: string;
  /** The branch checked out there, null on a detached HEAD. */
  branch: string | null;
  /** The local branch went too. A kept branch can be checked out again by hand. */
  branchDeleted: boolean;
  /** `pr-merged`: the checkout's exact tip was a merged PR's head. `clean`: no change and no commit missing from every other branch. */
  reason: 'pr-merged' | 'clean';
  pullRequest?: { number: number; url: string };
  removedAt: Timestamp;
}

/** Provenance of a copied conversation; native history and seeded history remain distinct. */
export const JOURNAL_INSPECTION_TABLES = ['threads', 'turns', 'messages', 'turn_requests', 'background_observations', 'coordination_letters'] as const;
export type JournalInspectionTable = typeof JOURNAL_INSPECTION_TABLES[number];
export interface JournalInspectionCursor { table: JournalInspectionTable; afterRowid: number }
export interface JournalInspectionIssue {
  table: JournalInspectionTable;
  rowId: number;
  code: 'missing-thread' | 'missing-turn' | 'turn-thread-mismatch' | 'terminal-streaming-message' | 'invalid-queue-hold'
    | 'oversized-json' | 'malformed-json' | 'invalid-fork-origin' | 'fork-origin-owner-mismatch'
    | 'invalid-background-observation' | 'background-owner-mismatch' | 'background-parent-mismatch'
    | 'request-message-mismatch' | 'invalid-letter-owner';
  field: string;
  /** Fixed diagnostic expectation, never stored text, IDs, payloads or credentials. */
  expected: string;
}
export interface JournalInspection {
  issues: JournalInspectionIssue[];
  checked: number;
  cursor: JournalInspectionCursor | null;
  /** Further rows remain. Concurrent pages do not form an atomic global integrity proof. */
  truncated: boolean;
}

export interface ForkOrigin {
  threadId: ThreadId;
  messageId: MessageId | null;
  turnId: TurnId | null;
  mode: 'native' | 'seeded';
}

export interface ThreadSummary {
  /**
   * The thread, or a conversation it continues, read contact mail sent
   * outside a shared project. That mail has no captured file authority, so
   * the core refuses every turn and tool until the owner trusts the history
   * (`threads.trustContactHistory`). Names the contacts it came from. Every
   * `threads.get` carries it, null when nothing holds the thread; a
   * `thread.updated` carries it only when the hold changed. Absent on older cores.
   */
  contactHold?: { contacts: string[] } | null;
  /** Date marked done, or automatically archived after a PR merge. Cleared on restore or manual archive. */
  doneAt?: Timestamp | null;
  /**
   * When the core last archived it, the order Ctrl+Shift+T and the archived
   * list follow on every client. Null once restored; missing on threads
   * archived by an older core, which fall back to `updatedAt`.
   */
  archivedAt?: Timestamp | null;
  forkOrigin?: ForkOrigin;

  /** Durable explanation for an automatic archive; absent for manual archives and restored conversations. */
  archiveReason?: ThreadArchiveReason;
  /** Set once the core removed this thread's worktree, kept after a restore while `cwd` still names it. */
  worktreeRemoved?: ThreadWorktreeRemoval | null;
  /** Core-owned delegation relationship. Absent on ordinary conversations. */
  parentThreadId?: ThreadId | null;
  /** Derived from the parent row, including archived bots; keeps project workers visible after reconnect. */
  parentIsBot?: true;
  /** What the conversation starts without, fixed at creation. Absent: the whole setup. */
  contextMode?: ThreadContextMode | null;
  /** Last accepted user message, independent of assistant activity and renames. */
  lastUserMessageAt?: Timestamp | null;
  pullRequest?: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null;
  id: ThreadId;
  projectId: ProjectId | null;
  /** Only persistent agent sessions and team chats have no project. */
  agentSessionId?: string;
  /** A team's chat (`docs/teams.md`): it runs no agent, a turn there is one post, and no agent reaches it as a coordination contact. */
  teamId?: string;
  /**
   * An incognito conversation of the drafts. It works in a folder of the
   * core's data directory rather than the drafts folder, lists stay quiet
   * about it, and `threads.remove` erases it with that folder at once, with no
   * undo. A core that stops or starts erases every incognito conversation it
   * still holds. Absent on ordinary conversations and on older cores.
   */
  incognito?: true;
  title: string;
  titleSource: TitleSource;
  /** Durable title revision and whether the first answer should resolve a vague initial subject. Missing on older cores. */
  titleState?: { version: number; needsRefinement: boolean };
  providerId: ProviderId;
  accountId: AccountId;
  model: string | null;
  /** One of the model's effort level ids. Null means the model's own default. */
  effort: string | null;
  speed?: string | null;
  cwd: string;
  /**
   * The git branch the thread works on when it started in its own worktree;
   * `cwd` is then that worktree, not the project. Null for a thread that works
   * in the project directory itself.
   */
  branch: string | null;
  /** Only automatically created temporary branches may be named by the title model. */
  branchNamingPending?: boolean;
  permissionMode: PermissionMode;
  status: ThreadStatus;
  /**
   * When the turn now running started, what a sidebar row counts its time
   * from. Also set while the turn waits on the user. Null when no turn runs;
   * missing on older cores.
   */
  runningSince?: Timestamp | null;
  /**
   * When the user's current request started: the start of the last turn the
   * user opened, kept through the turns Boite opened after it to carry on
   * (`continuesRequest`). What a row counts from while the agent works or
   * monitors, so a pause to watch CI does not reset it. Null when no turn runs
   * and nothing runs in the background; missing on older cores.
   */
  requestSince?: Timestamp | null;
  /** In memory only, cleared at turn end/restart. Missing on older cores. */
  progress?: ThreadProgress | null;
  /**
   * What the agent still runs in the background, a monitor or a shell it left
   * going past its turn: the kind of each task and when the oldest started,
   * so a row can say the thread is not finished. The tasks themselves are
   * `Thread.background`. Null when nothing runs; missing on older cores.
   */
  backgroundWork?: { kinds: BackgroundTask['kind'][]; since: Timestamp } | null;
  /**
   * A delegated agent whose turn ended on background work: still waiting for
   * it to wake the agent, or interrupted because it ended without doing so
   * (`backgroundWait`). Null otherwise and on threads that are not delegated
   * agents; missing on older cores.
   */
  backgroundWait?: BackgroundWait | null;
  /**
   * A move asked for while the thread's turn ran, applied when that turn
   * ends (`threads.move`, `agent.move`). In memory only: null after a core
   * restart, and missing on older cores.
   */
  pendingMove?: PendingMove | null;
  /**
   * The note the thread's next message will carry to its agent after the user
   * moved it (`threads.move`), so the open thread can say the agent has not
   * been told yet. Null once that message is sent, after a move back to the
   * folder the note started from, and after a move the agent made itself.
   * Survives a core restart; missing on older cores.
   */
  moveNote?: MoveNotice | null;
  /** Answers accepted by the core, waiting for the running agent or the next turn. In memory only. */
  pendingAnswers?: string[];
  /**
   * The pull requests the thread's agent watches (`threads.watchPullRequest`):
   * a thread at rest with one reads as watching, not done, since the watch
   * will wake it. Empty when none; missing on older cores.
   */
  pullRequestWatches?: PullRequestWatch[];
  /**
   * Questions the agent asked without stopping (`boite ask`, Codex's own)
   * that still wait for the user. The status stays `running` or `idle`, so a
   * row reads this to say the thread needs the user. Missing on older cores.
   */
  openQuestions?: number;
  unread: boolean;
  archived: boolean;
  /** Kept above the other threads of its project in the sidebar, whatever runs. */
  pinned: boolean;
  /** Provider session id once the first turn has run; used to resume. */
  sessionId: string | null;
  /**
   * The entry of `sessionId`'s native transcript the next turn resumes at,
   * forking the rest away: set by `threads.rewind` and `threads.fork` on a
   * driver that can cut its own transcript (Claude), cleared once the agent
   * answered on the forked session. Null or absent means resume the whole
   * session. Clients have nothing to do with it.
   */
  sessionResumeAt?: string | null;
  /** Changes when the account changes; native sessions never cross this boundary. */
  sessionGeneration?: number;
  /** Optimistic revision of the selection for future turns. Missing on older clients means zero. */
  selectionVersion?: number;
  load: ThreadLoad | null;
  /** The context meter, written at the end of every turn whose agent reports its usage. */
  context: ContextUse | null;
  /**
   * The prompt cache the last turn left behind, null when the provider's
   * lifetime is unknown or no turn has finished. Missing on older cores.
   */
  promptCache?: PromptCache | null;
  /**
   * What the core plans to try again by itself after a provider refused a
   * turn for availability (`ThreadRetry`). Null when nothing is planned;
   * missing on older cores.
   */
  retry?: ThreadRetry | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * An automatic retry the core planned after a provider refused a turn for
 * availability rather than for a fault of the request (docs/usage.md).
 * `capacity`: the model was at capacity; the same turn tries again at `at`,
 * the `attempt`th of `attempts` tries, and the thread stays running meanwhile.
 * `usage-limit`: the subscription window was spent and `autoResumeLimitedThreads`
 * is on; a new turn resumes the thread at `at`, shortly after `resetsAt`, and
 * the plan survives a core restart. `auto-continue`: a turn stopped before its
 * answer (an error, a crash, a compaction, interrupted background work); a
 * new turn resumes the thread at `at`, the `attempt`th of `attempts` resumes
 * in a row (`docs/restart-handoff.md`). `turns.cancelRetry` or Stop cancels any.
 */
export interface ThreadRetry {
  kind: 'capacity' | 'usage-limit' | 'auto-continue';
  /** The turn the provider refused, or the one that stopped before its answer. */
  turnId: TurnId;
  /** When the core tries again. */
  at: Timestamp;
  /** This try's number, from 1; always 1 for a usage limit. */
  attempt: number;
  attempts: number;
  /** When the spent window resets, for a usage limit; null for capacity. */
  resetsAt: Timestamp | null;
}

/**
 * A command the agent of a thread takes at the start of a prompt, sent as the
 * text `/name` followed by its input. Claude lists its skills here, an ACP agent
 * its `available_commands_update`, pi its `get_commands`. Boite's own commands
 * are the client's and never in this list.
 */
export interface AgentCommand {
  /** Without the leading slash. */
  name: string;
  description: string | null;
  /** What goes after the name, as the agent words it (`<file>`), or null. */
  hint: string | null;
}

export interface AgentTask {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** One review of a reviewed goal (`/goal2`): a fresh conversation that judged the work. */
export interface GoalVerdict {
  round: number;
  /** `missing`: the reviewer ended without a `VERDICT:` line, which counts as not passing. */
  verdict: 'pass' | 'partial' | 'fail' | 'missing';
  /** The reviewer's findings above its verdict line, at most 2000 characters. */
  summary: string;
  /** The reviewer's own conversation, a child of the goal's thread. */
  threadId: ThreadId;
  finishedAt: Timestamp;
}

/**
 * Set on a goal started with `/goal2`. The agent's `[BOITE_GOAL_COMPLETE]` is a
 * claim: a reviewer in a new child conversation, with none of the agent's
 * context, checks the checkout and answers PASS, PARTIAL or FAIL. Anything but
 * PASS goes back to the agent as the next round's feedback.
 */
export interface GoalReview {
  phase: 'working' | 'reviewing';
  /** Reviews before the goal stops for the user; each reply then allows one more. */
  maxRounds: number;
  /** The reviewer conversation of the review in progress, else null. */
  reviewerThreadId: ThreadId | null;
  /** The agent turn whose completion claim is under review. */
  claimTurnId: TurnId | null;
  /** How many verdicts the agent has already been sent. */
  delivered: number;
  /** Oldest first, at most `maxRounds` plus one per reply after it. */
  verdicts: GoalVerdict[];
}

/** One thing the user asked for in a `/goal2`, as its tracker wrote it. */
export interface GoalChecklistItem {
  /** From 1, in the order the items were written; never reused. */
  id: number;
  /** A verb and a visible result in the user's language, at most `GOAL_CHECKLIST_TEXT_MAX` characters. */
  text: string;
  /** The words of the user's message it comes from, at most `GOAL_CHECKLIST_SOURCE_MAX` characters. */
  source: string;
  /** `done`: a check saw it done. `cancelled`: a later message of the user dropped it. */
  status: 'open' | 'done' | 'cancelled';
  /** Added by a message after the objective. */
  added?: boolean;
  /** Changed by a message after the objective. */
  changed?: boolean;
  /** Completion claims sent back to the agent because this item was still open; at 2 it no longer holds one. */
  bounced?: number;
}

/**
 * A `/goal2`'s checklist. A tracker conversation, a child of the goal's
 * thread with none of its history, writes it from the objective, updates it
 * on every later message of the user, and after each turn of the agent marks
 * what the turn did. What stays open goes to the agent's next goal turn; a
 * completion claim with an open item goes back to the agent before any review.
 * The tracker reads only what Boite hands it: it runs nothing and edits nothing.
 */
export interface GoalChecklist {
  /** The tracker conversation; null before it starts or when it could not. */
  threadId: ThreadId | null;
  /** `writing`: reading the objective or a new message. `checking`: reading the agent's last turn. */
  phase: 'idle' | 'writing' | 'checking';
  items: GoalChecklistItem[];
  /** The tracker's provider, model and effort, as `claude/claude-opus-5-5`, for the panel. */
  model: string | null;
  effort: string | null;
  /** Why the last pass gave nothing; the goal goes on without it. */
  error: string | null;
}

/** What an automated goal or loop turn carries on its user message, for the driver prompt. */
export interface ActivityTurn {
  kind: 'goal' | 'loop';
  iteration: number;
  /** A reviewed goal's first turn after a failed review: what the reviewer reported. */
  review?: { round: number; feedback: string };
  /**
   * A `/goal2` turn after its tracker's check: the checklist items still open.
   * `bounced`: the agent claimed completion with them open, so no review ran.
   */
  checklist?: { open: string[]; bounced: boolean };
}

export interface ThreadActivity {
  /**
   * `blocked`: the agent ended a goal turn with `[BOITE_GOAL_BLOCKED]` and
   * waits for the user. The goal is paused; the user's next message resumes it.
   * `auto`: the core started this reviewed goal by itself, from a long prompt
   * or `boite goal track` (the `auto-goal` experiment, `docs/goals.md`).
   */
  goal: { objective: string; status: 'active' | 'paused' | 'complete'; iterations: number; error: string | null; dismissed?: boolean; blocked?: boolean; review?: GoalReview; checklist?: GoalChecklist; auto?: true } | null;
  loop: { prompt: string; intervalMs: number; maxIterations?: number | null; status: 'active' | 'paused' | 'complete'; iterations: number; nextRunAt: number | null; error: string | null; history?: ActivityIteration[] } | null;
  tasks: AgentTask[];
  tasksDismissed?: boolean;
}

export interface ActivityIteration {
  iteration: number;
  turnId: TurnId;
  status: 'running' | 'done' | 'error' | 'stopped';
  summary: string;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
}

export interface Thread extends ThreadSummary {
  /** The latest 100 memory notices, oldest first, including those missed while disconnected. */
  memoryEvents?: MemoryEvent[];
  activity?: ThreadActivity;
  /**
   * Set when `threads.get` answered an `after`: `messages` starts at this
   * message, `turns` are theirs, and `messagesBefore` says nothing. The caller
   * keeps every message it held before this one. Set only for a complete tail
   * within the message count and serialized byte limits.
   */
  messagesFrom?: MessageId;
  /** Opaque proof of the complete resume tail, including deferred tool output. Never persisted. */
  messagesSync?: MessageSync;
  /** The requested tail still matches messagesSync; reuse it instead of replacing it with messages. */
  messagesUnchanged?: true;
  /** A bounded tail within the serialized page budget, oldest first. Older messages come from `messages.list`. */
  messages: Message[];
  /**
   * What the agent of this thread last said it takes as `/name`. Empty until a
   * session of this core reported them: the list is the agent's, kept in
   * memory, and `thread.commands` follows every change.
   */
  commands: AgentCommand[];
  /**
   * What the agent still runs in the background (`thread.background`). Kept in
   * memory like `commands`; missing on older cores.
   */
  background?: BackgroundTask[];
  /** Durable native task observations, including terminal observations after restart. */
  backgroundHistory?: BackgroundTaskObservation[];
  /**
   * The oldest message `messages` carries, when the thread has older ones behind
   * it; null when this page is the whole thread. It is the cursor `messages.list`
   * takes as `before`.
   */
  messagesBefore: MessageId | null;
  /**
   * The newest message `messages` carries, when the page was cut around a
   * message and the thread has newer ones after it: the cursor `messages.list`
   * takes as `after`. Absent or null when the page reaches the last message,
   * which is the only page live messages are appended to.
   */
  messagesAfter?: MessageId | null;
  /**
   * How many messages of the thread come before `messages[0]`, or before
   * `messagesFrom` on a resume tail: with it, a client sizes the history it
   * does not hold and reads any stretch of it with `messages.list` `from`.
   * Cores without `features.messagePositions` leave it out.
   */
  messageOffset?: number;
  /** The turns `messages` refers to, plus any still queued or running; never the whole history. */
  turns: Turn[];
}

export interface MessageSync {
  from: MessageId;
  hash: string;
}

/** An opt-in opening reads requests and changes this socket's subscription in the same RPC. */
export interface ThreadSnapshot extends Thread {
  opened?: { permissions?: PermissionRequest[]; questions?: QuestionRequest[] };
}

/** What `threads.rewind` answers: the thread after the cut and the removed message, ready for the composer. */
export interface ThreadRewind {
  /** As `threads.get` would answer now: the last page of what is left. */
  thread: Thread;
  /** What the user typed, without the page context a preview reference added to it. */
  prompt: string;
  /** The images and files the removed message carried, as `turns.start` takes them. */
  attachments: Attachment[];
  /** The page elements the removed message referred to, empty when none. */
  previewReferences: PreviewReference[];
  /**
   * How the agent forgets the removed part. `native`: the driver resumes its
   * own transcript at the cut. `seeded`: the next turn starts a fresh session
   * carrying the kept history, as a change of account does.
   */
  session: 'native' | 'seeded';
  /**
   * File changes restored before the cut. Missing on older cores. `busy`:
   * another turn was working in the same folder, so the files were left as
   * they are and only the messages were rewound.
   */
  files?: { status: 'restored' | 'unchanged' | 'unavailable'; count: number; reason?: string; busy?: true };
}

/**
 * Where an answer of `threads.listChanges` left a client: the core's run (a
 * new id each time the core starts) and its count of summary changes then.
 */
export interface ListCursor {
  run: string;
  seq: number;
}

/**
 * `full`: every thread `threads.list({})` answers, in its order. It comes
 * when no cursor was given, the core restarted (`run` differs), or the core
 * no longer remembers every thread changed since (`LIST_CHANGES_IDS`).
 *
 * `changes`: the unarchived threads changed since the cursor, plus every
 * thread with running processes, so a held row absent from `threads` has no
 * load. `removed` are threads changed since that are now deleted or
 * archived. A held row in neither list is unchanged.
 */
export type ThreadListChanges =
  | { kind: 'full'; cursor: ListCursor; threads: ThreadSummary[] }
  | { kind: 'changes'; cursor: ListCursor; threads: ThreadSummary[]; removed: ThreadId[] };

export interface ThreadsRpcMethods {
  /** Owner-only, private bounded diagnostic history, including earlier runs. */
  'journal.inspect': { params: { cursor?: JournalInspectionCursor | null; limit?: number }; result: JournalInspection };
  /**
   * Attachments accompany the first turn of a single new goal or loop, then remain in its conversation history.
   * `goal.review` starts a reviewed goal (`/goal2`, see `GoalReview`).
   */
  'threads.activity.set': { params: { threadId: ThreadId; goal?: { objective: string; review?: boolean } | null; loop?: { prompt: string; intervalMs: number; maxIterations?: number | null } | null; attachments?: Attachment[] }; result: ThreadActivity };
  'threads.activity.control': { params: { threadId: ThreadId; kind: 'goal' | 'loop'; action: 'pause' | 'resume' | 'remove' | 'complete' }; result: ThreadActivity };
  /**
   * `boite goal track`: an automatic reviewed goal on the thread whose
   * objective is the user's last prompt, verbatim. Refused while the
   * `auto-goal` experiment is off on the desktop app, while a goal or loop is
   * under way, and when that prompt already started one.
   */
  'threads.goal.track': { params: { threadId: ThreadId }; result: ThreadActivity };
  /** The agent's task list, whole, as the tasks surface shows it. */
  'threads.tasks.set': { params: { threadId: ThreadId; tasks: AgentTask[] }; result: ThreadActivity };
  'threads.tasks.get': { params: { threadId: ThreadId }; result: AgentTask[] };

  'threads.list': { params: { projectId?: ProjectId; includeArchived?: boolean }; result: ThreadSummary[] };
  /**
   * The sidebar's list, `threads.list({})`, read again after a reconnect:
   * whole without `since`, else only what changed since that answer
   * (`features.listChanges`). See `ThreadListChanges`.
   */
  'threads.listChanges': { params: { since?: ListCursor }; result: ThreadListChanges };
  /** Read the thread's own branch PR using the execution machine's GitHub CLI. Null when the thread has no branch. */
  /** `refresh`: a user asked, so what the core kept for this repository is read again, and a missing gh is tried again. */
  'threads.pullRequest': { params: { threadId: ThreadId; refresh?: boolean }; result: ThreadSummary['pullRequest'] };
  'threads.create': {
    params: {
      projectId: ProjectId;
      providerId: ProviderId;
      accountId: AccountId;
      title?: string;
      cwd?: string;
      model?: string;
      effort?: string | null;
      speed?: string | null;
      permissionMode?: PermissionMode;
      /**
       * Start the thread in a git worktree of the project on a branch of its
       * own: a short temporary `boite/wt-<id>` unless `branch` names one.
       * The title model can name that temporary branch after the first turn;
       * the working directory stays fixed when the branch is renamed. The core
       * runs `git worktree add` and refuses by name when the project is not a
       * git repository, git is missing, or the named branch already exists.
       * Explicit names must fit `BRANCH_NAME_MAX`, including any prefix.
       * Excludes `cwd`. Refused on the drafts project, which is not a repository.
       */
      worktree?: { branch?: string };
      /**
       * Start an incognito conversation (`ThreadSummary.incognito`). Accepted
       * on the drafts project only, and refused with `cwd` or `worktree`: the
       * core makes its folder.
       */
      incognito?: boolean;
      /** Start without part of the user's setup, fixed for the thread's life ([context modes](../../docs/context-modes.md)). */
      context?: ContextRequest | ContextPreset;
      /** Adopt this connection's compatible, prompt-free draft reservation. */
      preparationId?: string;
      /** Subscribe this connection before returning the newly created conversation. */
      subscribe?: boolean;
      /**
       * The client's id for this creation, 1 to 128 characters. Asked again
       * under the same id within an hour, with the same parameters (project,
       * provider, account, title, folder, model, effort, speed, mode,
       * worktree, incognito, context), the core answers with the conversation
       * the first call made instead of making another; with other ones it
       * refuses. A
       * conversation queued while its machine was away is started this way.
       * Kept in memory: a core restart forgets it. An older core ignores it.
       */
      clientRequestId?: string;
    };
    result: ThreadSummary;
  };
  /** The system prompt, tools and parameters of a Claude thread's last request, read from its transcript. Refused on other providers. */
  'threads.agentShape': { params: { threadId: ThreadId }; result: AgentShape };
  /** Supported operations and their current availability for this thread. */
  'threads.capabilities': { params: { threadId: ThreadId }; result: ThreadCapabilities };
  /**
   * The thread with its last `MESSAGE_PAGE` messages and the cursor for what is
   * behind them. Opening a thousand-message thread costs one page, not the lot.
   */
  /**
   * `after` is for a client that already holds the thread, a reconnect or a
   * reopen: the answer then carries that message and the ones written after it
   * rather than the whole page, and says so in `messagesFrom`. The client names
   * the first message it cannot vouch for, the oldest one of a turn it has not
   * seen finish, or its last one. An `after` the thread does not hold, or one
   * with more than a page's count or serialized byte budget behind it, is
   * answered with the full page, without `messagesFrom`.
   *
   * `around` is the message a reader was last looking at. When more than
   * `limit` messages were written after it, the answer is the page centred on
   * it, with `messagesAfter` set; otherwise it is the last page, which holds
   * it. An `around` the thread does not hold gets the last page; `after` wins
   * over it. `compactImages` defers large images as `compactFiles` defers
   * files. Both need `features.readingPages`. `compactToolParts` leaves long
   * tool inputs and heavy documents on the core as well, and caps each message
   * at `MESSAGE_SENT_MAX_BYTES`; it needs `features.deferredToolParts`. A
   * subscription opened with it receives live tool parts the same way.
   *
   * `maxBytes` lowers the page's byte budget below `MESSAGE_PAGE_MAX_BYTES`,
   * counted as the client receives the messages: a first visit asks for what
   * fills a screen (`INITIAL_PAGE_BYTES`). It bounds a page, around a saved
   * position too, never a resume tail, which comes whole or not at all. Older
   * cores ignore it and send their page.
   */
  'threads.get': {
    params: {
      threadId: ThreadId; after?: MessageId; around?: MessageId; limit?: number; maxBytes?: number; compactTools?: boolean; compactFiles?: boolean; compactImages?: boolean; compactToolParts?: boolean;
      /** Request a resume proof, or reuse a proof previously supplied by this core. */
      sync?: true | MessageSync;
      /** Subscribe after a successful snapshot, optionally replacing the previous subscription and acknowledging unread content. */
      open?: { previous?: ThreadId; requests?: boolean; markRead?: boolean };
    };
    result: ThreadSnapshot;
  };
  'threads.update': {
    params: {
      threadId: ThreadId;
      /** Select another account/provider for future turns in this conversation. */
      accountId?: AccountId;
      expectedSelectionVersion?: number;
      title?: string;
      model?: string | null;
      effort?: string | null;
      speed?: string | null;
      permissionMode?: PermissionMode;
    };
    result: ThreadSummary;
  };
  /**
   * A title written from the thread's first prompt and first answer. The
   * model `Settings.titleModel` names writes it, else the thread's own agent
   * on its small model when its driver can (Claude and Codex on one short
   * call, echo in memory); the core cuts the first line of the prompt
   * otherwise. Refused by name on a thread that has no prompt yet, or while
   * a title is already being written for it. The answer is the thread as
   * saved, `titleSource` saying which of the two wrote it.
   */
  'threads.retitle': { params: { threadId: ThreadId }; result: ThreadSummary };
  'threads.compact': { params: { threadId: ThreadId; expectedSelectionVersion?: number }; result: Turn };
  /** An ephemeral answer from a snapshot of the chat, without starting or steering its main turn. */
  'threads.btw': { params: { threadId: ThreadId; question: string; requestId: string }; result: { requestId: string } };
  'threads.btw.cancel': { params: { threadId: ThreadId; requestId: string }; result: { ok: true } };
  /** Persist a completed side answer and its frozen context in a fresh conversation. */
  'threads.btw.fork': { params: { threadId: ThreadId; requestId: string }; result: ThreadSummary };
  /**
   * Edit a sent message: `messageId`, a user message of the thread, and every
   * message and turn after it leave the conversation, and the next turn
   * continues from just before it, the agent's own memory included. The answer
   * is the thread as it now stands and the removed message's content, for the
   * composer. Refused while a turn runs or waits in the queue (stop it first),
   * for a message that is not a user message of that thread, and on a
   * persistent agent session, each naming the field and what it expected.
   * Every client subscribed to the thread gets `message.truncated`. The journal
   * keeps the removed messages' events; the removed turns keep their usage.
   */
  'threads.rewind': { params: { threadId: ThreadId; messageId: MessageId }; result: ThreadRewind };
  /**
   * A new thread holding a copy of this thread's history up to and including
   * `messageId`, whose next turn continues from there; the original thread is
   * untouched. `worktree: true` puts it in a git worktree of its own, as
   * `threads.create` does with `worktree: {}`; false or absent works in the
   * same folder. Refused while the named message is still streaming, and on a
   * persistent agent session.
   */
  'threads.mergeBack': { params: { threadId: ThreadId; summary: string; requestId: string }; result: AgentLetter };
  'threads.fork': { params: { threadId: ThreadId; messageId: MessageId; worktree?: boolean }; result: ThreadSummary };
  /**
   * Move a thread to another project of the same core. Its folder becomes the
   * target's: the project folder, a new git worktree of the target when the
   * thread had a worktree of its own and the target is a repository, or a new
   * draft folder when the target is the drafts project. The old folder or
   * worktree stays on disk untouched. The agent never works in the old folder
   * again: its warm process is dropped, and the next user message tells it the
   * thread moved (`MoveNotice` on that message's text part). Sub-threads follow
   * their parent. A target project put away comes back. Refused for an unknown
   * thread or project, the same project, an archived thread, a sub-thread, a
   * persistent agent session, a missing target folder, a turn running or
   * queued on one of its sub-threads (`reason: 'turn-in-flight'`), and
   * background work without `stopBackground` (true stops it, false leaves it
   * running in the old folder until the agent's next turn). Every client gets
   * `thread.updated` with the new `projectId`, `cwd` and `branch`.
   *
   * A thread whose own turn runs, waits or is queued is not refused: the move
   * is recorded as `pendingMove` on the answered row and happens when that
   * turn ends, however it ends, through the same path as the agent's own move.
   * A second move replaces a pending one; archiving the thread drops it. The
   * pending move lives in memory and a core restart forgets it.
   */
  'threads.move': { params: { threadId: ThreadId; projectId: ProjectId; stopBackground?: boolean }; result: ThreadSummary };
  /**
   * Drop the move waiting for the thread's turn to end (`pendingMove`), the
   * user's or the agent's. Answers the row without it; a thread with no
   * pending move is refused naming `threadId`.
   */
  'threads.moveCancel': { params: { threadId: ThreadId }; result: ThreadSummary };
  /**
   * Put a thread away, or bring it back with `archived: false`. Archiving
   * stops its turn and its sub-threads' turns at once and answers; their
   * processes end once those turns have settled. Restoring restarts nothing.
   * `onlyIfIdle: true` marks done, recording its expiry date after refusing active work in the family.
   * Unsent drafts do not block this explicit action.
   */
  'threads.archive': { params: { threadId: ThreadId; archived?: boolean; onlyIfIdle?: boolean }; result: ThreadSummary };
  /**
   * Hide a conversation and its sub-threads after stopping their work. The
   * owner can restore their history across restarts until the configured
   * retention expires, measured from deletion. Files and Git branches remain.
   * An incognito conversation is erased at once instead, its folder with it,
   * and its `thread.removed` says `undoable: false`.
   */
  'threads.remove': { params: { threadId: ThreadId }; result: { ok: true } };
  /** Owner-only recoverable deleted conversations, newest first. */
  'threads.deleted': { params: Record<string, never>; result: DeletedThreadSummary[] };
  /** Undo deletion without restarting agents; restore each thread's previous archive state. Owner only. */
  'threads.restore': { params: { threadId: ThreadId }; result: ThreadSummary };
  /** Pin or unpin (`pinned: false`) a thread. An archived thread keeps its pin for when it comes back. */
  'threads.pin': { params: { threadId: ThreadId; pinned?: boolean }; result: ThreadSummary };
  'threads.markRead': { params: { threadId: ThreadId }; result: { ok: true } };
  /**
   * Owner only. Accept the contact mail outside a shared project that the
   * thread's history consumed (`Thread.contactHold`), so its turns and tools
   * run again. Mail of a shared project keeps its captured boundary, and a
   * later letter outside one holds the thread again.
   */
  'threads.trustContactHistory': { params: { threadId: ThreadId }; result: { ok: true } };
  /** Only subscribed threads stream message events to this connection. */
  'threads.subscribe': { params: { threadId: ThreadId }; result: { ok: true } };
  'threads.unsubscribe': { params: { threadId: ThreadId }; result: { ok: true } };
  /** The visible conversation and unsent input leases. Omitted leases remain; an empty list clears them.
   * A focus caller without an input report blocks automatic archive until it reports leases or disconnects.
   * `attentive`: the user is looking at `threadId` now, so the core holds push about it back (`thread-focus.ts`).
   * `idleMs`: how long ago the user last used this page while it was attentive; use after an event drops its held push. */
  'threads.focus': { params: { threadId: ThreadId | null; protectedThreadIds?: ThreadId[]; protectAllThreads?: boolean; attentive?: boolean; idleMs?: number }; result: { ok: true } };
}

export interface ThreadsRpcEvents {
  'thread.memory': MemoryEvent & { threadId: string };
  'thread.activity': { threadId: ThreadId; activity: ThreadActivity };

  'thread.created': ThreadSummary;
  'thread.updated': ThreadSummary;
  /**
   * A thread's load sample alone, at most once a second while it moves: the
   * client patches `load` on the row it holds and nothing else. Sent only to
   * a connection whose hello `accepts` it; any other receives the whole row
   * as `thread.updated`.
   */
  'thread.load': { threadId: ThreadId; load: ThreadLoad };
  'thread.removed': { threadId: ThreadId; undoable?: boolean };
  /** The owner-only deletion list changed, including purge and removal with a project. */
  'thread.deletionsUpdated': Record<string, never>;
  /** The agent's `/name` commands, whole, each time the list it reports changes. */
  'thread.commands': { threadId: ThreadId; commands: AgentCommand[] };
  /** What the agent still runs in the background, whole, each time it changes. */
  'thread.btw': { threadId: ThreadId; requestId: string; answer: string | null; error: string | null };
  'thread.background': { threadId: ThreadId; tasks: BackgroundTask[]; history?: BackgroundTaskObservation[] };
}
