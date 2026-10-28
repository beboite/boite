/**
 * `delegation.spawn` with `machine`: the subagent's thread lives on another
 * in-memory machine of the group, as the core's `RemoteDelegation`
 * (`delegation/remote.ts`) starts it there. Its parent keeps the last state it
 * saw, and its result crosses back as a `result` letter from that machine.
 */
import { RpcErrorCode, delegationReply, type AgentLetter, type DelegatedAgent, type DelegationConfig, type DelegationProfile, type RpcParams, type SettingMachine, type Thread, type ThreadId, type Turn, type WorkflowStepPlan } from '@boite/contracts';
import { RpcFailure } from '../client';
import { fakeCore } from './coordination';
import type { FakeContext } from './context';
import { fakeMember } from './requests';
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

type Base = Pick<DelegationProfile, 'id' | 'providerId' | 'effort'> & { model: string | null };
type Ask = Pick<RpcParams<'delegation.spawn'>, 'model' | 'effort' | 'speed' | 'project' | 'worktree' | 'title'>;

/** The child's thread on the member, not stored yet: that machine's model and project, or refused as the core and that member do. */
function placeThere(ctx: FakeContext, parent: Thread, config: DelegationConfig, base: Base, machine: SettingMachine, params: Ask, task: string) {
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
    id, projectId: project.id, cwd: worktree?.path ?? project.path, branch: worktree?.branch ?? null,
    title: params.title?.trim() || task.split('\n')[0]!.slice(0, 80), titleSource: 'user',
    providerId, accountId: account.id, model: pick ? pick.model : base.model, effort: pick ? pick.effort : base.effort ?? null, speed: pick ? pick.speed : null,
    permissionMode: parent.permissionMode,
    status: 'idle', unread: false, archived: false, pinned: false,
    sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, moveNote: null,
    createdAt: at, updatedAt: at, messagesBefore: null, messages: [], turns: [], commands: [], background: [], backgroundHistory: []
  };
  return { there, child, project, worktree, profileId: pick && params.model !== undefined ? `${pick.providerId}/${pick.model}` : base.id };
}

/** Starts the child on the member, or refuses as the core and that member do. */
export function spawnThere(ctx: FakeContext, parent: Thread, config: DelegationConfig, base: Base, machine: SettingMachine, params: RpcParams<'delegation.spawn'>, task: string): DelegationRow {
  const { there, child, project, worktree, profileId } = placeThere(ctx, parent, config, base, machine, params, task);
  const id = child.id;
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
  return { threadId: id, profileId, task, machine };
}

/**
 * A workflow step's subagent on the member, as the core's `MachineWorkflowSteps` starts it through the
 * remote delegation: routed against that machine, at work on its brief, not a member of the parent's team
 * and with no result mail. The run settles it on its own timer, the way it settles a local step.
 */
export function workflowThere(ctx: FakeContext, parent: Thread, config: DelegationConfig, base: Base, step: WorkflowStepPlan, title: string, task: string) {
  if (parent.agentSessionId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation.spawn.machine: a bot\'s subagents run on its own machine', data: { field: 'machine' } });
  const machine = fakeMember(ctx, step.machine ?? '', 'delegation.spawn');
  const { there, child, worktree } = placeThere(ctx, parent, config, base, machine, { model: step.model, effort: step.effort, project: step.project, worktree: step.worktree, title }, task);
  const at = there.now();
  const turn: Turn = { id: `turn-${child.id}`, threadId: child.id, status: 'running', queuedAt: at, startedAt: at, finishedAt: null, usage: null, error: null };
  Object.assign(child, { status: 'running', turns: [turn], messages: [{ id: `m-${child.id}-task`, threadId: child.id, turnId: turn.id, role: 'user', parts: [{ type: 'text', text: task }], state: 'complete', createdAt: at }] });
  there.threads.set(child.id, child);
  if (worktree) there.delegationWorktrees.set(child.id, worktree);
  there.emit('thread.created', structuredClone(toSummary(child)));
  return { machine, childId: child.id, providerId: child.providerId, model: child.model, effort: child.effort ?? null, worktree };
}

/**
 * `delegation.send` from the parent to its child on another machine, as the core's `RemoteDelegation.send`:
 * that machine files the letter and the child takes it as a new turn, or answers the question it waits on.
 * The parent keeps a delivered copy.
 */
export function sendThere(ctx: FakeContext, sender: Thread, row: DelegationRow, params: RpcParams<'delegation.send'>): AgentLetter {
  const machine = row.machine!;
  const body = params.text.trim();
  if (!body || body.length > 4000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'text must contain 1 to 4000 characters' });
  const key = `${sender.id}:${params.requestId}`;
  const fingerprint = JSON.stringify([`${machine.coreId}:${row.threadId}`, body]);
  const prior = ctx.delegationSendRequests.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
    return structuredClone(prior.letter);
  }
  const config = ctx.delegationConfigs.get(sender.id);
  if (sender.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation messages require an unarchived parent and threads' });
  if (config?.enabled === false || config?.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
  const there = fakeCore(machine.coreId);
  if (!there?.threads.has(row.threadId)) throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${machine.name} did not answer; the same --request-id sends it once`, data: { field: 'machine' } });
  // That machine's switch, refused in the same words as a start there.
  memberModels(ctx, sender, machine.coreId, 'delegation.send');
  const child = there.thread(row.threadId);
  if (child.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${machine.name}: delegation messages require unarchived threads` });
  const reply = delegationReply([...there.pendingQuestions.values()].map(entry => entry.request).filter(request => request.threadId === child.id), body);
  if (typeof reply === 'string') throw new RpcFailure({ code: RpcErrorCode.Refused, message: reply, data: { field: 'text', toThreadId: child.id } });
  const question = reply?.question, answer = reply?.answer;
  if (question && answer) {
    there.pendingQuestions.get(question.id)?.resolve(answer);
    there.pendingQuestions.delete(question.id);
  } else there.startTurn(child.id, body, []);
  const at = ctx.now();
  const letter: AgentLetter = {
    id: `letter-${++ctx.seq}`, origin: 'user',
    from: { coreId: 'local', threadId: sender.id, title: sender.title, project: ctx.projects.find(project => project.id === sender.projectId)?.name, machine: 'Boite', resources: '', status: sender.status, mode: 'team' },
    to: { coreId: machine.coreId, threadId: child.id }, toTitle: child.title, toProject: there.projects.find(project => project.id === child.projectId)?.name, toMachine: machine.name,
    text: body, replyTo: null, createdAt: at, expiresAt: at + 15 * 60_000, status: 'delivered', error: null, ...(question ? { answered: question.id } : {}),
  };
  ctx.delegationLetters.set(sender.id, [...(ctx.delegationLetters.get(sender.id) ?? []), letter]);
  ctx.delegationSendRequests.set(key, { fingerprint, letter });
  ctx.emit('delegation.changed', { threadId: sender.id });
  return structuredClone(letter);
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
