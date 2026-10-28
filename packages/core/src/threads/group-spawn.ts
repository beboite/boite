/*
 * `boite thread new --machine`: an agent starts a thread on another machine
 * of its group. The caller's core checks the caller as for a thread of its
 * own (`spawn.ts`) and asks the member with a sealed `thread.start`; the
 * member takes it only while its owner turned on `groupThreads` there, and
 * starts it on the caller's provider and model when it has them. The first
 * answer goes back through coordination, as for a thread started here.
 */
import { effectiveSetting, isMachineSetting, MACHINE_SETTINGS, type MachineSetting } from '@boite/contracts';
import type { CoordinationPeer, ContextPreset, ContextRequest, PermissionMode, ThreadLink } from '@boite/contracts';
import type { Core } from '../core.ts';
import { loggedInAccount } from '../delegation/routes.ts';
import { invalidParams, refused, requiredText } from '../errors.ts';
import { modelsFor } from './selection.ts';

/** What a member answers while its owner has not let the group start threads there; the caller words it for its agent. */
export const GROUP_THREADS_OFF = 'groupThreads is off on this machine';

/** What the caller's core sends with `thread.start`. */
export interface GroupStart {
  /** The starting thread, as its timeline names it. */
  from: { threadId: string; title: string; projectId: string; project: string };
  project: string;
  prompt: string;
  title: string;
  worktree: boolean;
  context?: ContextRequest | ContextPreset;
  requestId: string;
  /** The caller's own agent, taken on when this machine has it. */
  agent: { providerId: string; model: string | null; effort: string | null; speed: string | null; permissionMode: PermissionMode };
}

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'yolo', 'plan', 'dontAsk'];
const fold = (name: string): string => name.trim().replace(/\s+/g, '-').toLowerCase();

/** What `--machine` takes for `peer`: its name, or a core id prefix when another machine of the group goes by the same one. */
export function machineArg(core: Core, peer: CoordinationPeer): string {
  const others = core.group.view('owner')?.cores.filter(entry => entry.coreId !== peer.coreId) ?? [];
  return others.some(entry => fold(entry.name) === fold(peer.name)) ? peer.coreId.slice(0, 8) : peer.name.replace(/\s+/g, '-');
}

/**
 * A member of this core's group by its name (spaces and dashes alike, any
 * case), its core id or a prefix of at least six hex digits of it.
 */
export function memberNamed(core: Core, query: string, method: string): CoordinationPeer {
  const wanted = query.trim();
  const group = core.group.view('owner');
  if (group === null) throw refused(`${method}.machine: this machine is in no group; --machine names another machine of its group`, { field: 'machine' });
  const peers = core.group.peers();
  const found = peers.filter(peer => peer.coreId === wanted || fold(peer.name) === fold(wanted) || (/^[0-9a-f]{6,}$/.test(wanted) && peer.coreId.startsWith(wanted)));
  const self = group.cores.find(entry => entry.coreId === group.self);
  if (self !== undefined && (self.coreId === wanted || (fold(self.name) === fold(wanted) && found.length === 0))) {
    throw refused(`${method}.machine: ${self.name} is this machine; leave --machine out`, { field: 'machine' });
  }
  if (found.length === 1) return found[0]!;
  const names = peers.map(peer => machineArg(core, peer));
  if (found.length === 0) {
    throw refused(`${method}.machine: no machine ${wanted} in this group; ${names.length === 0 ? 'it has no other machine' : `the others are ${names.join(', ')}`}`, { field: 'machine', expected: names });
  }
  throw refused(`${method}.machine: ${found.length} machines are named ${wanted}; name one by a core id prefix: ${found.map(peer => peer.coreId.slice(0, 8)).join(', ')}`, { field: 'machine' });
}

/** What a thread started on another machine runs: a `thread.start` request without its starter, or a `bot.start` one. */
export type StartFields = Omit<GroupStart, 'from'>;

/** The fields of a `thread.start` or `bot.start` request, checked one by one. */
export function checkStartFields(value: unknown, method = 'thread.start'): StartFields {
  const raw = (value ?? {}) as Record<string, unknown>;
  const agent = (raw.agent ?? {}) as Record<string, unknown>;
  const optional = (entry: unknown, field: string, max: number): string | null => (entry === null || entry === undefined ? null : requiredText(entry, `${method}.${field}`, max));
  if (typeof raw.worktree !== 'boolean') throw invalidParams(`${method}.worktree: expected true or false`);
  if (typeof agent.permissionMode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(agent.permissionMode)) throw invalidParams(`${method}.agent.permissionMode: expected ${PERMISSION_MODES.join(', ')}`);
  const context = raw.context;
  if (context !== undefined && (context === null || (typeof context !== 'string' && typeof context !== 'object') || Array.isArray(context))) throw invalidParams(`${method}.context: expected a preset or a context request`);
  return {
    project: requiredText(raw.project, `${method}.project`, 4096),
    prompt: requiredText(raw.prompt, `${method}.prompt`, 12_000),
    title: requiredText(raw.title, `${method}.title`, 120).trim(),
    worktree: raw.worktree,
    ...(context === undefined ? {} : { context: context as ContextRequest | ContextPreset }),
    requestId: requiredText(raw.requestId, `${method}.requestId`, 128),
    agent: {
      providerId: requiredText(agent.providerId, `${method}.agent.providerId`, 128),
      model: optional(agent.model, 'agent.model', 200),
      effort: optional(agent.effort, 'agent.effort', 64),
      speed: optional(agent.speed, 'agent.speed', 64),
      permissionMode: agent.permissionMode as PermissionMode,
    },
  };
}

/** A `thread.start` request checked field by field. */
export function checkGroupStart(value: unknown): GroupStart {
  const raw = (value ?? {}) as Record<string, unknown>;
  const from = (raw.from ?? {}) as Record<string, unknown>;
  const fields = checkStartFields(value);
  return {
    from: {
      threadId: requiredText(from.threadId, 'thread.start.from.threadId', 128),
      title: requiredText(from.title, 'thread.start.from.title', 200),
      projectId: requiredText(from.projectId, 'thread.start.from.projectId', 128),
      project: requiredText(from.project, 'thread.start.from.project', 200),
    },
    ...fields,
  };
}

/**
 * The agent a thread started from another machine runs on here: the
 * caller's provider on this machine's signed-in login, with the caller's
 * model, level and speed when this login lists that model, else its default.
 */
export function agentHere(core: Core, start: Pick<GroupStart, 'agent'>, machine: string): { providerId: string; accountId: string; model?: string; effort: string | null; speed: string | null; permissionMode: PermissionMode } {
  const { providerId, model, effort, speed, permissionMode } = start.agent;
  const provider = core.providers.available().some(summary => summary.id === providerId) ? core.providers.require(providerId) : null;
  const account = provider === null ? undefined : loggedInAccount(core.accounts.list().filter(entry => entry.providerId === providerId));
  if (provider === null || account === undefined) {
    throw refused(`${providerId} is not signed in on ${machine}; start the thread from a thread there, or sign it in on ${machine}`, { field: 'agent.providerId', providerId });
  }
  const kept = model !== null && modelsFor(provider, account.id).some(entry => entry.id === model);
  return { providerId, accountId: account.id, ...(kept ? { model: model! } : {}), effort: kept ? effort : null, speed: kept ? speed : null, permissionMode };
}

/** The link the started thread keeps to the thread on another machine that started it. */
export function remoteOrigin(start: GroupStart, peer: CoordinationPeer): ThreadLink {
  return { threadId: start.from.threadId, title: start.from.title, projectId: start.from.projectId, project: start.from.project, machine: peer.name };
}

/** `setting.read`: what this machine has for a setting the others may ask about. */
export function readMachineSetting(core: Core, payload: unknown): { key: string; value: unknown } {
  const key = (payload as { key?: unknown } | null)?.key;
  if (!isMachineSetting(key)) throw invalidParams(`setting.key: expected ${MACHINE_SETTINGS.join(' or ')}`);
  return { key, value: effectiveSetting(core.settings.get(), key) };
}

/** `setting.changed`: a member says its setting moved; the cards about it there settle, and the bots here that look after its projects hear it. */
export function machineSettingChanged(core: Core, peer: CoordinationPeer, payload: unknown): { ok: true } {
  const { key, value } = (payload ?? {}) as { key?: unknown; value?: unknown };
  if (!isMachineSetting(key) || typeof value !== 'boolean') throw invalidParams(`setting: expected ${MACHINE_SETTINGS.join(' or ')} and true or false`);
  core.threads.cards.machineSettingChanged(peer, key, value);
  if (key === 'groupBots') core.workforce.group.peerAllows(peer, value);
  return { ok: true };
}

/** The owner changed a machine setting here: the other members hear it, so the cards asking about it settle. A member away misses it. */
export function announceMachineSetting(core: Core, key: MachineSetting, value: boolean): void {
  for (const peer of core.group.peers()) {
    void core.coordination.request(peer, 'setting.changed', { key, value }).catch(() => undefined);
  }
}
