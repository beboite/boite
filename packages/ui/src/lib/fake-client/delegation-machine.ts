/**
 * `delegation.spawn` with `machine`: the subagent's thread lives on another
 * in-memory machine of the group, as the core's `RemoteDelegation`
 * (`delegation/remote.ts`) starts it there. Its parent keeps the last state it
 * saw, and its result crosses back as a `result` letter from that machine.
 */
import { RpcErrorCode, type AgentLetter, type DelegatedAgent, type DelegationConfig, type DelegationProfile, type RpcParams, type SettingMachine, type Thread, type ThreadId } from '@boite/contracts';
import { RpcFailure } from '../client';
import { fakeCore } from './coordination';
import type { FakeContext } from './context';
import { toSummary } from './shared';
import { accountFor, chooseModel, machineArg, memberModels } from './thread-models';

export interface DelegationRow {
  threadId: ThreadId;
  profileId: string;
  task: string;
  /** The member that runs it; absent for a child on this machine. */
  machine?: SettingMachine;
  /** What the parent last saw of a child on another machine, kept once that machine is out of reach. */
  last?: DelegatedAgent;
}

/** The machine a child's thread lives on, while the page reaches it. */
export function childContext(ctx: FakeContext, row: DelegationRow): FakeContext | undefined {
  return row.machine === undefined ? ctx : fakeCore(row.machine.coreId);
}

/** Starts the child on the member, or refuses as the core and that member do. */
export function spawnThere(ctx: FakeContext, parent: Thread, config: DelegationConfig, base: Pick<DelegationProfile, 'id' | 'providerId' | 'effort'> & { model: string | null }, machine: SettingMachine, params: RpcParams<'delegation.spawn'>, task: string): DelegationRow {
  const { choices } = memberModels(ctx, parent, machine.coreId, 'delegation.spawn');
  const there = fakeCore(machine.coreId)!;
  const labels = choices.map(choice => `${choice.providerId}/${choice.model}`);
  const chosen = params.model !== undefined || params.effort !== undefined || params.speed !== undefined;
  const pick = chosen ? chooseModel(choices, parent, { model: params.model, effort: params.effort, speed: params.speed }, `boite delegate models --machine ${machineArg(ctx, machine)}`) : null;
  if (pick !== null && params.model !== undefined && config.anyModel === false && !(pick.providerId === parent.providerId && pick.model === parent.model) && !config.profiles.some(p => p.providerId === pick.providerId && p.model === pick.model)) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the owner limited subagents to this conversation\'s model and the profiles; leave --model out or name one of them' });
  }
  const providerId = pick?.providerId ?? base.providerId;
  const account = pick ? there.accounts.find(entry => entry.id === pick.accountId) : accountFor(there, parent, base.providerId);
  if (account === undefined) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${machine.name}: ${providerId} is not signed in on ${machine.name}; name a model of ${machine.name} with --model: ${labels.join(', ') || 'none'}`, data: { field: 'model', expected: labels } });
  }
  // Without --project, the project of that machine named like the parent's.
  const wanted = params.project?.trim() ?? ctx.projects.find(project => project.id === parent.projectId)?.name ?? '';
  const live = there.projects.filter(project => !project.archived && project.kind !== 'drafts');
  const found = live.filter(project => project.id === wanted || project.path === wanted || project.name.trim().toLowerCase() === wanted.toLowerCase());
  if (found.length !== 1) {
    const names = live.map(project => project.name);
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: found.length > 1
      ? `${machine.name}: delegation.start.project: ${found.length} projects are named ${wanted} on ${machine.name}; name one with --project`
      : `${machine.name}: delegation.start.project: ${machine.name} has no project named ${wanted || 'like the parent\'s'}; name one of its projects with --project: ${names.join(', ') || 'none'}`, data: { field: 'project', expected: names } });
  }
  const project = found[0]!;
  const id = `t-${++there.seq}`;
  const at = there.now();
  const worktree = params.worktree === true ? { branch: `boite/sub-${id}`, path: `${project.path}/.boite/worktrees/sub-${id}`, base: null, state: 'pending' as const } : null;
  // Top-level there: its parent is on another machine.
  const child: Thread = {
    ...parent,
    id, projectId: project.id, cwd: worktree?.path ?? project.path, branch: worktree?.branch ?? null,
    parentThreadId: undefined, parentIsBot: undefined, agentSessionId: undefined,
    title: params.title?.trim() || task.split('\n')[0]!.slice(0, 80), titleSource: 'user',
    providerId, accountId: account.id, model: pick ? pick.model : base.model, effort: pick ? pick.effort : base.effort ?? null, speed: pick ? pick.speed : null,
    contextMode: undefined,
    status: 'idle', unread: false, archived: false, pinned: false,
    sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, moveNote: null,
    createdAt: at, updatedAt: at, messagesBefore: null, messages: [], turns: [], commands: [], background: [], backgroundHistory: []
  };
  delete child.pullRequest;
  delete child.lastUserMessageAt;
  there.threads.set(id, child);
  if (worktree) there.delegationWorktrees.set(id, worktree);
  there.emit('thread.created', structuredClone(toSummary(child)));
  // Its result crosses back to the parent here, once per turn.
  const off = there.bus.on('turn.finished', turn => {
    if (turn.threadId !== id) return;
    if (!there.threads.has(id)) { off(); return; }
    const root = ctx.threads.get(parent.id);
    const team = ctx.delegationConfigs.get(parent.id);
    if (!root || root.archived || team?.enabled === false || team?.paused) return;
    const done = there.thread(id);
    const text = done.messages.filter(message => message.turnId === turn.id && message.role === 'assistant').flatMap(message => message.parts.flatMap(part => (part.type === 'text' ? [part.text] : []))).join('\n').trim();
    const letter: AgentLetter = {
      id: `letter-${++ctx.seq}`, origin: 'result',
      from: { coreId: machine.coreId, threadId: id, title: done.title, project: project.name, machine: machine.name, resources: '', status: done.status, mode: 'team' },
      to: { coreId: 'local', threadId: root.id }, toTitle: root.title, text: `${done.title}: ${turn.status}\n${text || 'No text result was returned.'}`.slice(0, 4000),
      replyTo: null, createdAt: ctx.now(), expiresAt: Number.MAX_SAFE_INTEGER, status: 'received', error: null,
    };
    ctx.delegationLetters.set(root.id, [...(ctx.delegationLetters.get(root.id) ?? []), letter]);
    ctx.emit('delegation.changed', { threadId: root.id });
  });
  there.startTurn(id, task, []);
  return { threadId: id, profileId: pick && params.model !== undefined ? `${pick.providerId}/${pick.model}` : base.id, task, machine };
}

/** A child on another machine as its parent sees it: live while the page reaches that machine, else as last seen. */
export function remoteAgent(row: DelegationRow, rootId: ThreadId, local: (there: FakeContext) => DelegatedAgent): DelegatedAgent {
  const there = fakeCore(row.machine!.coreId);
  if (there?.threads.has(row.threadId)) {
    const agent = local(there);
    row.last = { ...agent, thread: { ...agent.thread, parentThreadId: rootId }, machine: structuredClone(row.machine!) };
  }
  if (row.last === undefined) throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${row.machine!.name} did not answer`, data: { field: 'machine' } });
  return structuredClone(row.last);
}
