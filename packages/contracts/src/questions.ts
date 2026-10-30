import type { AgentSettingAsk } from './agent-setting-requests.ts';
import type { ProviderId, RequestId, ThreadId, Timestamp, TurnId } from './ids';
import type { Attachment } from './messages';
import type { SettingAsk } from './setting-requests.ts';
import type { TeamAsk } from './teams';
import type { ThreadStatus, ThreadSummary } from './threads';
import type { Turn } from './turns';
import { threadActive } from './turns';

// ---------------------------------------------------------------------------
// Questions: what an agent asks the user that is not a tool call.
// ---------------------------------------------------------------------------

/** One choice on a question card. */
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

/** What the user picked. `text` is the free field, when the question has one. */
export interface QuestionAnswer {
  optionIds: string[];
  text?: string;
  /**
   * The files given with the answer, as the card lists them. Their bytes are
   * not kept here: the core wrote them to its disk and told the agent the paths.
   */
  attachments?: AnswerAttachment[];
  /** On a settings card the user changed: the value the setting holds now. */
  value?: unknown;
}

/** A file given with an answer: what the card shows once it is answered. */
export interface AnswerAttachment {
  kind: Attachment['kind'];
  mimeType: string;
  name: string | null;
  bytes: number;
}

/**
 * A question waiting for the user. A driver whose protocol asks something that
 * is not a permission maps it here, one request per question, in order.
 */
export interface QuestionRequest {
  id: RequestId;
  threadId: ThreadId;
  turnId: TurnId;
  text: string;
  options: QuestionOption[];
  /** No options plus this true is a plain free-text prompt. */
  allowText: boolean;
  multiple: boolean;
  /**
   * The agent did not stop for it. The thread is not `waiting`, the card
   * outlives its turn, and the answer reaches the agent as a steer when a turn
   * is running or as the next prompt when none is.
   */
  async?: boolean;
  /**
   * A settings card (`settings.request`): the agent asks for a change, or
   * points at a page. `text` is its reason. Always asynchronous.
   */
  setting?: SettingAsk;
  /**
   * An agent setting card (`agents.settings.request`): a thread, or a
   * persistent agent about itself, proposes a change to an agent's settings.
   * `text` is its reason. Always asynchronous.
   */
  agentSetting?: AgentSettingAsk;
  /**
   * A bot proposes a team, an invitation or its leaving (`teams.propose`,
   * `invite`, `leave`). `text` is the proposal. The only option is Refuse:
   * Apply is the owner's `teams.create`, `teams.members.add` or `remove` with
   * this card. Always asynchronous.
   */
  team?: TeamAsk;
  /** A page the card opens in the thread's browser (`boite ask --open`), as for a sign-in. */
  open?: { url: string };
  createdAt: Timestamp;
}

/**
 * Work the agent left running beyond one tool call: a shell started in the
 * background, a subagent, a monitor or a workflow. The list is the agent's
 * own, whole, each time it changes, and lives as long as the agent process.
 */
export interface BackgroundTask {
  id: string;
  kind: 'shell' | 'agent' | 'monitor' | 'workflow' | 'other';
  description: string;
  /** The tool call that started it, when the agent says so. */
  toolId: string | null;
  startedAt: Timestamp;
}

/** Observed native provider work; separate from Boite delegated child threads. */
export interface BackgroundTaskObservation extends BackgroundTask {
  threadId: ThreadId;
  providerId: ProviderId;
  sessionGeneration: number;
  parentTurnId: TurnId | null;
  /** Last task turn that left this observation running; absent only on legacy history. */
  checkpointTurnId?: TurnId | null;
  state: 'running' | 'completed' | 'error' | 'cancelled' | 'ended';
  observedAt: Timestamp;
  finishedAt: Timestamp | null;
  reason: 'provider-reported' | 'no-longer-reported' | 'session-ended' | 'core-restarted' | null;
}

/**
 * How long a thread whose background work just ended still counts as waiting
 * for it: the agent answers the task's notification by itself, usually within
 * a second or two, and opens the turn that wakes it.
 */
export const BACKGROUND_WAKE_GRACE_MS = 30_000;

/**
 * Why background work a thread waited on ended without waking it. `error` and
 * `cancelled` are what the agent reported for the task; `no-longer-reported`
 * means the agent stopped listing it without a word (its process died);
 * `session-ended` means the agent process was ended (a Stop, an archive, a
 * switch); `core-restarted` means Boite or the PC restarted.
 */
export type BackgroundInterruption = 'error' | 'cancelled' | 'no-longer-reported' | 'session-ended' | 'core-restarted';

/**
 * A thread whose last turn ended while background work it started still ran.
 * `waiting`: that work will wake it, so it is not finished; `for` names the
 * tasks, `since` is when the oldest started, `until` is when a wake that has
 * not come yet stops being expected (null while a task still runs).
 * `interrupted`: the work ended without waking it; a new message resumes it.
 */
export type BackgroundWait =
  | { state: 'waiting'; for: string; since: Timestamp; until: Timestamp | null }
  | { state: 'interrupted'; for: string; reason: BackgroundInterruption; at: Timestamp };

/** Durable checkpoint membership distinguishes both event orders within one millisecond. */
export function backgroundLeftBy(turn: Pick<Turn, 'id' | 'finishedAt'>, history: readonly BackgroundTaskObservation[]): BackgroundTaskObservation[] {
  if (turn.finishedAt === null) return [];
  return history.filter(task => task.state !== 'running' && task.finishedAt !== null &&
    (task.checkpointTurnId !== undefined
      ? task.checkpointTurnId === turn.id
      : task.finishedAt > turn.finishedAt! && task.startedAt <= turn.finishedAt!));
}

/**
 * What a thread at rest still waits on, from its last turn, the background
 * tasks its agent runs now and the observed history of those tasks. The core
 * and the in-memory client derive it the same way. Null while a turn is
 * under way, after a turn that did not finish (`done`), and once every task
 * the turn left running completed: the thread is then simply done.
 */
export function backgroundWait(input: {
  status: ThreadStatus;
  lastTurn: Pick<Turn, 'id' | 'status' | 'finishedAt'> | null;
  live: readonly BackgroundTask[];
  history: readonly BackgroundTaskObservation[];
  now: Timestamp;
}): BackgroundWait | null {
  const { lastTurn } = input;
  if (threadActive(input.status) || lastTurn?.status !== 'done' || lastTurn.finishedAt === null) return null;
  const names = (tasks: readonly BackgroundTask[]) => [...new Set(tasks.map(task => task.description.trim() || task.kind))].join(', ');
  if (input.live.length > 0) return { state: 'waiting', for: names(input.live), since: Math.min(...input.live.map(task => task.startedAt)), until: null };
  const ended = backgroundLeftBy(lastTurn, input.history);
  if (ended.length === 0) return null;
  const failed = ended.filter(task => task.state !== 'completed');
  const reasonOf = (task: BackgroundTaskObservation): BackgroundInterruption =>
    task.reason === 'session-ended' || task.reason === 'core-restarted' || task.reason === 'no-longer-reported' ? task.reason : task.state === 'cancelled' ? 'cancelled' : 'error';
  // Nothing is left to wake the thread once its agent process is gone.
  const gone = failed.find(task => task.reason === 'session-ended' || task.reason === 'core-restarted');
  const last = Math.max(...ended.map(task => task.finishedAt!));
  if (gone) return { state: 'interrupted', for: names(failed), reason: reasonOf(gone), at: last };
  if (input.now < last + BACKGROUND_WAKE_GRACE_MS) return { state: 'waiting', for: names(ended), since: Math.min(...ended.map(task => task.startedAt)), until: last + BACKGROUND_WAKE_GRACE_MS };
  if (failed.length > 0) return { state: 'interrupted', for: names(failed), reason: reasonOf(failed[0]!), at: last };
  return null;
}

/** A thread at work: a turn under way, or a turn ended on background work that will wake it. */
export function threadBusy(thread: Pick<ThreadSummary, 'status' | 'backgroundWait'>): boolean {
  return threadActive(thread.status) || thread.backgroundWait?.state === 'waiting';
}

export interface QuestionsRpcMethods {

  /**
   * The questions still unanswered, oldest first; every thread when `threadId`
   * is omitted. Same reason as `permissions.list`: a client that connects while
   * a turn waits rebuilds the card from here.
   */
  'questions.list': { params: { threadId?: ThreadId }; result: QuestionRequest[] };
  /**
   * One answer. `optionIds` are ids the question listed and `text` the free
   * field it allowed. A question that is not pending is refused, naming the id.
   * `attachments` (only where the free field is allowed, a turn's caps) are
   * written to the core's disk and reach the agent as paths after the text, on
   * every protocol: none carries an image inside an answer.
   */
  'questions.answer': {
    params: { threadId: ThreadId; questionId: RequestId; optionIds: string[]; text?: string; attachments?: Attachment[] };
    result: { ok: true };
  };
  /**
   * Open a pending question's page (`open`) as a new tab of its conversation's
   * browser. The core reads the address from the question, so a paired phone
   * subscribed to the conversation opens it without `panel.open`'s surfaces.
   */
  'questions.openPage': {
    params: { threadId: ThreadId; questionId: RequestId };
    result: { ok: true };
  };
  /** Resolve a pending question without an answer, a steer or a new user message. */
  'questions.skip': {
    params: { threadId: ThreadId; questionId: RequestId };
    result: { ok: true };
  };
  /**
   * An asynchronous question from the agent of a thread (`boite ask`): the card
   * is drawn in the running turn, the agent keeps working, and the answer
   * reaches it later as a steer or as the next prompt. `options` are labels;
   * none makes a free-text question.
   */
  'questions.ask': {
    params: { threadId: ThreadId; text: string; options?: string[]; multiple?: boolean; open?: string };
    result: { questionId: RequestId };
  };
}

export interface QuestionsRpcEvents {

  /** A client that missed this one reads the question from `questions.list`. */
  'question.asked': QuestionRequest;
  /** The answer, or null when the turn ended before one came. */
  'question.answered': { questionId: RequestId; threadId: ThreadId; answer: QuestionAnswer | null };
}
