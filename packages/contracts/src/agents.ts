import type { DelegationConfig, DelegationProfile, MessagePart, PermissionMode, TurnExecution } from './index';

export interface AgentRuntimeConfig {
  defaultRoute: AgentSelection;
  allowedRoutes: DelegationProfile[];
  subagents: DelegationConfig;
  compactAfterTurns: number;
  maxRunMinutes: number;
  /**
   * After each finished piece of work in the direct conversation, a small
   * subagent rewrites MEMORY.md from what was asked and answered. On unless
   * the owner turns it off; missing on configurations saved before it existed.
   */
  autoMemory?: boolean;
}
export interface AgentAccountGrant { accountId: string; agentIds: string[] | null }
export interface AgentBrain {
  /** The agent's brain folder: under the brain root the owner chose, else in the core's data directory. */
  path: string;
  instructions: string;
  memory: string;
  revision: string;
}
/**
 * A daily schedule with `days` runs only on those weekdays, numbered 0 (Sunday) to 6 in
 * its timezone. Absent means every day; the core drops a list of all seven.
 */
export type AgentSchedule = { kind: 'once'; at: number } | { kind: 'interval'; everyMinutes: number } | { kind: 'daily'; time: string; timezone: string; days?: number[] };
export interface AgentRoutine extends AgentRecord {
  agentId: string;
  name: string;
  prompt: string;
  schedule: AgentSchedule;
  enabled: boolean;
  nextAt: number | null;
  lastWorkId: string | null;
  lastScheduledAt: number | null;
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
  status: 'active' | 'paused' | 'archived';
  tools: string[];
  /** External plugin integration only. Boite never selects or rotates agy logins. */
  accountIntegration: 'provider' | 'kebacc-experiment';
  /**
   * Projects the owner entrusted to this agent. Its direct conversation reads
   * their threads, starts, steers, archives, moves and stops them, answers
   * their questions, and hears when one fails, asks or waits. Missing on
   * profiles saved before it existed: none.
   */
  projectIds?: string[];
}
export interface AgentGroup extends AgentRecord {
  name: string;
  memberIds: string[];
  mode: 'mentions' | 'round' | 'autonomous';
  maxTurns: number;
  maxTurnsPerAgent: number;
  paused: boolean;
}
export interface AgentTeam extends AgentRecord {
  name: string;
  description: string;
  members: { agentId: string; responsibility: string }[];
  projectIds: string[];
  groupId: string | null;
  paused: boolean;
}
export type AgentScope = { kind: 'agent' | 'group' | 'team' | 'mission' | 'project'; id: string };
export interface AgentMission extends AgentRecord {
  title: string;
  objective: string;
  expectedResult: string;
  teamId: string | null;
  projectId: string | null;
  agentIds: string[];
  status: 'open' | 'active' | 'waiting' | 'paused' | 'review' | 'done' | 'cancelled';
  maxTurns: number;
  maxDurationMs: number;
  maxTokens: number | null;
  resourceIds: string[];
}
export interface AgentMissionTask extends AgentRecord {
  missionId: string;
  title: string;
  instructions: string;
  dependsOn: string[];
  assigneeId: string | null;
  status: 'open' | 'assigned' | 'running' | 'waiting' | 'review' | 'done' | 'cancelled';
  generation: number;
  leaseUntil: number | null;
  workspace: { path: string; branch: string | null } | null;
  result: string | null;
}
export interface AgentSession extends AgentRecord {
  agentId: string;
  scope: AgentScope;
  threadId: string;
}
export interface AgentConversationMessage extends AgentRecord {
  scope: AgentScope;
  senderId: string | null;
  text: string;
  recipientIds: string[];
  replyTo: string | null;
  episodeId: string;
  sourceRunId: string | null;
  /**
   * A message the agent posts about a thread entrusted to it: when it takes
   * the thread over, and when the work there ends. `text` carries the
   * thread's last answer (`done`, `blocked`) or why it stopped; clients
   * write the sentence around it in their own language from `event`.
   */
  thread?: { id: string; title: string; event: 'entrusted' | 'done' | 'blocked' | 'stopped' };
  /**
   * Files the agent attached with `boite attach` while it worked: pictures,
   * captures, documents. Each is read with `artifacts.read` on the agent's
   * own thread and message.
   */
  files?: AgentMessageFile[];
}
export interface AgentMessageFile {
  threadId: string;
  messageId: string;
  part: Extract<MessagePart, { type: 'artifact' }>;
}
/**
 * The memory pass after a finished piece of work: a small subagent of the
 * agent's thread reads what was asked and answered and rewrites MEMORY.md.
 * `summary` says in one line what it changed; null while it runs or when
 * nothing changed.
 */
export interface AgentMemoryPass {
  threadId: string;
  status: 'running' | 'done' | 'unchanged' | 'error';
  summary: string | null;
  at: number;
}
/**
 * An ordinary thread the owner handed to a persistent agent. The thread keeps
 * its own model and session; the agent's name and instructions join its turns
 * and a goal keeps it working until the objective is met or it needs the
 * user. The agent tells its own conversation when it takes over and when the
 * work ends. One agent per thread; entrusting again replaces it.
 */
export interface AgentEntrustment {
  threadId: string;
  agentId: string;
  /** The goal the thread works toward. */
  objective: string;
  at: number;
}
export interface AgentDelivery extends AgentRecord {
  messageId: string;
  agentId: string;
  status: 'pending' | 'included' | 'processed' | 'failed' | 'cancelled' | 'limited';
  workId: string | null;
}
export interface AgentWork extends AgentRecord {
  /**
   * `notice`: the core telling the agent what happened in threads of the
   * projects entrusted to it. Notices that arrive before it starts join the
   * same work item. An answer of `[quiet]` posts nothing.
   */
  purpose?: 'work' | 'compaction' | 'notice';
  agentId: string;
  scope: AgentScope;
  taskId: string | null;
  taskGeneration: number | null;
  messageId: string | null;
  episodeId: string;
  prompt: string;
  status: 'pending' | 'running' | 'waiting' | 'paused' | 'done' | 'cancelled' | 'interrupted' | 'error';
  error: string | null;
  runId: string | null;
  notBefore: number;
  /** The memory pass that followed this work, when one ran. */
  memory?: AgentMemoryPass;
}
export interface AgentRun extends AgentRecord {
  workId: string;
  agentId: string;
  threadId: string;
  turnId: string | null;
  execution: AgentSelection;
  profileRevision: number;
  context: { memoryIds: { id: string; revision: number }[]; messageIds: string[]; resources: AgentResource[]; instructions: string };
  status: 'accepted' | 'running' | 'done' | 'cancelled' | 'interrupted' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  actualExecution: TurnExecution | null;
}
export interface AgentMemory extends AgentRecord {
  scope: AgentScope;
  title: string;
  text: string;
  sourceScopes: AgentScope[];
  sourceRunId: string | null;
  expiresAt: number | null;
}
export interface AgentResource extends AgentRecord {
  scope: AgentScope;
  name: string;
  kind: 'directory' | 'url' | 'instructions';
  value: string;
  access: 'read' | 'write';
}
export interface AgentArtifact extends AgentRecord {
  missionId: string;
  taskId: string | null;
  agentId: string;
  runId: string;
  title: string;
  summary: string;
  paths: string[];
  commit: string | null;
  verification: string;
}
export interface AgentDecision extends AgentRecord {
  scope: AgentScope;
  workId: string;
  agentId: string;
  prompt: string;
  options: string[];
  status: 'pending' | 'answered' | 'cancelled';
  answer: string | null;
}
export interface AgentEntities {
  routine: AgentRoutine;
  profile: AgentProfile;
  group: AgentGroup;
  team: AgentTeam;
  mission: AgentMission;
  task: AgentMissionTask;
  session: AgentSession;
  message: AgentConversationMessage;
  delivery: AgentDelivery;
  work: AgentWork;
  run: AgentRun;
  memory: AgentMemory;
  resource: AgentResource;
  artifact: AgentArtifact;
  decision: AgentDecision;
}
export type AgentEntityKind = keyof AgentEntities;
export type AgentDraft<T extends AgentRecord> = Omit<T, keyof AgentRecord>;
export type AgentSave<T extends AgentRecord> = { id?: string; expectedRevision?: number; value: AgentDraft<T> };
/**
 * A run as snapshots and history pages carry it. The frozen instructions stay in
 * the core and in the run's thread, whose turn was started with them.
 */
export type AgentRunSummary = Omit<AgentRun, 'context'> & { context: Omit<AgentRun['context'], 'instructions'> };
/** The record kinds that grow with use. Snapshots carry their newest records; `agents.history` pages back. */
export type AgentHistoryKind = 'message' | 'work' | 'memory';
/** Records are ordered by their last change, newest first. A cursor is the oldest record a client already holds. */
export interface AgentHistoryCursor { updatedAt: number; id: string }
export interface AgentsHistoryPage {
  messages: AgentConversationMessage[];
  work: AgentWork[];
  memories: AgentMemory[];
  /** The deliveries, runs and decisions of the page's messages and work. */
  deliveries: AgentDelivery[];
  runs: AgentRunSummary[];
  decisions: AgentDecision[];
  /** True when records older than this page remain. */
  more: boolean;
}
export const AGENT_HISTORY_PAGE = 50;
export const AGENT_HISTORY_MAX_PAGE = 200;
export interface AgentsSnapshot {
  routines: AgentRoutine[];
  accountGrants: AgentAccountGrant[];
  revision: number;
  profiles: AgentProfile[];
  groups: AgentGroup[];
  teams: AgentTeam[];
  missions: AgentMission[];
  tasks: AgentMissionTask[];
  sessions: AgentSession[];
  /** The newest `AGENT_HISTORY_PAGE` messages. */
  messages: AgentConversationMessage[];
  deliveries: AgentDelivery[];
  /** Every unfinished work item, then the newest `AGENT_HISTORY_PAGE` of any status. */
  work: AgentWork[];
  runs: AgentRunSummary[];
  /** The newest `AGENT_HISTORY_PAGE` memories this caller may read. */
  memories: AgentMemory[];
  resources: AgentResource[];
  artifacts: AgentArtifact[];
  decisions: AgentDecision[];
  /** Per kind, true when older records exist beyond this snapshot. */
  more: Record<AgentHistoryKind, boolean>;
  limits: { backgroundConcurrency: number; paused: boolean; kebaccExperiment: boolean };
  /** Threads entrusted to agents on this core. Missing on older cores. */
  entrusted?: AgentEntrustment[];
  /** Where agents' brains live on this core. Missing on older cores. */
  brainRoot?: AgentBrainRoot;
}
/**
 * The folder every agent's brain lives under. `custom` is false for the
 * default, a folder per agent in the core's data directory; a chosen root
 * holds one folder per agent, named after it when it was first placed there.
 */
export interface AgentBrainRoot { path: string; custom: boolean }
export interface AgentsRpcMethods {
  'agents.runtime.get': { params: { agentId: string }; result: AgentRuntimeConfig };
  'agents.runtime.configure': { params: { agentId: string; expectedRevision: number; config: AgentRuntimeConfig }; result: AgentProfile };
  'agents.accounts.set': { params: { grants: AgentAccountGrant[] }; result: AgentAccountGrant[] };
  'agents.brain.get': { params: { agentId: string }; result: AgentBrain };
  'agents.brain.save': { params: { agentId: string; expectedRevision: string; instructions: string; memory: string }; result: AgentBrain };
  /**
   * Choose the folder agents' brains live under, or null for the default.
   * Every existing brain moves there; a destination folder that already
   * holds files refuses the whole change before anything moves. Owner only.
   */
  'agents.brain.root': { params: { path: string | null }; result: AgentBrainRoot };
  'agents.routine.save': { params: AgentSave<AgentRoutine> & { threadId?: string }; result: AgentRoutine };
  'agents.routine.run': { params: { routineId: string; requestId: string }; result: AgentWork };
  'agents.context.compact': { params: { sessionId: string; requestId: string }; result: AgentWork };
  'agents.snapshot': { params: { threadId?: string }; result: AgentsSnapshot };
  /**
   * Older records of one kind, newest first, strictly before `before`. `scopes`
   * and `agentId` narrow the page; an agent session is held to its own context.
   */
  'agents.history': {
    params: { threadId?: string; kind: AgentHistoryKind; scopes?: AgentScope[]; agentId?: string; before?: AgentHistoryCursor; limit?: number };
    result: AgentsHistoryPage;
  };
  'agents.profile.save': { params: AgentSave<AgentProfile>; result: AgentProfile };
  'agents.group.save': { params: AgentSave<AgentGroup>; result: AgentGroup };
  'agents.team.save': { params: AgentSave<AgentTeam>; result: AgentTeam };
  'agents.mission.save': { params: AgentSave<AgentMission>; result: AgentMission };
  'agents.task.save': { params: AgentSave<AgentMissionTask>; result: AgentMissionTask };
  'agents.resource.save': { params: AgentSave<AgentResource>; result: AgentResource };
  'agents.memory.save': { params: AgentSave<AgentMemory> & { threadId?: string }; result: AgentMemory };
  'agents.message.send': {
    params: { threadId?: string; scope: AgentScope; text: string; recipientIds: string[]; replyTo?: string; requestId: string };
    result: AgentConversationMessage;
  };
  'agents.task.acquire': { params: { threadId?: string; taskId: string; agentId: string; expectedRevision: number }; result: AgentMissionTask };
  'agents.task.submit': { params: { threadId?: string; taskId: string; generation: number; result: string }; result: AgentMissionTask };
  'agents.artifact.add': { params: { threadId: string; value: Omit<AgentDraft<AgentArtifact>, 'agentId' | 'runId'>; requestId: string }; result: AgentArtifact };
  'agents.decision.request': { params: { threadId: string; prompt: string; options: string[]; requestId: string }; result: AgentDecision };
  'agents.decision.answer': { params: { decisionId: string; expectedRevision: number; answer: string }; result: AgentDecision };
  'agents.work.control': { params: { workId: string; expectedRevision: number; action: 'pause' | 'resume' | 'cancel' | 'reconcile'; note?: string }; result: AgentWork };
  'agents.limits.set': { params: AgentsSnapshot['limits']; result: AgentsSnapshot['limits'] };
  /**
   * Hands an ordinary thread to an agent, or takes it back with `agentId: null`.
   * `objective` defaults to carrying the thread's work to a verified result.
   * Owner only.
   */
  'agents.entrust': { params: { threadId: string; agentId: string | null; objective?: string }; result: AgentEntrustment | null };
}
export interface AgentsRpcEvents {
  /** Invalidation only: clients fetch an authorized snapshot, never another agent's private data. */
  'agents.changed': { revision: number };
}
