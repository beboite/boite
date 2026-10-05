/**
 * Stewards: the owner hands the agent of one thread the projects it looks
 * after while they are away. It reads every thread there, steers them with
 * letters marked as the steward's, answers what they ask, starts, moves,
 * stops, renames and archives them, and with explicit capabilities answers
 * permissions and deletes. The core tells it what happens in those threads
 * with notices that wake it.
 *
 * A grant lives in the settings table under `steward:<threadId>`. Every
 * steward method carries the steward's own thread as `threadId`, so the access
 * gate already held the token to it; the grant is checked here, against the
 * project of the thread the call names, at the moment of the call.
 */
import { STEWARD_CAPABILITIES } from '@boite/contracts';
import type {
  AgentLetter, Message, MessagePart, ProjectId, QuestionRequest, PermissionRequest, RpcParams, StewardAction, StewardCapability, StewardGrant,
  StewardGrantInput, StewardThread, StewardThreadDetail, StewardView, ThreadId, ThreadSummary, Turn,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused } from './errors.ts';
import { newId } from './ids.ts';

const KEY = 'steward:';
const HOUR = 3_600_000;
/** Notices one steward receives in a rolling hour before the core drops the rest and says so in the log. */
export const NOTICES_PER_HOUR = 60;
const NOTICE_TEXT = 1_500;

const ACTION_CAPABILITY: Record<StewardAction, StewardCapability> = {
  archive: 'archive', unarchive: 'archive', remove: 'remove', stop: 'stop', rename: 'stop', move: 'move',
};

function trimmed(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 20)}\n[Truncated.]` : flat;
}

export class Stewards {
  private readonly off: () => void;
  private closed = false;

  constructor(private readonly core: Core) {
    this.off = core.bus.onAny((name, payload) => {
      if (this.closed || core.journal.isClosed()) return;
      try {
        if (name === 'turn.finished') this.noticeTurn(payload as Turn);
        else if (name === 'question.asked') this.noticeQuestion(payload as QuestionRequest);
        else if (name === 'permission.requested') this.noticePermission(payload as PermissionRequest);
        else if (name === 'thread.removed') this.forgetRemoved((payload as { threadId: ThreadId }).threadId);
      } catch (error) {
        core.log('warn', `steward notice after ${name}: ${messageOf(error)}`);
      }
    });
  }

  close(): void { this.closed = true; this.off(); }

  // -- grants -----------------------------------------------------------------

  list(): StewardGrant[] {
    const rows = this.core.journal.db.query("SELECT value FROM settings WHERE key LIKE 'steward:%' ORDER BY key").all() as { value: string }[];
    const grants: StewardGrant[] = [];
    for (const row of rows) {
      try {
        const grant = JSON.parse(row.value) as StewardGrant;
        if (this.core.journal.getThread(grant.threadId) !== null) grants.push(grant);
      } catch { /* A broken row is skipped; set replaces it. */ }
    }
    return grants;
  }

  /** The grant of a thread that can still act on it: unarchived and present. */
  grantOf(threadId: ThreadId): StewardGrant | null {
    const grant = this.core.journal.getSetting(`${KEY}${threadId}`) as StewardGrant | undefined;
    if (grant === undefined) return null;
    const thread = this.core.journal.getThread(threadId);
    return thread === null || thread.archived ? null : grant;
  }

  set(input: StewardGrantInput): StewardGrant {
    if (!input || typeof input !== 'object') throw invalidParams('grant: expected threadId, projectIds, allProjects, capabilities and notify');
    const thread = this.core.threads.require(input.threadId);
    const context = { threadId: thread.id };
    if (thread.agentSessionId || thread.projectId === null) throw refused('grant.threadId: a persistent agent session cannot be a steward', { ...context, field: 'grant.threadId', expected: 'a conversation thread' });
    if (thread.parentThreadId) throw refused('grant.threadId: a delegated agent or workflow step cannot be a steward', { ...context, field: 'grant.threadId', expected: 'a top-level thread' });
    if (thread.archived) throw refused('grant.threadId: an archived thread cannot be a steward', { ...context, field: 'grant.threadId', expected: 'a thread that is not archived' });
    if (typeof input.allProjects !== 'boolean') throw invalidParams('grant.allProjects: expected true or false');
    if (typeof input.notify !== 'boolean') throw invalidParams('grant.notify: expected true or false');
    if (!Array.isArray(input.projectIds) || input.projectIds.length > 500) throw invalidParams('grant.projectIds: expected an array of at most 500 project ids');
    const projectIds = [...new Set(input.projectIds)];
    for (const projectId of projectIds) {
      if (typeof projectId !== 'string' || this.core.journal.getProject(projectId) === null) {
        throw refused(`grant.projectIds: unknown project ${String(projectId)}`, { ...context, field: 'grant.projectIds', expected: 'ids of projects added to Boite' });
      }
    }
    if (!input.allProjects && projectIds.length === 0) throw invalidParams('grant.projectIds: expected at least one project, or allProjects true');
    if (!Array.isArray(input.capabilities)) throw invalidParams(`grant.capabilities: expected an array of ${STEWARD_CAPABILITIES.join(', ')}`);
    for (const capability of input.capabilities) {
      if (!STEWARD_CAPABILITIES.includes(capability)) throw invalidParams(`grant.capabilities: unknown capability ${String(capability)}; expected ${STEWARD_CAPABILITIES.join(', ')}`);
    }
    const capabilities = STEWARD_CAPABILITIES.filter(capability => input.capabilities.includes(capability));
    const previous = this.core.journal.getSetting(`${KEY}${thread.id}`) as StewardGrant | undefined;
    const now = Date.now();
    const grant: StewardGrant = {
      threadId: thread.id, projectIds: input.allProjects ? [] : projectIds, allProjects: input.allProjects, capabilities, notify: input.notify,
      grantedAt: previous?.grantedAt ?? now, updatedAt: now,
    };
    this.core.journal.setSetting(`${KEY}${thread.id}`, grant);
    this.core.bus.emit('stewards.changed', { threadId: thread.id });
    return grant;
  }

  revoke(threadId: ThreadId): { ok: true } {
    if (typeof threadId !== 'string' || threadId.length === 0) throw invalidParams('threadId: expected a thread id');
    this.core.journal.deleteSetting(`${KEY}${threadId}`);
    this.core.coordination.stewardRevoked(threadId);
    this.core.bus.emit('stewards.changed', { threadId });
    return { ok: true };
  }

  private forgetRemoved(threadId: ThreadId): void {
    if (this.core.journal.getSetting(`${KEY}${threadId}`) === undefined || this.core.journal.getThread(threadId) !== null) return;
    this.core.journal.deleteSetting(`${KEY}${threadId}`);
    this.core.bus.emit('stewards.changed', { threadId });
  }

  covers(grant: StewardGrant, projectId: ProjectId | null): boolean {
    if (projectId === null) return false;
    const project = this.core.journal.getProject(projectId);
    if (project === null) return false;
    // Every project leaves the drafts out: those conversations are the user's scratch space.
    return grant.allProjects ? project.kind !== 'drafts' : grant.projectIds.includes(projectId);
  }

  /**
   * The grant under which `stewardId` may touch `targetId`, or null. Used by
   * coordination to mark letters and by the spawn gates; never throws.
   */
  over(stewardId: ThreadId, targetId: ThreadId, capability?: StewardCapability): StewardGrant | null {
    if (stewardId === targetId) return null;
    const grant = this.grantOf(stewardId);
    if (grant === null) return null;
    if (capability !== undefined && !grant.capabilities.includes(capability)) return null;
    const target = this.core.journal.getThread(targetId);
    if (target === null || target.agentSessionId) return null;
    return this.covers(grant, target.projectId) ? grant : null;
  }

  /**
   * Between two local threads: whether the first writes as the steward of the
   * second, and whether it writes to a steward that looks after it. Both pass
   * communication settings and wait longer.
   */
  between(local: boolean, fromId: string, toId: string): { asSteward: boolean; toSteward: boolean } {
    if (!local || typeof fromId !== 'string' || typeof toId !== 'string') return { asSteward: false, toSteward: false };
    return { asSteward: this.over(fromId, toId, 'message') !== null, toSteward: this.over(toId, fromId) !== null };
  }

  /**
   * Whether a letter with a steward behind it may reach its thread now, or null
   * when no steward is involved and the ordinary coordination rules decide.
   * A steward's letter holds while its grant covers the thread, whatever that
   * thread's own settings say; notices and letters from its threads reach a
   * steward unless the owner paused it.
   */
  mayReceive(letter: AgentLetter, local: boolean, recipientPaused: boolean): boolean | null {
    if (letter.origin === 'steward') return local && this.over(letter.from.threadId, letter.to.threadId, 'message') !== null;
    if (letter.origin === 'notice') return this.grantOf(letter.to.threadId)?.notify === true && !recipientPaused;
    if (local && this.over(letter.to.threadId, letter.from.threadId) !== null) return !recipientPaused;
    return null;
  }

  /** Notices a steward received in the last hour. */
  noticesThisHour(stewardId: ThreadId): number {
    return (this.core.journal.db.query("SELECT count(*) AS n FROM coordination_letters WHERE thread_id = ? AND direction = 'in' AND created_at > ? AND json_extract(data, '$.origin') = 'notice'").get(stewardId, Date.now() - HOUR) as { n: number }).n;
  }

  /** The grant, or a refusal naming what is missing. */
  private require(threadId: ThreadId, method: string): StewardGrant {
    const grant = this.grantOf(threadId);
    if (grant === null) {
      throw refused(`${method}: this thread is not a steward; the owner assigns projects to it in Communication settings`, { threadId, field: 'threadId', expected: 'a thread the owner made a steward' });
    }
    return grant;
  }

  /** The target thread, held to the steward's projects and, when given, a capability. */
  private target(threadId: ThreadId, targetId: unknown, method: string, capability?: StewardCapability): { grant: StewardGrant; target: ThreadSummary } {
    const grant = this.require(threadId, method);
    if (typeof targetId !== 'string' || targetId.length === 0) throw invalidParams(`${method}.target: expected a thread id`);
    if (targetId === threadId) throw refused(`${method}.target: a steward does not act on its own thread`, { threadId, field: 'target', expected: 'another thread' });
    const target = this.core.journal.getThread(targetId);
    if (target === null || target.agentSessionId || !this.covers(grant, target.projectId)) {
      throw refused(`${method}.target: ${targetId} is not a thread of the projects this steward looks after`, { threadId, field: 'target', target: targetId, expected: 'a thread in a project of the grant' });
    }
    if (capability !== undefined && !grant.capabilities.includes(capability)) {
      throw refused(`${method}: the owner did not give this steward the ${capability} capability`, { threadId, field: 'capability', expected: capability });
    }
    return { grant, target };
  }

  // -- agent methods ----------------------------------------------------------

  view(threadId: ThreadId): StewardView {
    const grant = this.grantOf(threadId);
    const projects = grant === null ? [] : this.core.journal.listProjects()
      .filter(project => project.archived !== true && this.covers(grant, project.id))
      .map(project => ({ id: project.id, name: project.name, path: project.path }));
    return { grant, projects };
  }

  threads(params: RpcParams<'steward.threads'>): StewardThread[] {
    const grant = this.require(params.threadId, 'steward.threads');
    let projectId: ProjectId | undefined;
    if (params.project !== undefined) {
      projectId = this.core.projects.find(params.project, 'steward.threads', 'project', { threadId: params.threadId }).id;
      if (!this.covers(grant, projectId)) throw refused(`steward.threads.project: ${params.project} is not one of the projects this steward looks after`, { threadId: params.threadId, field: 'project', expected: 'a project of the grant' });
    }
    const archived = params.archived === true;
    return this.core.journal.listThreads(projectId)
      .filter(thread => !thread.agentSessionId && !thread.parentThreadId && thread.archived === archived && this.covers(grant, thread.projectId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map(thread => this.row(thread, params.threadId));
  }

  detail(params: RpcParams<'steward.thread'>): StewardThreadDetail {
    const grant = this.require(params.threadId, 'steward.thread');
    const target = this.core.journal.getThread(params.target);
    if (target === null || target.agentSessionId || !this.covers(grant, target.projectId)) {
      throw refused(`steward.thread.target: ${String(params.target)} is not a thread of the projects this steward looks after`, { threadId: params.threadId, field: 'target', expected: 'a thread in a project of the grant' });
    }
    const last = this.core.journal.listTurns(target.id).findLast(turn => turn.status !== 'queued' && turn.status !== 'running') ?? null;
    return {
      thread: this.row(target, params.threadId),
      questions: this.core.threads.listQuestions(target.id),
      permissions: this.core.threads.listPermissions(target.id),
      lastAnswer: this.core.delegation.result(last),
    };
  }

  async act(params: RpcParams<'steward.act'>): Promise<{ thread: StewardThread | null }> {
    const method = 'steward.act';
    const action = params.action;
    if (!Object.hasOwn(ACTION_CAPABILITY, action)) throw invalidParams(`${method}.action: expected one of ${Object.keys(ACTION_CAPABILITY).join(', ')}`);
    const { grant, target } = this.target(params.threadId, params.target, method, ACTION_CAPABILITY[action]);
    const steward = this.core.threads.require(params.threadId);
    const by = `the steward "${steward.title}" (${steward.id})`;
    if (target.parentThreadId && action !== 'stop') {
      throw refused(`${method}: ${target.id} is a delegated agent; act on its parent ${target.parentThreadId}`, { threadId: params.threadId, field: 'target', expected: 'a top-level thread' });
    }
    switch (action) {
      case 'archive':
      case 'unarchive':
        this.core.threads.archive(target.id, action === 'archive');
        this.line(target.id, `${action === 'archive' ? 'Archived' : 'Unarchived'} by ${by}.`);
        break;
      case 'remove':
        // Written first, so a restored thread still says which steward deleted it.
        this.line(target.id, `Deleted by ${by}.`);
        await this.core.threads.remove(target.id);
        return { thread: null };
      case 'stop':
        this.core.activity.pauseAll(target.id);
        if (this.core.threads.stopTurn(target.id)) this.line(target.id, `Stopped by ${by}.`);
        break;
      case 'rename': {
        const title = typeof params.title === 'string' ? params.title.trim() : '';
        if (title.length === 0 || title.length > 120) throw invalidParams(`${method}.title: expected 1 to 120 characters`);
        this.core.threads.update({ threadId: target.id, title });
        this.line(target.id, `Renamed "${title}" by ${by}.`);
        break;
      }
      case 'move': {
        const project = this.core.projects.find(params.project, method, 'project', { threadId: params.threadId });
        if (!this.covers(grant, project.id)) throw refused(`${method}.project: ${project.name} is not one of the projects this steward looks after`, { threadId: params.threadId, field: 'project', expected: 'a project of the grant' });
        if (project.id === target.projectId) throw refused(`${method}.project: ${target.id} is already in ${project.name}`, { threadId: params.threadId, field: 'project', expected: 'another project' });
        await this.core.threads.move(target.id, project.id);
        this.line(target.id, `Moved to ${project.name} by ${by}.`);
        break;
      }
    }
    return { thread: this.row(this.core.threads.require(target.id), params.threadId) };
  }

  answer(params: RpcParams<'steward.answer'>): { ok: true } {
    const { target } = this.target(params.threadId, params.target, 'steward.answer', 'answer');
    const question = this.core.threads.listQuestions(target.id).find(request => request.id === params.questionId);
    if (question === undefined) throw refused(`steward.answer.questionId: ${String(params.questionId)} is not a pending question of ${target.id}`, { threadId: params.threadId, field: 'questionId', expected: 'a pending question id of the target' });
    const steward = this.core.threads.require(params.threadId);
    if (params.skip === true) this.core.threads.skipQuestion({ threadId: target.id, questionId: question.id });
    else {
      if (!Array.isArray(params.optionIds)) throw invalidParams('steward.answer.optionIds: expected an array of option ids');
      this.core.threads.answerQuestion({ threadId: target.id, questionId: question.id, optionIds: params.optionIds, ...(params.text === undefined ? {} : { text: params.text }) });
    }
    this.line(target.id, `${params.skip === true ? 'Question skipped' : 'Question answered'} by the steward "${steward.title}" (${steward.id}), not by the user.`);
    return { ok: true };
  }

  permission(params: RpcParams<'steward.permission'>): { ok: true } {
    const { target } = this.target(params.threadId, params.target, 'steward.permission', 'permissions');
    if (params.decision !== 'allow' && params.decision !== 'deny') throw invalidParams('steward.permission.decision: expected allow or deny');
    const request = this.core.threads.listPermissions(target.id).find(pending => pending.id === params.requestId);
    if (request === undefined) throw refused(`steward.permission.requestId: ${String(params.requestId)} is not a pending permission of ${target.id}`, { threadId: params.threadId, field: 'requestId', expected: 'a pending permission request id of the target' });
    const steward = this.core.threads.require(params.threadId);
    this.core.threads.answerPermission({ requestId: request.id, decision: params.decision });
    this.line(target.id, `${request.toolName} ${params.decision === 'allow' ? 'allowed' : 'denied'} by the steward "${steward.title}" (${steward.id}), not by the user.`);
    return { ok: true };
  }

  /** A project the steward registered joins its grant, so it can work there at once. */
  adopt(threadId: ThreadId, projectId: ProjectId): void {
    const grant = this.grantOf(threadId);
    if (grant === null || grant.allProjects || grant.projectIds.includes(projectId)) return;
    const next: StewardGrant = { ...grant, projectIds: [...grant.projectIds, projectId], updatedAt: Date.now() };
    this.core.journal.setSetting(`${KEY}${threadId}`, next);
    this.core.bus.emit('stewards.changed', { threadId });
  }

  /** What a steward's prompt says about its role, or nothing. */
  instructions(threadId: ThreadId): string {
    const grant = this.grantOf(threadId);
    if (grant === null) return '';
    const projects = grant.allProjects ? 'every project' : this.view(threadId).projects.map(project => project.name).join(', ');
    return `\nBoite steward: the user made you the steward of ${projects}; capabilities: ${grant.capabilities.join(', ') || 'read only'}. \`boite threads [--project <p>] [--archived]\`; \`boite thread show <id>\`; \`boite thread send <id> <text>\` (reaches it as the steward's message, not the user's); \`boite thread archive|unarchive|stop|remove <id>\`; \`boite thread rename <id> <title>\`; \`boite thread move <project> <id>\`; \`boite thread new <project> <brief>\`; \`boite answer <id> <question-id> <option-or-text...>\`; \`boite allow|deny <id> <request-id>\`.${grant.notify ? ' Notices from Boite tell you when a thread finishes, fails, asks or waits.' : ''} You act for the user while they are away: keep each thread moving toward a merged, verified result; never invent the user's approval.\n`;
  }

  // -- notices ----------------------------------------------------------------

  private stewardsOf(thread: ThreadSummary): StewardGrant[] {
    if (thread.agentSessionId || thread.parentThreadId || thread.projectId === null) return [];
    return this.list().filter(grant => grant.notify && grant.threadId !== thread.id && this.grantOf(grant.threadId) !== null && this.covers(grant, thread.projectId));
  }

  private notify(thread: ThreadSummary, key: string, text: string, skip: ThreadId | null = null): void {
    for (const grant of this.stewardsOf(thread)) {
      if (grant.threadId === skip) continue;
      if (this.noticesThisHour(grant.threadId) >= NOTICES_PER_HOUR) {
        this.core.log('warn', `steward ${grant.threadId}: more than ${NOTICES_PER_HOUR} notices this hour; dropped ${key}`);
        continue;
      }
      this.core.coordination.notice(grant.threadId, thread.id, trimmed(text, NOTICE_TEXT + 500), `${key}:${grant.threadId}`);
    }
  }

  private noticeTurn(turn: Turn): void {
    if (turn.status === 'queued' || turn.status === 'running') return;
    const thread = this.core.journal.getThread(turn.threadId);
    if (thread === null || thread.archived) return;
    const answer = this.core.delegation.result(turn);
    const pr = thread.pullRequest ? `\nPull request #${thread.pullRequest.number} ${thread.pullRequest.state}: ${thread.pullRequest.url}` : '';
    // The first answer of a thread a steward started already goes back to it as a letter.
    const starter = this.core.journal.listTurns(thread.id).length === 1 ? this.core.threads.spawns.originOf(thread.id)?.threadId ?? null : null;
    this.notify(thread, `notice:turn:${turn.id}`, `Turn ${turn.status} in "${thread.title}" (${thread.id}).${pr}\n${answer === null ? 'No text answer.' : trimmed(answer, NOTICE_TEXT)}`, starter);
  }

  private noticeQuestion(question: QuestionRequest): void {
    const thread = this.core.journal.getThread(question.threadId);
    if (thread === null || thread.archived) return;
    const options = question.options.length ? `\nOptions: ${question.options.map(option => `${option.id}=${option.label}`).join('; ')}` : '';
    this.notify(thread, `notice:question:${question.id}`, `"${thread.title}" (${thread.id}) asks the user, question ${question.id}:\n${trimmed(question.text, NOTICE_TEXT)}${options}`);
  }

  private noticePermission(request: PermissionRequest): void {
    const thread = this.core.journal.getThread(request.threadId);
    if (thread === null || thread.archived) return;
    this.notify(thread, `notice:permission:${request.id}`, `"${thread.title}" (${thread.id}) waits on permission ${request.id} for ${request.toolName}${request.description ? `: ${trimmed(request.description, 600)}` : ''}.`);
  }

  // -- helpers ----------------------------------------------------------------

  private row(thread: ThreadSummary, stewardId: ThreadId): StewardThread {
    const project = thread.projectId === null ? null : this.core.journal.getProject(thread.projectId);
    return {
      id: thread.id, title: thread.title, projectId: thread.projectId, project: project?.name ?? null,
      status: thread.status, archived: thread.archived, branch: thread.branch, self: thread.id === stewardId,
      questions: this.core.threads.listQuestions(thread.id).length,
      permissions: this.core.threads.listPermissions(thread.id).length,
      pullRequest: thread.pullRequest ?? null,
      updatedAt: thread.updatedAt, lastCompletedAt: this.core.journal.lastCompletedAt(thread.id),
    };
  }

  /** A system line in the target's timeline, on its last turn, saying what the steward did. */
  private line(threadId: ThreadId, text: string): void {
    const turnId = this.core.journal.listTurns(threadId).at(-1)?.id ?? newId('trn_');
    const part: MessagePart = { type: 'text', text };
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'system', parts: [part], state: 'complete', createdAt: Date.now() };
    this.core.journal.append({ type: 'thread.steward', threadId, version: 1, payload: message }, () => this.core.journal.putMessage(message));
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
  }
}

export function registerStewardMethods(core: Core): void {
  core.router.register('stewards.list', () => core.stewards.list());
  core.router.register('stewards.set', params => core.stewards.set(params.grant));
  core.router.register('stewards.revoke', params => core.stewards.revoke(params.threadId));
  core.router.register('steward.get', params => core.stewards.view(params.threadId));
  core.router.register('steward.threads', params => core.stewards.threads(params));
  core.router.register('steward.thread', params => core.stewards.detail(params));
  core.router.register('steward.act', params => core.stewards.act(params));
  core.router.register('steward.answer', params => core.stewards.answer(params));
  core.router.register('steward.permission', params => core.stewards.permission(params));
}
