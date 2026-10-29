import type { AgentDraft, AgentProfile, Turn, Usage } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { quietAgent, waitFor, type TestCore } from './harness.ts';

/** An echo agent's profile, as a test saves it. */
export function agentValue(accountId: string, over: Partial<AgentDraft<AgentProfile>> = {}): AgentDraft<AgentProfile> {
  return {
    name: 'Ada', domain: 'Open source', instructions: 'Keep the projects moving.', avatar: '', status: 'active', projectIds: [],
    selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' }, ...over,
  };
}

export function echoAccount(h: TestCore): string {
  const account = h.core.accounts.list().find(a => a.providerId === 'echo');
  if (!account) throw new Error('no echo account');
  return account.id;
}

/** The turns of a thread, oldest first. */
export function turnsOf(h: TestCore, threadId: string): Turn[] { return h.core.journal.listTurns(threadId); }

/** Every turn of the thread has ended. */
export function settled(h: TestCore, threadId: string): boolean {
  const thread = h.core.journal.getThread(threadId);
  return thread !== null && !['queued', 'running', 'waiting'].includes(thread.status) && !h.core.threads.runner.handles.has(threadId)
    && turnsOf(h, threadId).every(t => t.status !== 'queued' && t.status !== 'running');
}

/**
 * An agent with its thread, its introduction turn finished. `quiet`: no
 * memory pass and no subagents, so a scenario reads only its own turns.
 */
export async function makeAgent(h: TestCore, client: CoreClient, over: Partial<AgentDraft<AgentProfile>> = {}, quiet = true): Promise<{ agent: AgentProfile; threadId: string }> {
  const paused = h.core.workforce.limits().paused;
  h.core.workforce.setLimits({ paused: true });
  let agent = await client.call('agents.profile.save', { value: agentValue(echoAccount(h), over) });
  if (quiet) agent = await quietAgent(client, agent);
  const threadId = h.core.workforce.sessionOf(agent.id)!.threadId;
  h.core.workforce.setLimits({ paused });
  if (!paused && agent.status === 'active') await waitFor(() => turnsOf(h, threadId).length > 0 && settled(h, threadId), 10_000);
  return { agent, threadId };
}

export interface Answer { text?: string; status?: 'done' | 'error'; usage?: Usage | null; hold?: boolean }

/**
 * Replaces the echo driver: `answer` writes each turn's reply. A turn with
 * `hold` stays running until `release`. Prompts are kept per thread.
 */
export function scripted(answer: (ctx: TurnContext) => Answer) {
  const prompts = new Map<string, string[]>();
  const held: (() => void)[] = [];
  const restore = setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const reply = answer(ctx);
    const id = ctx.emit.startMessage('assistant');
    if (reply.text !== undefined) ctx.emit.part(id, 0, { type: 'text', text: reply.text });
    ctx.emit.complete(id, 'complete');
    const result: TurnResult = reply.status === 'error'
      ? { status: 'error', error: 'Asked to fail', sessionId: ctx.sessionId ?? `session:${ctx.thread.id}`, usage: reply.usage ?? null }
      : { status: 'done', sessionId: ctx.sessionId ?? `session:${ctx.thread.id}`, usage: reply.usage ?? null };
    let stop = (): void => undefined;
    const done = reply.hold ? new Promise<TurnResult>(resolve => { held.push(() => resolve(result)); stop = () => resolve({ ...result, status: 'stopped' }); }) : Promise.resolve(result);
    return { done, stop: () => stop() };
  } });
  return { prompts, restore, release: () => { for (const done of held.splice(0)) done(); }, held };
}

/** A usage report costing `costUsd` in API-equivalent dollars. */
export function costing(costUsd: number): Usage {
  return { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: costUsd };
}
