/**
 * `boite delegate`: subagents for the agent of this thread. Every answer is a
 * few lines a model reads back cheaply: one row per child or run, its state,
 * its model and reasoning, its time, then the one next step that makes sense.
 */
import { threadActive, CONVERSATION_PROFILE_ID, speedName } from '@boite/contracts';
import type { DelegatedAgent, DelegationModelChoice, DelegationView, PauseOrigin, RpcParams, WorkflowRun } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import { INTERRUPTION_TEXT } from './delegation/interruption.ts';
import { needLine, worktreeLine } from './delegation/messages.ts';
import { requiredText, Usage } from './cli-args.ts';

type Print = (lines: string[], value: unknown) => void;

export interface DelegateOptions {
  requestId?: string;
  project?: string;
  timeout?: number;
  title?: string;
  model?: string;
  effort?: string;
  speed?: string;
  profile?: string;
  /** A git worktree of its own instead of the parent's checkout. */
  worktree?: boolean;
  /** `delegate models|spawn --machine <name>`: another machine of the group. */
  machine?: string;
  /** What `contextRequest` built from the context flags; the core checks it. */
  context?: Record<string, unknown>;
}

export const DELEGATE_ACTIONS = 'models, spawn, list, send, stop, resume, wait, result or profiles';
const PROFILE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** `42s`, `3m05s`, `1h02m`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/**
 * Done, failed or stopped from the last turn; a child that never finished a turn is its thread status.
 * `question`: it waits on an answer to its question. `approval`: a permission request waits for the user.
 * `waiting`: the turn ended on background work that will wake it. `interrupted`: that work ended without waking it.
 */
function stateOf(agent: DelegatedAgent): string {
  if (agent.thread.status === 'waiting') return agent.needsInput?.find(need => need.kind === 'permission' || need.blocking)?.kind === 'question' ? 'question' : 'approval';
  if (threadActive(agent.thread.status)) return agent.thread.status;
  const wait = agent.thread.backgroundWait;
  if (wait) return wait.state;
  const turn = agent.lastTurn?.status;
  return turn === 'error' ? 'failed' : turn ?? agent.thread.status;
}

/** A child at work, a turn under way or a wait on its own background work. */
const busy = (agent: DelegatedAgent) => threadActive(agent.thread.status) || agent.thread.backgroundWait?.state === 'waiting';

/** `codex/gpt-5.5 effort=high speed=priority`: what a child runs on, the speed as its stored tier id. */
export function routeOf(agent: DelegatedAgent): string {
  const { providerId, model, effort, speed, contextMode } = agent.thread;
  return `${providerId}/${model ?? 'default'}${effort ? ` effort=${effort}` : ''}${speed ? ` speed=${speed}` : ''}${contextMode ? ` context=${contextMode.label}${contextMode.rules ? '+rules' : ''}` : ''}`;
}

function agentRow(agent: DelegatedAgent, now: number): string[] {
  const state = stateOf(agent);
  const wait = agent.thread.backgroundWait;
  const end = busy(agent) ? now : wait?.state === 'interrupted' ? wait.at : agent.lastTurn?.finishedAt ?? now;
  const route = routeOf(agent);
  const head = `${agent.thread.id} ${state} ${elapsed(end - agent.thread.createdAt)} ${route}${agent.machine ? ` on ${agent.machine.name}` : ''} ${JSON.stringify(agent.thread.title)}`;
  const lines = [head];
  if (wait?.state === 'waiting') lines.push(`  waiting for: ${oneLine(wait.for, 200)} (${elapsed(now - wait.since)})`);
  if (wait?.state === 'interrupted') lines.push(`  interrupted: ${oneLine(wait.for, 200)} ended without waking it (${INTERRUPTION_TEXT[wait.reason]}); boite delegate send ${agent.thread.id} "<instruction>" resumes it`);
  for (const need of agent.needsInput ?? []) lines.push(needLine(agent.thread.id, need));
  if (agent.worktree) lines.push(`  ${worktreeLine(agent.worktree)}`);
  if (threadActive(agent.thread.status) || !agent.result) return lines;
  // A turn ended on background work left a checkpoint, never the final result.
  return [...lines, `  ${wait ? 'checkpoint' : 'result'}: ${oneLine(agent.result, 300)}${agent.result.length > 300 && agent.resultRef ? ` (full: boite delegate result ${agent.resultRef.agentId} ${agent.resultRef.turnId})` : ''}`];
}

function runRow(run: WorkflowRun, now: number): string {
  const instances = run.nodes.flatMap(node => node.instances);
  const total = run.nodes.reduce((n, node) => n + Math.max(1, node.instances.length), 0);
  const done = instances.filter(i => i.status === 'done' || i.status === 'skipped').length;
  const failed = instances.filter(i => i.status === 'failed').length;
  return `${run.id} workflow ${run.status} ${elapsed((run.finishedAt ?? now) - run.createdAt)} steps=${done}/${total}${failed ? ` failed=${failed}` : ''} ${JSON.stringify(run.name)}`;
}

const PAUSED_BY: Record<PauseOrigin, string> = {
  owner: 'by the owner', stop: "by the owner's Stop", agent: 'by you (boite delegate resume)', restart: 'by a restart (boite delegate resume)',
};

function teamLine(view: DelegationView, runs: WorkflowRun[]): string {
  const states = view.agents.map(stateOf);
  const count = (state: string) => states.filter(s => s === state).length;
  // `waiting` here is a wait on background work, counted apart; a permission request reads `approval`.
  const running = states.filter(s => s === 'queued' || s === 'running' || s === 'approval' || s === 'question').length + runs.filter(r => r.status === 'running').length;
  const delegation = !view.config.enabled ? 'off' : view.config.paused ? `paused ${PAUSED_BY[view.config.pausedBy ?? 'owner']}` : 'on';
  return `subagents: ${delegation}; ${running} running, ${count('waiting')} waiting, ${count('done')} done, ${count('failed')} failed, ${count('stopped')} stopped${count('interrupted') ? `, ${count('interrupted')} interrupted` : ''}${runs.length ? `; ${runs.length} workflow${runs.length > 1 ? 's' : ''}` : ''}`;
}

export function choiceRow(choice: DelegationModelChoice): string {
  const efforts = choice.efforts.length ? ` effort=${choice.efforts.join('|')}${choice.defaultEffort ? ` (default ${choice.defaultEffort})` : ''}` : ' (no reasoning levels)';
  // The id is what `--speed` stores and `delegate list` shows; a label that says something else stands in front of it.
  const tiers = choice.speeds ?? [];
  const speeds = tiers.length ? ` speed=${tiers.map(speedName).join('|')}` : '';
  return `${choice.providerId}/${choice.model} ${JSON.stringify(choice.name)}${efforts}${speeds}${choice.current ? ' [this conversation]' : ''}`;
}

export async function delegateCommand(client: CoreClient, threadId: string, rest: string[], options: DelegateOptions, print: Print): Promise<void> {
  const action = rest[0];
  const want = (index: number, what: string): string => {
    const value = rest[index];
    if (value === undefined || value.length === 0) throw new Usage(`delegate ${action} needs ${what}`);
    return value;
  };
  const requestId = options.requestId ?? crypto.randomUUID();
  switch (action) {
    case 'models': {
      const machine = options.machine;
      const models = await client.call('delegation.models', { threadId, ...(machine === undefined ? {} : { machine }) });
      print([
        machine === undefined
          ? `models a child can run on: boite delegate spawn "<brief>" --model <provider/model> [--effort <level>] [--speed <tier>]`
          : `models a thread on ${machine} can run on: boite thread new <project> "<brief>" --machine ${machine} --model <provider/model> [--effort <level>] [--speed <tier>], or boite delegate spawn "<brief>" --machine ${machine} --model <provider/model> for a subagent there`,
        ...models.choices.map(choiceRow),
        ...models.unavailable.map(u => `unavailable: ${u.providerId} (${u.reason})`),
        ...(models.anyModel ? [] : ['The owner allows only this conversation\'s model and the profiles (boite delegate profiles); --model must name one of them.']),
      ], models);
      return;
    }
    case 'profiles': {
      const view = await client.call('delegation.get', { threadId });
      print([
        `subagents: ${!view.config.enabled ? 'off' : view.config.paused ? 'paused by the owner' : 'on'}`,
        `any model: ${view.config.anyModel === false ? 'no, only these profiles' : 'yes, see boite delegate models'}`,
        ...(view.config.profiles.some(p => p.id === CONVERSATION_PROFILE_ID) ? [] : [`${CONVERSATION_PROFILE_ID} "This conversation's model"`]),
        ...view.config.profiles.map(p => `${p.id} ${JSON.stringify(p.name)} ${p.providerId}/${p.model} effort=${p.effort ?? 'default'}`),
      ], view);
      return;
    }
    case 'list':
    case 'status': {
      const [view, runs] = await Promise.all([
        client.call('delegation.get', { threadId }),
        client.call('workflows.list', { threadId }).catch(() => [] as WorkflowRun[]),
      ]);
      const now = Date.now();
      const busyTeam = view.agents.some(busy) || runs.some(r => r.status === 'running');
      print([
        teamLine(view, runs),
        ...view.agents.flatMap(agent => agentRow(agent, now)),
        ...runs.map(run => runRow(run, now)),
        ...(!view.agents.length && !runs.length ? ['No subagent yet: boite delegate spawn "<brief>" starts one.']
          : busyTeam ? ['Results arrive as messages: keep working or end your turn, do not poll.'] : []),
      ], { ...view, workflows: runs });
      return;
    }
    case 'spawn': {
      let profileId = options.profile;
      let start = 1;
      // `delegate spawn <profile> <brief>`, the older form, when the first word names a profile.
      if (profileId === undefined && options.model === undefined && rest.length > 2 && PROFILE_ID.test(rest[1]!)) {
        const view = await client.call('delegation.get', { threadId });
        if (rest[1] === CONVERSATION_PROFILE_ID || view.config.profiles.some(p => p.id === rest[1])) { profileId = rest[1]; start = 2; }
      }
      const speed = options.speed?.trim();
      if (speed !== undefined && (!speed || speed.length > 64)) throw new Usage('--speed needs a tier of 1 to 64 characters; boite delegate models lists them');
      const task = requiredText(rest, start, 'delegate spawn needs a brief: boite delegate spawn "<brief>" [--model <provider/model>] [--effort <level>] [--speed <tier>]', false);
      const agent = await client.call('delegation.spawn', {
        threadId, task, requestId,
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.context === undefined ? {} : { context: options.context as RpcParams<'delegation.spawn'>['context'] }),
        ...(speed === undefined ? {} : { speed }),
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.worktree === true ? { worktree: true } : {}),
        ...(options.machine === undefined ? {} : { machine: options.machine }),
      });
      print([
        `agent: ${agent.thread.id}`,
        ...(agent.machine ? [`machine: ${agent.machine.name}`] : []),
        `model: ${routeOf(agent)}`,
        `status: ${agent.thread.status}`,
        ...(agent.thread.projectId === null ? [] : [`project: ${agent.thread.projectId}`, `cwd: ${agent.thread.cwd}`]),
        ...(agent.worktree ? [`worktree: ${agent.worktree.path} on branch ${agent.worktree.branch}, made from the source checkout's HEAD when it starts; uncommitted edits are not in it`] : []),
        'Its result comes back to you as a message. Keep working or end your turn; do not poll.',
      ], agent);
      return;
    }
    case 'send': {
      const toThreadId = want(1, 'a parent or child thread id');
      const body = requiredText(rest, 2, 'delegate send needs message text', false);
      const letter = await client.call('delegation.send', { threadId, toThreadId, text: body, requestId });
      print(letter.answered
        ? [`message: ${letter.id}`, `answered: question ${letter.answered}`, 'It goes on with that answer.']
        : [`message: ${letter.id}`, `status: ${letter.status}`, 'Delivered at its next tool boundary or turn. A receipt is not an answer.'], letter);
      return;
    }
    case 'wait': {
      const result = await client.call('delegation.wait', { threadId, ...(rest[1] ? { agentId: rest[1] } : {}), ...(options.timeout === undefined ? {} : { timeoutMs: Math.round(options.timeout * 1000) }) });
      const now = Date.now();
      print([`state: ${result.state}`, `timed out: ${result.timedOut ? 'yes' : 'no'}`, ...result.agents.flatMap(agent => agentRow(agent, now)),
        ...(result.state === 'needs_input' ? ['A subagent waits on someone: answer its question with boite delegate send <thread-id> "<answer>", or ask the user; only the user approves a tool.'] : [])], result);
      return;
    }
    case 'result': {
      const agentId = want(1, 'a child thread id'), turnId = want(2, 'the result turn id');
      const result = await client.call('delegation.result', { threadId, agentId, turnId, ...(rest[3] === undefined ? {} : { offset: Number(rest[3]) }) });
      print([result.text, `next offset: ${result.nextOffset ?? 'complete'}`, `total: ${result.total}`], result);
      return;
    }
    case 'stop': {
      const result = await client.call('delegation.stop', { threadId, ...(rest[1] ? { agentId: rest[1] } : {}) });
      print([`stopped: ${result.stopped}`, ...(rest[1] || result.stopped === 0 ? [] : ['The team is paused; boite delegate resume continues it.'])], result);
      return;
    }
    case 'resume': {
      const result = await client.call('delegation.resume', { threadId, ...(rest[1] ? { agentId: rest[1] } : {}) });
      print([
        ...(result.unpaused ? ['The team is no longer paused.'] : []),
        result.agents.length ? `continued: ${result.agents.join(', ')}` : 'No stopped subagent to continue.',
        ...(result.runs.length ? [`workflows resumed: ${result.runs.join(', ')}`] : []),
      ], result);
      return;
    }
    default:
      throw new Usage(`delegate expects ${DELEGATE_ACTIONS}`);
  }
}
