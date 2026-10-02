/** `agent.spawn`, as the core's `threads/spawn.ts` answers it: the same refusals, a real thread with the brief as its first message. */
import { RpcErrorCode, type AgentProjectAdded, type AgentSpawn, type Message, type ThreadLink } from '@boite/contracts';
import { RpcFailure } from '../client';
import { missingFolder, pathKey } from './checks';
import { coordinationConfig } from './coordination';
import { toSummary } from './shared';
import { resolveProject } from './thread-move';
import type { FakeContext, FakeMethods } from './context';

function refuse(message: string, data: Record<string, unknown>): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, data });
}

/**
 * The fake starts the thread and its turn, marks both ends, and keeps retries
 * idempotent. The answer the core sends back when the first turn ends is not
 * simulated: the fake's turns finish on their own schedule.
 */
export function spawnMethods(ctx: FakeContext, create: FakeMethods['threads.create'], addProject: FakeMethods['projects.add']) {
  const ledgers = new Map<string, { requestId: string; fingerprint: string; at: number; answer: AgentSpawn }[]>();
  const pending = new Map<string, { fingerprint: string; result: Promise<AgentSpawn> }>();
  const origins = new Map<string, ThreadLink>();
  return {
    'agent.addProject': async (params): Promise<AgentProjectAdded> => {
      const method = 'agent.addProject';
      const caller = ctx.thread(params.threadId);
      if (caller.agentSessionId || caller.projectId === null) throw refuse('a persistent agent session takes its work through Agents and cannot add projects', { threadId: caller.id, field: 'threadId' });
      if (caller.parentThreadId) throw refuse('a delegated agent or workflow step cannot add projects; ask its parent', { threadId: caller.id, field: 'threadId' });
      const path = typeof params.path === 'string' ? params.path.trim() : '';
      if (!path || !/^([A-Za-z]:[\\/]|[\\/])/.test(path)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `${method}.path: expected an absolute folder, got ${path}` });
      const answer = (p: { id: string; name: string; path: string; repository?: boolean; kind?: string }, added: boolean): AgentProjectAdded => (
        { id: p.id, name: p.name, path: p.path, repository: p.repository === true, drafts: p.kind === 'drafts', current: p.id === caller.projectId, added });
      const known = ctx.projects.find(p => pathKey(p.path) === pathKey(path));
      if (known) return answer(known, false);
      const config = coordinationConfig(ctx, caller.id);
      if (config.mode === 'off') throw refuse(`${method}: communication is off for this thread; the owner turns it on in Communication settings`, { threadId: caller.id, field: 'coordination' });
      if (config.paused) throw refuse(`${method}: communication is paused for this thread; only the owner resumes it`, { threadId: caller.id, field: 'coordination' });
      if (!config.remote) throw refuse(`${method}: this thread may only reach its own project; the owner allows other projects in Communication settings`, { threadId: caller.id, field: 'coordination' });
      if (origins.has(caller.id) && caller.messages.filter(m => m.role === 'user').length <= 1) throw refuse('a thread an agent started cannot add a project until the user writes in it', { threadId: caller.id, field: 'threadId' });
      if (missingFolder(path)) throw refuse('a project path must be an existing directory', { path });
      const project = await addProject({ path, ...(params.name === undefined ? {} : { name: params.name.trim() }) });
      const line: Message = {
        id: `m-${++ctx.seq}`, threadId: caller.id, turnId: caller.turns.at(-1)?.id ?? `turn-${++ctx.seq}`, role: 'system', state: 'complete', createdAt: ctx.now(),
        parts: [{ type: 'text', text: `The agent added the project ${project.name} (${project.path}).` }],
      };
      caller.messages.push(line);
      ctx.emitToThread(caller.id, 'message.started', structuredClone(line));
      ctx.emitToThread(caller.id, 'message.completed', { threadId: caller.id, messageId: line.id, state: 'complete' });
      return answer(project, true);
    },
    'agent.spawn': async (params): Promise<AgentSpawn> => {
      const caller = ctx.thread(params.threadId);
      if (caller.agentSessionId || caller.projectId === null) throw refuse('a persistent agent session takes its work through Agents and cannot start threads', { threadId: caller.id, field: 'threadId' });
      if (caller.parentThreadId) throw refuse('a delegated agent or workflow step cannot start threads; ask its parent', { threadId: caller.id, field: 'threadId' });
      if (caller.archived) throw refuse('an archived thread cannot start threads', { threadId: caller.id, field: 'threadId', expected: 'a thread that is not archived' });
      const prompt = params.prompt.trim();
      if (!prompt || params.prompt.length > 12_000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'agent.spawn.prompt: expected 1 to 12000 characters' });
      const fingerprint = JSON.stringify([params.project, params.prompt, params.title ?? null, params.worktree === true]);
      const ledger = ledgers.get(caller.id) ?? [];
      const retried = ledger.find(entry => entry.requestId === params.requestId);
      if (retried) {
        if (retried.fingerprint !== fingerprint) throw refuse('agent.spawn.requestId was already used for different content', { threadId: caller.id, field: 'requestId' });
        return structuredClone(retried.answer);
      }
      const key = JSON.stringify([caller.id, params.requestId]);
      const active = pending.get(key);
      if (active) {
        if (active.fingerprint !== fingerprint) throw refuse('agent.spawn.requestId was already used for different content', { threadId: caller.id, field: 'requestId' });
        return structuredClone(await active.result);
      }
      const result = Promise.resolve().then(async () => {
        if (ctx.thread(caller.id).archived) throw refuse('an archived thread cannot start threads', { threadId: caller.id, field: 'threadId', expected: 'a thread that is not archived' });
        const target = resolveProject(ctx, caller.id, params.project, 'agent.spawn');
        const config = coordinationConfig(ctx, caller.id);
        if (config.mode === 'off') throw refuse('agent.spawn: communication is off for this thread; the owner turns it on in Communication settings', { threadId: caller.id, field: 'coordination' });
        if (config.paused) throw refuse('agent.spawn: communication is paused for this thread; only the owner resumes it', { threadId: caller.id, field: 'coordination' });
        if (target.id !== caller.projectId && !config.remote) throw refuse('agent.spawn: this thread may only reach its own project; the owner allows other projects in Communication settings', { threadId: caller.id, field: 'project' });
        if (origins.has(caller.id) && caller.messages.filter(m => m.role === 'user').length <= 1) throw refuse('a thread an agent started cannot start another until the user writes in it', { threadId: caller.id, field: 'threadId' });
        const title = params.title?.trim() || prompt.split('\n')[0]!.slice(0, 80);
        const created = await create({
          projectId: target.id, providerId: caller.providerId, accountId: caller.accountId, title,
          ...(caller.model === null ? {} : { model: caller.model }), effort: caller.effort, permissionMode: caller.permissionMode,
          ...(params.worktree ? { worktree: {} } : {}),
        });
        if (ctx.thread(caller.id).archived) throw refuse('an archived thread cannot start threads', { threadId: caller.id, field: 'threadId', expected: 'a thread that is not archived' });
        const thread = ctx.thread(created.id);
        thread.titleSource = 'user';
        const from = ctx.projects.find(project => project.id === caller.projectId)!;
        const origin: ThreadLink = { threadId: caller.id, title: caller.title, projectId: from.id, project: from.name };
        origins.set(thread.id, origin);
        const turn = ctx.startTurn(thread.id, prompt);
        const first = thread.messages.find(message => message.turnId === turn.id && message.role === 'user');
        const part = first?.parts[0];
        if (part?.type === 'text') Object.assign(part, { displayText: prompt, startedBy: origin });
        const line: Message = {
          id: `m-${++ctx.seq}`, threadId: caller.id, turnId: caller.turns.at(-1)?.id ?? `turn-${++ctx.seq}`, role: 'system', state: 'complete', createdAt: ctx.now(),
          parts: [{ type: 'text', text: `Started thread "${title}" (${thread.id}) in project ${target.name}.`, started: { threadId: thread.id, title, projectId: target.id, project: target.name } }],
        };
        caller.messages.push(line);
        ctx.emitToThread(caller.id, 'message.started', structuredClone(line));
        ctx.emitToThread(caller.id, 'message.completed', { threadId: caller.id, messageId: line.id, state: 'complete' });
        const answer: AgentSpawn = { thread: structuredClone(toSummary(thread)), turnId: turn.id, address: { coreId: ctx.identity.coreId, threadId: thread.id }, project: target.name };
        const at = ctx.now();
        ledgers.set(caller.id, [...(ledgers.get(caller.id) ?? []).filter(entry => entry.at > at - 86_400_000), { requestId: params.requestId, fingerprint, at, answer }]);
        return answer;
      });
      pending.set(key, { fingerprint, result });
      try { return structuredClone(await result); }
      finally { pending.delete(key); }
    },
  } satisfies Partial<FakeMethods>;
}
