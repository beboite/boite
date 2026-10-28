/** A team's settings and the threads its children run in. */
import { DEFAULT_DELEGATION_CONFIG, SPEED_NEEDS_MODEL } from '@boite/contracts';
import type { DelegationConfig, PermissionMode, RpcParams, ThreadContextMode, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { checkContext } from '../context-mode.ts';
import { invalidParams, refused, requiredText as text } from '../errors.ts';
import { newId } from '../ids.ts';
import { checkSavedSelection, checkSpeed } from '../threads/selection.ts';
import { childProject } from './projects.ts';
import type { ChildRoute } from './routes.ts';
import type { ChildWorktrees } from './worktrees.ts';

/** A team's saved settings, or the defaults. */
export function readConfig(core: Core, rootId: string): DelegationConfig {
  const saved = core.journal.getSetting(`delegation:${rootId}`) as DelegationConfig | undefined;
  if (!saved) return structuredClone(DEFAULT_DELEGATION_CONFIG);
  const pause = saved.paused && saved.pausedBy ? { pausedBy: saved.pausedBy, ...(saved.pausedAt === undefined ? {} : { pausedAt: saved.pausedAt }) } : {};
  return { enabled: saved.enabled, paused: saved.paused, ...pause, profiles: saved.profiles, anyModel: saved.anyModel !== false };
}

export function checkConfig(core: Core, value: DelegationConfig, previous?: DelegationConfig): DelegationConfig {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean' || !Array.isArray(value.profiles) || value.profiles.length > 16) throw invalidParams('config: expected enabled, paused and up to 16 profiles');
  if (value.anyModel !== undefined && typeof value.anyModel !== 'boolean') throw invalidParams('config.anyModel: expected a boolean');
  const config: DelegationConfig = {
    enabled: value.enabled, paused: value.paused, anyModel: value.anyModel !== false,
    profiles: value.profiles.map(p => {
      if (!p || typeof p !== 'object') throw invalidParams('profile: expected an object');
      const id = text(p.id, 'profile.id', 64);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw invalidParams('profile.id: expected letters, numbers, underscores or hyphens');
      const provider = core.providers.require(text(p.providerId, 'profile.providerId', 128));
      const account = core.accounts.require(text(p.accountId, 'profile.accountId', 128));
      if (account.providerId !== provider.id) throw refused('profile.accountId must belong to profile.providerId');
      const model = text(p.model, 'profile.model', 256);
      checkSavedSelection(provider, account.id, { model, effort: p.effort }, previous?.profiles.find(profile => profile.id === id));
      return { id, name: text(p.name, 'profile.name', 80), providerId: provider.id, accountId: account.id, model, effort: p.effort };
    }),
  };
  if (new Set(config.profiles.map(p => p.id)).size !== config.profiles.length) throw invalidParams('profile.id: expected unique ids');
  return config;
}

export interface ChildRequest {
  parent: ThreadSummary;
  profile: ChildRoute;
  title: string;
  /** Runs in the same transaction as the thread's creation. */
  record: (id: string) => void;
  context?: unknown;
  worktree: boolean;
  fixed?: { contextMode: ThreadContextMode; permissionMode: PermissionMode };
  project?: string;
}

/**
 * An ordinary child thread on a profile, or on the parent's own route for a
 * workflow step that names none, in the parent's permission mode and its
 * checkout, or a bot's entrusted project. It uses the route's speed tier or
 * none: never the parent's. The tier is
 * checked here, whoever built the route. `record` runs in the same
 * transaction. `worktree` gives it a git worktree of its own instead of the
 * parent's checkout: its branch and folder now, the worktree itself before
 * its first turn ([worktrees](./worktrees.ts)). `fixed` is a
 * context mode and a permission mode the core sets itself, such as a memory
 * pass that runs no tool; each driver honours what it can of the mode.
 */
export function createChild(core: Core, worktrees: ChildWorktrees, { parent, profile, title, record, context, worktree, fixed, project }: ChildRequest): string {
  const id = newId('thr_');
  const { speed: asked, ...route } = profile;
  if (asked != null && route.model === null) throw invalidParams(SPEED_NEEDS_MODEL);
  const provider = core.providers.require(route.providerId);
  const speed = checkSpeed(provider, route.accountId, route.model, asked ?? null);
  const contextMode = fixed ? { ...fixed.contextMode, tools: fixed.contextMode.tools === null ? null : [...fixed.contextMode.tools] } : checkContext(provider, context);
  // Fixed memory passes keep the bot's personal workspace, even with one entrusted project.
  const workspace = fixed ? parent : childProject(core, parent, project);
  const planned = worktree ? worktrees.plan(workspace, id) : null;
  core.journal.db.transaction(() => {
    if (workspace.projectId === null) {
      const now = Date.now();
      const child: ThreadSummary = { ...parent, parentThreadId: parent.id, agentSessionId: undefined, ...route, speed, id, contextMode, ...(fixed ? { permissionMode: fixed.permissionMode } : {}),
        title, titleSource: 'user', status: 'idle', sessionId: null, sessionGeneration: 0, selectionVersion: 0,
        context: null, promptCache: null, load: null, unread: false, pinned: false, createdAt: now, updatedAt: now };
      core.journal.append({ type: 'thread.created', threadId: id, version: 1, payload: child }, () => core.journal.putThread(child));
      core.bus.emit('thread.created', child);
    } else core.threads.create({ projectId: workspace.projectId, providerId: route.providerId, accountId: route.accountId, model: route.model ?? undefined, effort: route.effort, speed, title, cwd: planned?.path ?? workspace.cwd, permissionMode: parent.permissionMode, ...(context === undefined ? {} : { context: context as RpcParams<'threads.create'>['context'] }) }, { id, branch: planned?.branch ?? workspace.branch, parentThreadId: parent.id });
    if (planned) worktrees.record(id, planned);
    record(id);
    const child = core.threads.require(id);
    core.journal.putThread({ ...child, titleSource: 'user', ...(fixed ? { contextMode, permissionMode: fixed.permissionMode } : {}) });
  })();
  return id;
}
