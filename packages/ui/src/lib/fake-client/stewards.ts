/**
 * Stewards on the in-memory core: the grants the owner sets in Communication
 * settings, refused with the core's codes and fields (`packages/core/src/stewards.ts`),
 * and the agent-side reads and actions held to a grant's projects and capabilities.
 */
import {
  RpcErrorCode, STEWARD_CAPABILITIES,
  type AgentLetter, type Message, type ProjectId, type RpcParams, type StewardAction, type StewardCapability, type StewardGrant,
  type StewardThread, type Thread, type ThreadId,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

const ACTION_CAPABILITY: Record<StewardAction, StewardCapability> = {
  archive: 'archive', unarchive: 'archive', remove: 'remove', stop: 'stop', rename: 'stop', move: 'move',
};

function invalid(message: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.InvalidParams, message });
}

function refused(message: string, data: Record<string, unknown>): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, data });
}

/** What `stewards.set` keeps of its input, or the core's refusal for the first field that is wrong. */
export function checkStewardGrant(ctx: FakeContext, input: RpcParams<'stewards.set'>['grant']): Omit<StewardGrant, 'grantedAt' | 'updatedAt'> {
  if (!input || typeof input !== 'object') throw invalid('grant: expected threadId, projectIds, allProjects, capabilities and notify');
  const thread = ctx.thread(input.threadId);
  const context = { threadId: thread.id, field: 'grant.threadId' };
  if (thread.agentSessionId || thread.projectId === null) throw refused('grant.threadId: a persistent agent session cannot be a steward', { ...context, expected: 'a conversation thread' });
  if (thread.parentThreadId) throw refused('grant.threadId: a delegated agent or workflow step cannot be a steward', { ...context, expected: 'a top-level thread' });
  if (thread.archived) throw refused('grant.threadId: an archived thread cannot be a steward', { ...context, expected: 'a thread that is not archived' });
  if (typeof input.allProjects !== 'boolean') throw invalid('grant.allProjects: expected true or false');
  if (typeof input.notify !== 'boolean') throw invalid('grant.notify: expected true or false');
  if (!Array.isArray(input.projectIds) || input.projectIds.length > 500) throw invalid('grant.projectIds: expected an array of at most 500 project ids');
  const projectIds = [...new Set(input.projectIds)];
  for (const projectId of projectIds) {
    if (typeof projectId !== 'string' || !ctx.projects.some(project => project.id === projectId)) {
      throw refused(`grant.projectIds: unknown project ${String(projectId)}`, { threadId: thread.id, field: 'grant.projectIds', expected: 'ids of projects added to Boite' });
    }
  }
  if (!input.allProjects && projectIds.length === 0) throw invalid('grant.projectIds: expected at least one project, or allProjects true');
  if (!Array.isArray(input.capabilities)) throw invalid(`grant.capabilities: expected an array of ${STEWARD_CAPABILITIES.join(', ')}`);
  for (const capability of input.capabilities) {
    if (!STEWARD_CAPABILITIES.includes(capability)) throw invalid(`grant.capabilities: unknown capability ${String(capability)}; expected ${STEWARD_CAPABILITIES.join(', ')}`);
  }
  return {
    threadId: thread.id, projectIds: input.allProjects ? [] : projectIds, allProjects: input.allProjects,
    capabilities: STEWARD_CAPABILITIES.filter(capability => input.capabilities.includes(capability)), notify: input.notify,
  };
}

function grantOf(ctx: FakeContext, threadId: ThreadId): StewardGrant | null {
  const grant = ctx.stewards.get(threadId);
  const thread = ctx.threads.get(threadId);
  return grant && thread && !thread.archived ? grant : null;
}

/** The drafts stay out of "every project": those conversations are the user's scratch space. */
function covers(ctx: FakeContext, grant: StewardGrant, projectId: ProjectId | null): boolean {
  const project = projectId === null ? undefined : ctx.projects.find(entry => entry.id === projectId);
  if (!project) return false;
  return grant.allProjects ? project.kind !== 'drafts' : grant.projectIds.includes(project.id);
}

function requireGrant(ctx: FakeContext, threadId: ThreadId, method: string): StewardGrant {
  const grant = grantOf(ctx, threadId);
  if (!grant) throw refused(`${method}: this thread is not a steward; the owner assigns projects to it in Communication settings`, { threadId, field: 'threadId', expected: 'a thread the owner made a steward' });
  return grant;
}

function target(ctx: FakeContext, threadId: ThreadId, targetId: unknown, method: string, capability?: StewardCapability): { grant: StewardGrant; thread: Thread } {
  const grant = requireGrant(ctx, threadId, method);
  if (typeof targetId !== 'string' || targetId.length === 0) throw invalid(`${method}.target: expected a thread id`);
  if (targetId === threadId) throw refused(`${method}.target: a steward does not act on its own thread`, { threadId, field: 'target', expected: 'another thread' });
  const thread = ctx.threads.get(targetId);
  if (!thread || thread.agentSessionId || !covers(ctx, grant, thread.projectId)) {
    throw refused(`${method}.target: ${targetId} is not a thread of the projects this steward looks after`, { threadId, field: 'target', target: targetId, expected: 'a thread in a project of the grant' });
  }
  if (capability !== undefined && !grant.capabilities.includes(capability)) {
    throw refused(`${method}: the owner did not give this steward the ${capability} capability`, { threadId, field: 'capability', expected: capability });
  }
  return { grant, thread };
}

function row(ctx: FakeContext, thread: Thread, stewardId: ThreadId): StewardThread {
  const project = ctx.projects.find(entry => entry.id === thread.projectId);
  const pending = <T extends { threadId: ThreadId }>(requests: Iterable<{ request: T }>) => [...requests].filter(entry => entry.request.threadId === thread.id).length;
  return {
    id: thread.id, title: thread.title, projectId: thread.projectId, project: project?.name ?? null,
    status: thread.status, archived: thread.archived, branch: thread.branch, self: thread.id === stewardId,
    questions: pending(ctx.pendingQuestions.values()), permissions: pending(ctx.pendingPermissions.values()),
    pullRequest: thread.pullRequest ?? null, updatedAt: thread.updatedAt,
    lastCompletedAt: thread.turns.findLast(turn => turn.status === 'done' && turn.finishedAt !== null)?.finishedAt ?? null,
  };
}

/** A system line in the target's timeline saying what the steward did. */
function line(ctx: FakeContext, thread: Thread, text: string): void {
  const message: Message = {
    id: `m-${++ctx.seq}`, threadId: thread.id, turnId: thread.turns.at(-1)?.id ?? `turn-${++ctx.seq}`, role: 'system',
    parts: [{ type: 'text', text }], state: 'complete', createdAt: ctx.now(),
  };
  thread.messages.push(message);
  ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
}

/** `methods` is the whole fake core, read when a steward acts through the owner's own paths. */
export function stewardMethods(ctx: FakeContext, methods: () => FakeMethods) {
  return {
    'stewards.list': async () => [...ctx.stewards.values()].filter(grant => ctx.threads.has(grant.threadId)).map(grant => structuredClone(grant)),
    'stewards.set': async ({ grant: input }) => {
      const checked = checkStewardGrant(ctx, input);
      const now = ctx.now();
      const grant: StewardGrant = { ...checked, grantedAt: ctx.stewards.get(checked.threadId)?.grantedAt ?? now, updatedAt: now };
      ctx.stewards.set(grant.threadId, grant);
      ctx.emit('stewards.changed', { threadId: grant.threadId });
      return structuredClone(grant);
    },
    'stewards.revoke': async ({ threadId }) => {
      if (typeof threadId !== 'string' || threadId.length === 0) throw invalid('threadId: expected a thread id');
      ctx.stewards.delete(threadId);
      ctx.emit('stewards.changed', { threadId });
      return { ok: true as const };
    },
    'steward.get': async ({ threadId }) => {
      const grant = grantOf(ctx, threadId);
      const projects = grant === null ? [] : ctx.projects.filter(project => project.archived !== true && covers(ctx, grant, project.id))
        .map(project => ({ id: project.id, name: project.name, path: project.path }));
      return { grant: grant && structuredClone(grant), projects };
    },
    'steward.threads': async (params) => {
      const grant = requireGrant(ctx, params.threadId, 'steward.threads');
      const project = params.project === undefined ? undefined
        : ctx.projects.find(entry => entry.id === params.project || entry.name === params.project || entry.path === params.project);
      if (params.project !== undefined && (!project || !covers(ctx, grant, project.id))) {
        throw refused(`steward.threads.project: ${params.project} is not one of the projects this steward looks after`, { threadId: params.threadId, field: 'project', expected: 'a project of the grant' });
      }
      const archived = params.archived === true;
      return [...ctx.threads.values()]
        .filter(thread => !thread.agentSessionId && !thread.parentThreadId && thread.archived === archived && covers(ctx, grant, thread.projectId) && (!project || thread.projectId === project.id))
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200).map(thread => row(ctx, thread, params.threadId));
    },
    'steward.thread': async (params) => {
      const grant = requireGrant(ctx, params.threadId, 'steward.thread');
      const thread = ctx.threads.get(params.target);
      if (!thread || thread.agentSessionId || !covers(ctx, grant, thread.projectId)) {
        throw refused(`steward.thread.target: ${String(params.target)} is not a thread of the projects this steward looks after`, { threadId: params.threadId, field: 'target', expected: 'a thread in a project of the grant' });
      }
      const answer = thread.messages.findLast(message => message.role === 'assistant')?.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? null;
      return {
        thread: row(ctx, thread, params.threadId),
        questions: [...ctx.pendingQuestions.values()].map(entry => entry.request).filter(request => request.threadId === thread.id),
        permissions: [...ctx.pendingPermissions.values()].map(entry => entry.request).filter(request => request.threadId === thread.id),
        lastAnswer: answer === null ? null : answer.slice(0, 4_000),
      };
    },
    'steward.act': async (params) => {
      const method = 'steward.act';
      if (!Object.hasOwn(ACTION_CAPABILITY, params.action)) throw invalid(`${method}.action: expected one of ${Object.keys(ACTION_CAPABILITY).join(', ')}`);
      const { grant, thread } = target(ctx, params.threadId, params.target, method, ACTION_CAPABILITY[params.action]);
      const steward = ctx.thread(params.threadId);
      const by = `the steward "${steward.title}" (${steward.id})`;
      if (thread.parentThreadId && params.action !== 'stop') {
        throw refused(`${method}: ${thread.id} is a delegated agent; act on its parent ${thread.parentThreadId}`, { threadId: params.threadId, field: 'target', expected: 'a top-level thread' });
      }
      const all = methods();
      switch (params.action) {
        case 'archive':
        case 'unarchive':
          await all['threads.archive']({ threadId: thread.id, archived: params.action === 'archive' });
          line(ctx, thread, `${params.action === 'archive' ? 'Archived' : 'Unarchived'} by ${by}.`);
          break;
        case 'remove':
          await all['threads.remove']({ threadId: thread.id });
          return { thread: null };
        case 'stop':
          if ((await all['turns.stop']({ threadId: thread.id })).stopped) line(ctx, thread, `Stopped by ${by}.`);
          break;
        case 'rename': {
          const title = typeof params.title === 'string' ? params.title.trim() : '';
          if (title.length === 0 || title.length > 120) throw invalid(`${method}.title: expected 1 to 120 characters`);
          await all['threads.update']({ threadId: thread.id, title });
          line(ctx, thread, `Renamed "${title}" by ${by}.`);
          break;
        }
        case 'move': {
          const project = ctx.projects.find(entry => entry.id === params.project || entry.name === params.project || entry.path === params.project);
          if (!project) throw ctx.notFound('project', String(params.project));
          if (!covers(ctx, grant, project.id)) throw refused(`${method}.project: ${project.name} is not one of the projects this steward looks after`, { threadId: params.threadId, field: 'project', expected: 'a project of the grant' });
          if (project.id === thread.projectId) throw refused(`${method}.project: ${thread.id} is already in ${project.name}`, { threadId: params.threadId, field: 'project', expected: 'another project' });
          await all['threads.move']({ threadId: thread.id, projectId: project.id });
          line(ctx, thread, `Moved to ${project.name} by ${by}.`);
          break;
        }
      }
      return { thread: row(ctx, ctx.thread(thread.id), params.threadId) };
    },
    'steward.answer': async (params) => {
      const { thread } = target(ctx, params.threadId, params.target, 'steward.answer', 'answer');
      const question = ctx.pendingQuestions.get(params.questionId)?.request;
      if (!question || question.threadId !== thread.id) throw refused(`steward.answer.questionId: ${String(params.questionId)} is not a pending question of ${thread.id}`, { threadId: params.threadId, field: 'questionId', expected: 'a pending question id of the target' });
      const steward = ctx.thread(params.threadId);
      const all = methods();
      if (params.skip === true) await all['questions.skip']({ threadId: thread.id, questionId: question.id });
      else {
        if (!Array.isArray(params.optionIds)) throw invalid('steward.answer.optionIds: expected an array of option ids');
        await all['questions.answer']({ threadId: thread.id, questionId: question.id, optionIds: params.optionIds, ...(params.text === undefined ? {} : { text: params.text }) });
      }
      line(ctx, thread, `${params.skip === true ? 'Question skipped' : 'Question answered'} by the steward "${steward.title}" (${steward.id}), not by the user.`);
      return { ok: true as const };
    },
    'steward.permission': async (params) => {
      const { thread } = target(ctx, params.threadId, params.target, 'steward.permission', 'permissions');
      if (params.decision !== 'allow' && params.decision !== 'deny') throw invalid('steward.permission.decision: expected allow or deny');
      const request = ctx.pendingPermissions.get(params.requestId)?.request;
      if (!request || request.threadId !== thread.id) throw refused(`steward.permission.requestId: ${String(params.requestId)} is not a pending permission of ${thread.id}`, { threadId: params.threadId, field: 'requestId', expected: 'a pending permission request id of the target' });
      const steward = ctx.thread(params.threadId);
      await methods()['permissions.answer']({ requestId: request.id, decision: params.decision });
      line(ctx, thread, `${request.toolName} ${params.decision === 'allow' ? 'allowed' : 'denied'} by the steward "${steward.title}" (${steward.id}), not by the user.`);
      return { ok: true as const };
    },
  } satisfies Partial<FakeMethods>;
}

/**
 * `?fake=1&steward=1`: the first thread of the first project looks after its
 * project, has steered a sibling and heard back from it, and that sibling was
 * started by the steward's agent. Captures of the steward views need no clicks.
 */
export function seedStewardDemo(ctx: FakeContext): void {
  const project = ctx.projects.find(entry => entry.kind !== 'drafts' && !entry.archived);
  const threads = [...ctx.threads.values()].filter(thread => thread.projectId === project?.id && !thread.archived && !thread.parentThreadId && !thread.agentSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const [steward, target] = threads;
  if (!project || !steward || !target) return;
  const now = ctx.now();
  ctx.stewards.set(steward.id, {
    threadId: steward.id, projectIds: [project.id], allProjects: false, capabilities: ['message', 'spawn', 'archive', 'move', 'stop', 'answer'],
    notify: true, grantedAt: now - 3_600_000, updatedAt: now - 3_600_000,
  });
  const prompt = target.messages.find(message => message.role === 'user');
  const part = prompt?.parts.find(entry => entry.type === 'text');
  if (part?.type === 'text') part.startedBy = { threadId: steward.id, title: steward.title, projectId: project.id, project: project.name };
  const self = { coreId: ctx.identity.coreId, machine: ctx.identity.name, project: project.name };
  const letter = (id: string, origin: AgentLetter['origin'], from: Thread, to: Thread, text: string, at: number): AgentLetter => ({
    origin, id, from: { ...self, threadId: from.id, title: from.title, resources: '', status: from.status, mode: 'off' }, to: { coreId: ctx.identity.coreId, threadId: to.id }, toTitle: to.title,
    toProject: project.name, toMachine: ctx.identity.name, text, replyTo: null, createdAt: at, expiresAt: at + 86_400_000, status: 'delivered', error: null,
  });
  const steer = letter('steward-demo-steer', 'steward', steward, target,
    'The CI run failed on the lint step. Fix the import order in store.svelte.ts, run bun run check, then push.', (target.messages.at(-1)?.createdAt ?? now) + 60_000);
  const notice = letter('steward-demo-notice', 'notice', target, steward,
    `Turn done in "${target.title}" (${target.id}).\nLint fixed, bun run check passes and the branch is pushed.`, steer.createdAt + 120_000);
  ctx.letters.set(target.id, [...(ctx.letters.get(target.id) ?? []), steer]);
  ctx.letters.set(steward.id, [...(ctx.letters.get(steward.id) ?? []), steer, notice]);
}
