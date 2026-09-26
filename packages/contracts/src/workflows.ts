import type { ProjectId, ProviderId, ThreadId, Timestamp, Usage } from './index';

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
  /** An owner-approved delegation profile id. */
  profile: string;
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
  status: WorkflowStepStatus;
  attempts: number;
  /** The brief after substitution, once the step started. */
  task: string | null;
  /** Bounded final answer. */
  result: string | null;
  /** The validated structured output, null without `output`. */
  output: unknown;
  error: string | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
}

export interface WorkflowNode {
  id: string;
  title: string;
  profileId: string;
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
  launchedBy: 'agent' | 'user';
  templateId: string | null;
  /** Whether the final summary reached the root thread as a turn. */
  delivered: boolean;
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
  /** `retry` needs `stepId` and restarts its failed or stopped executions. */
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
