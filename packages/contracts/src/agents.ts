import type { DelegationConfig, DelegationProfile, PermissionMode, RequestId } from './index';
import type { AgentSettingApplyParams, AgentSettingAsk, AgentSettingRequestParams, AgentSettingsReading, AgentSettingsReadParams } from './agent-setting-requests';
import type { AgentCreateParams, AgentCreateResult } from './agent-create';

/**
 * A persistent agent is a thread with an identity. Its conversation is its own
 * thread (`AgentSession.threadId`), drawn and driven like any thread: the
 * user's messages are turns, the queue, steering, tool cards, questions,
 * permissions, subagents and the side panel all work there. What the agent adds
 * is a persona, a brain folder (AGENTS.md, MEMORY.md, skills/), a clock
 * (routines), a desk of the threads it runs or watches, and wakes: turns the
 * core starts on its thread when a routine is due or something happens in its
 * projects. A wake that needs nothing from the user ends its answer with a line
 * `[quiet] <what it checked>`; clients fold that turn and nothing is unread.
 */
export interface AgentRuntimeConfig {
  defaultRoute: AgentSelection;
  allowedRoutes: DelegationProfile[];
  subagents: DelegationConfig;
  /**
   * After a turn whose answer the user sees, a small subagent rewrites
   * MEMORY.md from what was asked and answered, off the agent's path: the next
   * turn never waits for it. On unless the owner turns it off.
   */
  autoMemory?: boolean;
  /**
   * Every project and desk fact wakes this bot. Default false: then only facts
   * about threads it started, was entrusted or watches (`boite bot watch`), and
   * outside events (`agents.event`), wake it; the rest wait for its next routine.
   */
  eventWakes?: boolean;
  /**
   * What the agent may spend in a day in API-equivalent dollars, counted from
   * local midnight: its turns and its children's (subagents, workflow steps,
   * memory pass), priced from usage the way `usage.history` prices them. Past
   * it, wakes are skipped with a line in its thread; its children and the
   * user's own messages still run. Null or missing: no cap.
   */
  dailyBudgetUsd?: number | null;
}
export interface AgentAccountGrant { accountId: string; agentIds: string[] | null }
export interface AgentBrain {
  /** The agent's brain folder: under the brain root the owner chose, else in the core's data directory. */
  path: string;
  instructions: string;
  memory: string;
  revision: string;
}
/** The size MEMORY.md is kept under: the memory pass consolidates to it, a turn reads at most this much. */
export const AGENT_MEMORY_MAX = 16_000;
/** Routines one agent may hold; a save past it is refused with the count. */
export const AGENT_ROUTINES_MAX = 50;
/** A routine's name and prompt, in characters. */
export const AGENT_ROUTINE_NAME_MAX = 80;
export const AGENT_ROUTINE_PROMPT_MAX = 4000;
/**
 * A daily schedule with `days` runs only on those weekdays, numbered 0 (Sunday) to 6 in
 * its timezone. Absent means every day; the core drops a list of all seven.
 */
export type AgentSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string; timezone: string; days?: number[] }
  /** Months without this day are skipped. */
  | { kind: 'monthly'; day: number; time: string; timezone: string }
  /** Invalid dates in a year (February 29) are skipped. */
  | { kind: 'yearly'; month: number; day: number; time: string; timezone: string };
export interface AgentRoutine extends AgentRecord {
  agentId: string;
  name: string;
  prompt: string;
  schedule: AgentSchedule;
  enabled: boolean;
  nextAt: number | null;
  /** The turn the last occurrence started on the agent's thread. */
  lastTurnId: string | null;
  lastScheduledAt: number | null;
  /**
   * How the last occurrence ended: `quiet` when it had nothing for the user,
   * `skipped` when the budget or a pause held it. A failed occurrence never
   * blocks the next one; only one still queued or running does.
   */
  lastOutcome?: 'done' | 'quiet' | 'error' | 'stopped' | 'skipped' | null;
}

/** Stable identities are independent of provider processes and native sessions. */
export interface AgentRecord {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface AgentSelection {
  providerId: string;
  accountId: string;
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode;
}
export interface AgentProfile extends AgentRecord {
  name: string;
  domain: string;
  instructions: string;
  avatar: string;
  selection: AgentSelection;
  /** Paused: no wakes, the user can still write to it. Archived: its thread is read-only. */
  status: 'active' | 'paused' | 'archived';
  /**
   * Projects the owner entrusted to this agent. It reads their threads, starts,
   * steers, archives, moves and stops them, answers their questions, and is
   * woken when one it runs ends, fails, asks, waits on a permission or stalls.
   */
  projectIds?: string[];
}
/** The agent's own thread. One per agent, created with it. */
export interface AgentSession extends AgentRecord {
  agentId: string;
  threadId: string;
}
/**
 * An ordinary thread the owner handed to a persistent agent. The thread keeps
 * its own model and session; the agent's name and instructions join its turns
 * and a goal keeps it working. It sits on the agent's desk, and its outcome
 * wakes the agent. One agent per thread; entrusting again replaces it.
 */
export interface AgentEntrustment {
  threadId: string;
  agentId: string;
  /** The goal the thread works toward. */
  objective: string;
  at: number;
}
/** A pull request a desk thread opened, as its last watch saw it. */
export interface AgentWatchPullRequest {
  number: number;
  url: string;
  state: 'draft' | 'open' | 'merged' | 'closed';
  checks: 'pending' | 'passing' | 'failing' | null;
}
/**
 * A thread on an agent's desk: one it started, one entrusted to it, one it or
 * the owner watches (`followed`), or one it only wrote to or answered for
 * (`touched`, upgraded to `followed` by a watch). It stays while the thread is
 * open and leaves a day after the thread is done or archived, or when the
 * agent or the owner drops it.
 */
export interface AgentWatch {
  agentId: string;
  threadId: string;
  title: string;
  projectId: string | null;
  origin: 'started' | 'entrusted' | 'followed' | 'touched';
  since: number;
  /** Read from the thread itself, never from what the agent said. */
  state: 'working' | 'queued' | 'needs-you' | 'failed' | 'idle' | 'done' | 'archived';
  /** Since when a running turn has produced nothing; set past the stall delay, when the agent was woken about it. */
  stalledSince: number | null;
  lastActivityAt: number;
  pullRequest: AgentWatchPullRequest | null;
  /** The pending question when `state` is `needs-you` on a question, answerable from the desk. */
  question: { id: string; text: string; options: string[] } | null;
  /**
   * A thread of another machine of the group: its core id and its name as
   * `--machine` takes it. The row is the one that machine last sent.
   */
  coreId?: string;
  machine?: string;
  /** Why that machine did not answer the last time it was asked; its events arrive once it is back. */
  unreachable?: string;
}
/** How an agent stands, for its row, header and desk. */
export interface AgentStatus {
  agentId: string;
  threadId: string | null;
  state: 'working' | 'queued' | 'waiting' | 'idle' | 'paused' | 'archived' | 'error';
  /** The step it is on while working, in a few words (the running tool's title), else null. */
  activity: string | null;
  /** Why it cannot run (its provider or account is gone, its model left the catalog), else null. */
  problem: string | null;
  /** The next routine occurrence, when one is scheduled. */
  nextWake: { at: number; routineId: string; label: string } | null;
  /** Unread turns of its thread on this core, the way the thread list counts them. */
  unread: number;
  /** The last answer it gave the user (not a quiet one), for its row. */
  last: { text: string; at: number } | null;
  /**
   * Its own turns since local midnight. `costUsd` is what its daily budget
   * counts: priced from usage the way `usage.history` prices it, its
   * subagents, workflow steps and memory pass included.
   */
  today: { turns: number; wakes: number; quiet: number; costUsd: number };
  /**
   * Its last memory pass: `threadId` is the core's own child conversation that
   * ran it, housekeeping clients leave out of subagent lists and notification
   * gates; `summary` says in one line what changed in MEMORY.md. Null before
   * the first pass.
   */
  memory?: { threadId: string; status: 'running' | 'done' | 'unchanged' | 'error'; summary: string | null; at: number } | null;
}
export interface AgentsSnapshot {
  revision: number;
  profiles: AgentProfile[];
  sessions: AgentSession[];
  routines: AgentRoutine[];
  status: AgentStatus[];
  /** Every agent's desk, open threads first, then the newest settled ones. */
  watches: AgentWatch[];
  accountGrants: AgentAccountGrant[];
  /** `paused` holds every wake on this core. */
  limits: { paused: boolean };
  entrusted: AgentEntrustment[];
  brainRoot: AgentBrainRoot;
}
/**
 * The folder every agent's brain lives under. `custom` is false for the
 * default, a folder per agent in the core's data directory; a chosen root
 * holds one folder per agent, named after it when it was first placed there.
 */
export interface AgentBrainRoot { path: string; custom: boolean }
export type AgentDraft<T extends AgentRecord> = Omit<T, keyof AgentRecord>;
export type AgentSave<T extends AgentRecord> = { id?: string; expectedRevision?: number; value: AgentDraft<T> };
export interface AgentsRpcMethods {
  /**
   * `desk` narrows `watches` to one agent's desk, or to none with null: the
   * Agents page asks only the open agent's. Absent: every desk it may read.
   * An agent's own thread always reads its own desk.
   */
  'agents.snapshot': { params: { threadId?: string; desk?: string | null }; result: AgentsSnapshot };
  /**
   * Creates or edits an identity. Creating one creates its thread and starts a
   * first turn there: it introduces itself and schedules what its instructions
   * call for. Editing the instructions wakes it once to review its routines.
   */
  'agents.profile.save': { params: AgentSave<AgentProfile>; result: AgentProfile };
  /**
   * A thread creates a bot the user asked for (`boite settings bot create`),
   * as `agents.profile.save` creates one from the Bots page, with full access.
   * The model resolves as for `boite delegate`; omitted, the bot runs on the
   * calling thread's own route. Refused for a name a bot already holds, an
   * unknown model or project, or drafts.
   */
  'agents.create': { params: AgentCreateParams; result: AgentCreateResult };
  /** The agent's thread, created again if it was lost. */
  'agents.open': { params: { agentId: string }; result: { threadId: string } };
  'agents.runtime.get': { params: { agentId: string }; result: AgentRuntimeConfig };
  'agents.runtime.configure': { params: { agentId: string; expectedRevision: number; config: AgentRuntimeConfig }; result: AgentProfile };
  'agents.accounts.set': { params: { grants: AgentAccountGrant[] }; result: AgentAccountGrant[] };
  /** `threadId`: an agent reads its own brain from its thread (`boite bot memory`). */
  'agents.brain.get': { params: { agentId: string; threadId?: string }; result: AgentBrain };
  'agents.brain.save': { params: { agentId: string; expectedRevision: string; instructions: string; memory: string }; result: AgentBrain };
  /**
   * Choose the folder agents' brains live under, or null for the default.
   * Every existing brain moves there; a destination folder that already
   * holds files refuses the whole change before anything moves. Owner only.
   */
  'agents.brain.root': { params: { path: string | null }; result: AgentBrainRoot };
  /** Adds a line to the agent's MEMORY.md, from its own thread (`boite bot remember`) or the owner. */
  'agents.memory.note': { params: { threadId?: string; agentId?: string; text: string }; result: AgentBrain };
  'agents.routine.save': { params: AgentSave<AgentRoutine> & { threadId?: string }; result: AgentRoutine };
  'agents.routine.remove': { params: { routineId: string; threadId?: string }; result: { removed: true } };
  /** Runs a routine now, as a turn on the agent's thread. Refused while that thread has a turn in flight. */
  'agents.routine.run': { params: { routineId: string; requestId: string }; result: { turnId: string } };
  /**
   * An event from outside Boite (a CI job, a script) for a bot, named by id or
   * name: an urgent fact keyed `external:<key>` (default `external`), which a
   * second event with the same key replaces while it waits. `text` reaches the
   * bot quoted as data, with the caller named. The owner or a paired device,
   * never an agent token.
   */
  'agents.event': { params: { agent: string; key?: string; text: string }; result: { agentId: string; key: string } };
  /** Puts a thread on the agent's desk or takes it off. From the agent's thread or the owner. */
  'agents.watch': { params: { threadId?: string; agentId?: string; watchThreadId: string; watched: boolean; machine?: string }; result: AgentWatch | null };
  'agents.limits.set': { params: AgentsSnapshot['limits']; result: AgentsSnapshot['limits'] };
  /**
   * Hands an ordinary thread to an agent, or takes it back with `agentId: null`.
   * `objective` defaults to carrying the thread's work to a verified result.
   * Owner only.
   */
  'agents.entrust': { params: { threadId: string; agentId: string | null; objective?: string }; result: AgentEntrustment | null };
  /**
   * An agent's settings a card may propose a change to, with their values and
   * choices (`boite settings bot`). Any thread reads them; a persistent
   * agent's thread reads its own without naming it.
   */
  'agents.settings.read': { params: AgentSettingsReadParams; result: AgentSettingsReading };
  /**
   * A card on the caller's thread asking the user to change one setting of an
   * agent, asked without stopping like `questions.ask`, with `reason` as its
   * text. Refused for an unknown key or agent, a value the agent's settings
   * would refuse, the value already set, or a card already open on that key.
   * The card settles when the setting moves, from Apply or from the agent's
   * settings; the thread reads `applied`, `changed` or `refused`.
   */
  'agents.settings.request': { params: AgentSettingRequestParams; result: { questionId: RequestId; setting: AgentSettingAsk } };
  /** Apply a pending agent setting card, or the user's edit of it. Owner only, like `agents.profile.save`. */
  'agents.settings.apply': { params: AgentSettingApplyParams; result: AgentProfile };
}
export interface AgentsRpcEvents {
  /** Invalidation only: clients fetch an authorized snapshot. Sent at most once a second while agents work. */
  'agents.changed': { revision: number };
}
