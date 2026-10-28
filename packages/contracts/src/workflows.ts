import type { DelegationWorktree, PauseOrigin, ProjectId, ProviderId, ThreadId, Timestamp, Usage } from './index';
import type { ContextPreset, ContextRequest } from './context-mode';
import type { SharedComputeResult, SharedProjectRef, SharedThreadRef } from './shared-projects';

/**
 * The shape a step promises for its structured output: a type name, a list of
 * one shape, or an object of shapes. Extra object keys are accepted, missing
 * ones are refused, so a model that says more than asked still passes.
 */
export type WorkflowShape = 'string' | 'number' | 'boolean' | 'any' | WorkflowShape[] | { [key: string]: WorkflowShape };

/** Exactly one of `equals`, `notEmpty` or `empty`, on a path such as `triage.severity`. */
export interface WorkflowCondition {
  path: string;
  equals?: string | number | boolean | null;
  notEmpty?: true;
  empty?: true;
}

export interface WorkflowStepPlan {
  /** Letters, digits, `_` and `-`, starting with a letter; referenced by `after`, paths and `{{...}}`. */
  id: string;
  title?: string;
  /** A delegation profile id of the thread. Left out, the step runs on the conversation's own model. */
  profile?: string;
  /** `provider/model` or a model id from `boite delegate models`; wins over `profile`. */
  model?: string;
  /** A reasoning level the step's model offers. */
  effort?: string;
  /** Start the step without part of the user's setup: a preset name or a `ContextRequest`. */
  context?: ContextRequest | ContextPreset;
  /** The brief. `{{step.field}}`, `{{item}}` and `{{index}}` are filled in when the step starts. */
  task: string;
  /** Steps that must end first. Steps named in `forEach`, `when` or the task are added automatically. */
  after?: string[];
  /** A path to a list; the step runs once per item, up to the run's step limit. */
  forEach?: string;
  /** Skip the step when false. Evaluated once its dependencies end. */
  when?: WorkflowCondition;
  /** Structured output the step must return, validated by the core. */
  output?: WorkflowShape;
  /**
   * Run the step in a git worktree of its own, on a new branch from the
   * conversation's current HEAD, instead of the shared checkout. Uncommitted
   * edits are not copied. The run's summary names the branch to merge.
   */
  worktree?: boolean;
  /** Explicit shared-project host route. Accounts, tools, checkout and permissions belong to that host. */
  compute?: { sharedProjectId: string; host: SharedProjectRef; profileId: string; baseCommit: string };
  /**
   * Another machine of the group, by name or core id prefix as `delegate spawn --machine` takes it:
   * the step runs there as a subagent of the run's conversation. Not with `compute`.
   */
  machine?: string;
  /** With `machine`: one of that machine's projects. Left out, the one named like this conversation's project. */
  project?: string;
}

export interface WorkflowLimits {
  /** Steps running at once in this run, also held to the team's concurrency. */
  maxConcurrent: number;
  /** Step executions in this run, fan-out included. */
  maxSteps: number;
}

export interface WorkflowPlan {
  name: string;
  steps: WorkflowStepPlan[];
  limits?: Partial<WorkflowLimits>;
}

export const WORKFLOW_LIMITS = {
  steps: 32,
  maxConcurrent: 8,
  maxSteps: 64,
  taskChars: 12000,
  resultChars: 4000,
  /** A step's output after validation, as JSON. */
  outputChars: 16000,
  /** A structured output that does not match gets this many turns in total. */
  attempts: 2,
} as const;

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = { maxConcurrent: 3, maxSteps: 24 };

export type WorkflowStatus = 'running' | 'paused' | 'done' | 'failed' | 'stopped';
export type WorkflowStepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped';

/** One execution of a step: the step itself, or one item of its `forEach`. */
export interface WorkflowInstance {
  /** `scan`, or `review#2` for the third item of `review`. */
  key: string;
  index: number | null;
  /** A short preview of the item, empty for a step without `forEach`. */
  label: string;
  threadId: ThreadId | null;
  providerId: ProviderId | null;
  model: string | null;
  /** The reasoning level it runs at; null or missing on older runs: the model's default. */
  effort?: string | null;
  /** All reported turns of this execution, retries and cache included. Null when none reported; missing on older cores. */
  usage?: Usage | null;
  status: WorkflowStepStatus;
  attempts: number;
  /** A durable output correction awaiting admission, including while paused. */
  outputCorrection?: string;
  /** The brief after substitution, once the step started. */
  task: string | null;
  /** Bounded final answer. */
  result: string | null;
  /** The validated structured output, null without `output`. */
  output: unknown;
  error: string | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  /** The step's own worktree, for a step that set `worktree`. Missing otherwise and on older runs. */
  worktree?: DelegationWorktree;
  /** A remote worker is never used as a local threadId. Persisted across reconnect/restart. */
  compute?: { requestId: string; jobId: string; host: SharedProjectRef; worker: SharedThreadRef | null; result: SharedComputeResult | null };
  /**
   * A step with `machine`: its subagent on that machine. `childId` is that machine's thread id, never a local
   * `threadId`; `turnId` is its last turn already judged, so a report of it again settles nothing.
   * `correction`: an output correction decided and not yet taken there, sent again with the same request id
   * until it is, a core restart included.
   */
  machine?: { name: string; coreId: string | null; requestId: string; childId: string | null; turnId: string | null; corrections: number; correction?: { requestId: string; text: string } };
}

export interface WorkflowNode {
  id: string;
  title: string;
  /** Null: the conversation's own model. */
  profileId: string | null;
  /** Normalized dependencies: `after` plus every step a path names. */
  after: string[];
  forEach: string | null;
  status: WorkflowStepStatus;
  instances: WorkflowInstance[];
  error: string | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
}

export interface WorkflowRun {
  id: string;
  rootThreadId: ThreadId;
  name: string;
  status: WorkflowStatus;
  plan: WorkflowPlan;
  nodes: WorkflowNode[];
  limits: WorkflowLimits;
  /** Why the run stopped, failed or paused by itself. */
  error: string | null;
  /** Who paused it, while paused: a step held by a paused team takes the team's. Absent on older runs, read as the owner's. */
  pausedBy?: PauseOrigin;
  pausedAt?: Timestamp;
  launchedBy: 'agent' | 'user';
  templateId: string | null;
  /** Whether the final summary reached the root thread as a turn. */
  delivered: boolean;
  /**
   * Why the summary has not reached the root yet (the team's turn budget spent,
   * delegation paused), cleared once it does. It is tried again when the root
   * ends a turn or its delegation settings change. Absent on older runs.
   */
  deliveryError?: string | null;
  /**
   * The failed executions the root was already told about while other steps
   * still ran, as `key@finishedAt`: a new failure, or the same step failing
   * again after a retry, is told once more. Absent on older runs.
   */
  failuresNoticed?: string[];
  usage: Usage;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
}

/** A plan kept for a project, or for projectless threads when `projectId` is null. */
export interface WorkflowTemplate {
  id: string;
  projectId: ProjectId | null;
  name: string;
  plan: WorkflowPlan;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface WorkflowsRpcMethods {
  /** Runs rooted at this thread (or at its parent for a step), newest first, at most 20. */
  'workflows.list': { params: { threadId: ThreadId }; result: WorkflowRun[] };
  'workflows.get': { params: { threadId: ThreadId; runId: string }; result: WorkflowRun };
  /** Validates without starting: the plan's columns, or a refusal naming the field. */
  'workflows.check': { params: { threadId: ThreadId; plan: WorkflowPlan }; result: { levels: string[][] } };
  'workflows.start': { params: { threadId: ThreadId; plan: WorkflowPlan; requestId: string; templateId?: string }; result: WorkflowRun };
  /** Adds steps to a running or paused run. */
  'workflows.extend': { params: { threadId: ThreadId; runId: string; steps: WorkflowStepPlan[]; requestId: string }; result: WorkflowRun };
  /**
   * `retry` restarts the failed or stopped executions, of `stepId` only when
   * named. An agent resumes, or retries on a paused run, only a pause it may
   * lift (`PauseOrigin`).
   */
  'workflows.control': { params: { threadId: ThreadId; runId: string; action: 'pause' | 'resume' | 'stop' | 'retry'; stepId?: string }; result: WorkflowRun };
  /** Called from a step's own thread: records its structured output, refused with the mismatch. */
  'workflows.output': { params: { threadId: ThreadId; value: unknown }; result: { runId: string; step: string } };
  'workflows.templates.list': { params: { threadId: ThreadId }; result: WorkflowTemplate[] };
  'workflows.templates.save': { params: { threadId: ThreadId; name: string; plan: WorkflowPlan; templateId?: string }; result: WorkflowTemplate };
  'workflows.templates.remove': { params: { threadId: ThreadId; templateId: string }; result: { removed: boolean } };
}

export interface WorkflowsRpcEvents {
  /** Subscribed root threads only; clients refetch `workflows.list`. */
  'workflows.changed': { threadId: ThreadId; runId: string };
}
