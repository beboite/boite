/**
 * `boite delegate`: subagents for the agent of this thread. Every answer is a
 * few lines a model reads back cheaply: one row per child or run, its state,
 * its model and reasoning, its time, then the one next step that makes sense.
 */
import { CONVERSATION_PROFILE_ID } from '@boite/contracts';
import type { DelegatedAgent, DelegationModelChoice, DelegationView, WorkflowRun } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import { requiredText, Usage } from './cli-args.ts';

type Print = (lines: string[], value: unknown) => void;

export interface DelegateOptions {
  requestId?: string;
  timeout?: number;
  title?: string;
  model?: string;
  effort?: string;
  profile?: string;
}

export const DELEGATE_ACTIONS = 'models, spawn, list, send, stop, wait, result or profiles';
const ACTIVE = new Set(['queued', 'running', 'waiting']);
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

/** Done, failed or stopped from the last turn; a child that never finished a turn is its thread status. */
function stateOf(agent: DelegatedAgent): string {
  if (ACTIVE.has(agent.thread.status)) return agent.thread.status;
  const turn = agent.lastTurn?.status;
  return turn === 'error' ? 'failed' : turn ?? agent.thread.status;
}

function agentRow(agent: DelegatedAgent, now: number): string[] {
  const state = stateOf(agent);
  const end = ACTIVE.has(agent.thread.status) ? now : agent.lastTurn?.finishedAt ?? now;
  const route = `${agent.thread.providerId}/${agent.thread.model ?? 'default'}${agent.thread.effort ? ` effort=${agent.thread.effort}` : ''}`;
  const head = `${agent.thread.id} ${state} ${elapsed(end - agent.thread.createdAt)} ${route} ${JSON.stringify(agent.thread.title)}`;
  if (ACTIVE.has(agent.thread.status) || !agent.result) return [head];
  return [head, `  result: ${oneLine(agent.result, 300)}${agent.result.length > 300 && agent.resultRef ? ` (full: boite delegate result ${agent.resultRef.agentId} ${agent.resultRef.turnId})` : ''}`];
}

function runRow(run: WorkflowRun, now: number): string {
  const instances = run.nodes.flatMap(node => node.instances);
  const total = run.nodes.reduce((n, node) => n + Math.max(1, node.instances.length), 0);
  const done = instances.filter(i => i.status === 'done' || i.status === 'skipped').length;
  const failed = instances.filter(i => i.status === 'failed').length;
  return `${run.id} workflow ${run.status} ${elapsed((run.finishedAt ?? now) - run.createdAt)} steps=${done}/${total}${failed ? ` failed=${failed}` : ''} ${JSON.stringify(run.name)}`;
}

function teamLine(view: DelegationView, runs: WorkflowRun[]): string {
  const states = view.agents.map(stateOf);
  const count = (state: string) => states.filter(s => s === state).length;
  const running = states.filter(s => ACTIVE.has(s)).length + runs.filter(r => r.status === 'running').length;
  const delegation = !view.config.enabled ? 'off' : view.config.paused ? 'paused by the owner' : 'on';
  return `subagents: ${delegation}; ${running} running, ${count('done')} done, ${count('failed')} failed, ${count('stopped')} stopped${runs.length ? `; ${runs.length} workflow${runs.length > 1 ? 's' : ''}` : ''}`;
}

export function choiceRow(choice: DelegationModelChoice): string {
  const efforts = choice.efforts.length ? ` effort=${choice.efforts.join('|')}${choice.defaultEffort ? ` (default ${choice.defaultEffort})` : ''}` : ' (no reasoning levels)';
  return `${choice.providerId}/${choice.model} ${JSON.stringify(choice.name)}${efforts}${choice.current ? ' [this conversation]' : ''}`;
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
      const models = await client.call('delegation.models', { threadId });
      print([
        `models a child can run on: boite delegate spawn "<brief>" --model <provider/model> [--effort <level>]`,
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
      const busy = view.agents.some(a => ACTIVE.has(a.thread.status)) || runs.some(r => r.status === 'running');
      print([
        teamLine(view, runs),
        ...view.agents.flatMap(agent => agentRow(agent, now)),
        ...runs.map(run => runRow(run, now)),
        ...(!view.agents.length && !runs.length ? ['No subagent yet: boite delegate spawn "<brief>" starts one.']
          : busy ? ['Results arrive as messages: keep working or end your turn, do not poll.'] : []),
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
      const task = requiredText(rest, start, 'delegate spawn needs a brief: boite delegate spawn "<brief>" [--model <provider/model>] [--effort <level>]', false);
      const agent = await client.call('delegation.spawn', {
        threadId, task, requestId,
        ...(profileId === undefined ? {} : { profileId }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.title === undefined ? {} : { title: options.title }),
      });
      print([
        `agent: ${agent.thread.id}`,
        `model: ${agent.thread.providerId}/${agent.thread.model ?? 'default'}${agent.thread.effort ? ` effort=${agent.thread.effort}` : ''}`,
        `status: ${agent.thread.status}`,
        'Its result comes back to you as a message. Keep working or end your turn; do not poll.',
      ], agent);
      return;
    }
    case 'send': {
      const toThreadId = want(1, 'a parent or child thread id');
      const body = requiredText(rest, 2, 'delegate send needs message text', false);
      const letter = await client.call('delegation.send', { threadId, toThreadId, text: body, requestId });
      print([`message: ${letter.id}`, `status: ${letter.status}`, 'Delivered at its next tool boundary or turn. A receipt is not an answer.'], letter);
      return;
    }
    case 'wait': {
      const result = await client.call('delegation.wait', { threadId, ...(rest[1] ? { agentId: rest[1] } : {}), ...(options.timeout === undefined ? {} : { timeoutMs: Math.round(options.timeout * 1000) }) });
      const now = Date.now();
      print([`state: ${result.state}`, `timed out: ${result.timedOut ? 'yes' : 'no'}`, ...result.agents.flatMap(agent => agentRow(agent, now))], result);
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
      print([`stopped: ${result.stopped}`, ...(rest[1] || result.stopped === 0 ? [] : ['The team is paused until the owner resumes it in Subagents > Settings.'])], result);
      return;
    }
    default:
      throw new Usage(`delegate expects ${DELEGATE_ACTIONS}`);
  }
}
