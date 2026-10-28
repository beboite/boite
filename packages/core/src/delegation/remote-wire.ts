/** What two machines of the group say to each other about a subagent (`delegation/remote.ts`), and the check of a start. */
import type { ContextPreset, ContextRequest, DelegationInput, DelegationWorktree, PermissionMode, ThreadSummary, Turn } from '@boite/contracts';
import { invalidParams, requiredText as text } from '../errors.ts';
import { PERMISSION_MODES } from '../threads/group-spawn.ts';

/** The model a child runs on there. `strict`: picked from that machine's list, so exactly that or nothing. */
export interface WireRoute { providerId: string; model: string | null; effort: string | null; speed: string | null; strict?: true }

/** What the caller's machine sends with `delegation.start`. */
export interface Start {
  parent: { threadId: string; title: string; projectId: string; project: string };
  requestId: string;
  /** The caller's fingerprint of the spawn: the same request id with another one is refused. */
  fingerprint: string;
  task: string;
  title: string;
  worktree: boolean;
  project?: string;
  context?: ContextRequest | ContextPreset;
  route: WireRoute;
  permissionMode: PermissionMode;
}

/** A child as the member last saw it: what `delegate list` shows on the caller's machine. */
export interface ChildState {
  thread: ThreadSummary;
  lastTurn: Turn | null;
  result: string | null;
  needsInput?: DelegationInput[];
  worktree?: DelegationWorktree;
  /** Its project's name on the member. */
  project?: string;
  /** Its last turn was cut by a restart of the member, whose next core continues it: no result yet. Absent once that stop is final. */
  restarting?: true;
}

/** What a member answers to `delegation.start`. */
export interface Started { childId: string; at: number; state: ChildState }

/** One entry of the member's outbox to the caller. */
export interface Report {
  key: string;
  parentId: string;
  childId: string;
  requestId: string;
  at: number;
  state?: ChildState;
  removed?: true;
  letter?: { origin: 'result' | 'question' | 'agent'; requestId: string; text: string; checkpoint?: true };
}

/**
 * One entry of the caller's outbox to the member. Each stop asked is numbered
 * in the order the caller asked it: the member applies it once, and never
 * after one it applied later, however often or late it arrives.
 */
export interface Stop { key: string; seq: number; parentId: string; childId: string; retire?: true }

/** The caller's record of a child on another machine. `childId` is null until that machine answered or reported. */
export interface RemoteChild {
  coreId: string;
  machine: string;
  childId: string | null;
  requestId: string;
  fingerprint: string;
  task: string;
  profileId: string;
  title: string;
  state: ChildState | null;
  /** When the member took the state kept here; an older one arriving late is ignored. */
  at: number;
  createdAt: number;
  retired?: true;
  /** A stop asked before the member named the child: it goes once a report or a late answer names it. */
  stopping?: true;
  /** A workflow step's: its run follows it, so `delegate list` does not show it and its result and questions are not mail. */
  workflow?: true;
  /** The member could not continue this checkpoint, retained across later state reports and caller restarts. */
  interruption?: { turnId: string; error: string };
}

/** The member's link from a child here to its parent on another machine. `stop`: the number of the last stop applied to it. */
export interface ParentLink { coreId: string; machine: string; parentId: string; title: string; projectId: string; project: string; requestId: string; fingerprint: string; at: number; stop?: number }

export const readableState = (value: unknown): value is ChildState => {
  const state = value as ChildState | null;
  return typeof state?.thread?.id === 'string' && typeof state.thread.status === 'string' && typeof state.thread.title === 'string'
    && (state.lastTurn === null || typeof state.lastTurn?.id === 'string') && (state.result === null || typeof state.result === 'string')
    && (state.needsInput === undefined || Array.isArray(state.needsInput));
};

/** A `delegation.start` request checked field by field. */
export function checkStart(value: unknown): Start {
  const raw = (value ?? {}) as Record<string, unknown>;
  const parent = (raw.parent ?? {}) as Record<string, unknown>;
  const route = (raw.route ?? {}) as Record<string, unknown>;
  const optional = (field: unknown, name: string, max: number): string | null => (field === null || field === undefined ? null : text(field, `delegation.start.route.${name}`, max));
  if (typeof raw.worktree !== 'boolean') throw invalidParams('delegation.start.worktree: expected true or false');
  if (typeof raw.permissionMode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(raw.permissionMode)) throw invalidParams(`delegation.start.permissionMode: expected ${PERMISSION_MODES.join(', ')}`);
  if (route.strict !== undefined && route.strict !== true) throw invalidParams('delegation.start.route.strict: expected true or absent');
  const context = raw.context;
  if (context !== undefined && (context === null || (typeof context !== 'string' && typeof context !== 'object') || Array.isArray(context))) throw invalidParams('delegation.start.context: expected a preset or a context request');
  return {
    parent: {
      threadId: text(parent.threadId, 'delegation.start.parent.threadId', 128),
      title: text(parent.title, 'delegation.start.parent.title', 200),
      projectId: typeof parent.projectId === 'string' ? parent.projectId.slice(0, 128) : '',
      project: typeof parent.project === 'string' ? parent.project.slice(0, 200) : '',
    },
    requestId: text(raw.requestId, 'delegation.start.requestId', 128),
    fingerprint: text(raw.fingerprint, 'delegation.start.fingerprint', 128),
    task: text(raw.task, 'delegation.start.task', 12_000),
    title: text(raw.title, 'delegation.start.title', 120),
    worktree: raw.worktree,
    ...(raw.project === undefined ? {} : { project: text(raw.project, 'delegation.start.project', 4096) }),
    ...(context === undefined ? {} : { context: context as ContextRequest | ContextPreset }),
    route: {
      providerId: text(route.providerId, 'delegation.start.route.providerId', 128),
      model: optional(route.model, 'model', 256),
      effort: optional(route.effort, 'effort', 64),
      speed: optional(route.speed, 'speed', 64),
      ...(route.strict === true ? { strict: true as const } : {}),
    },
    permissionMode: raw.permissionMode as PermissionMode,
  };
}
