import { createHash, randomUUID } from 'node:crypto';
import { CONVERSATION_PROFILE_ID, DEFAULT_DELEGATION_CONFIG, delegationAnswerable as answerable, delegationNeeds as needsOf, delegationReply, nativeAgentsOfTool, processAgentCommand, SPEED_NEEDS_MODEL, threadBusy, type RpcEvents } from '@boite/contracts';
import type { AgentLetter, BackgroundWait, DelegatedAgent, DelegationConfig, DelegationModels, DelegationResumed, DelegationView, PauseOrigin, PermissionMode, PermissionRequest, Principal, QuestionRequest, RequestId, RpcParams, ThreadContextMode, ThreadSummary, Turn, Usage } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused, requiredText as text } from './errors.ts';
import { isAgentHeld } from './agents/runtime.ts';
import { checkContext } from './context-mode.ts';
import { checkSavedSelection, checkSpeed } from './threads/selection.ts';
import { anyModel, catalog, conversationRoute, discover, providersNamed, resolveRoute, type ChildRoute, type RouteRequest } from './delegation/routes.ts';
import type { ProviderProbe } from './providers/probe.ts';
import { newId } from './ids.ts';
import { assertDriverRunnable } from './drivers/index.ts';
import { withLoad } from './threads/records.ts';
import { nativeAgents } from './native-agents.ts';
import { delegatedResultPage, DelegationWaits } from './delegation/results.ts';
import { INTERRUPTION_TEXT } from './delegation/interruption.ts';
import { permissionWake, questionWake, worktreeLine } from './delegation/messages.ts';
import { ChildWorktrees } from './delegation/worktrees.ts';
import { childProject } from './delegation/projects.ts';
import { Retirements } from './delegation/retirement.ts';
import { pauseHold, pauseOver } from './delegation/pauses.ts';
import { dropRestartCuts, recordRestartCut, resumeRestartCuts } from './delegation/restart.ts';
import { DELEGATION_WORDS, delegationPrompt, subagentGuide } from './delegation/guide.ts';
import type { Connection } from './router.ts';

interface AgentRow { thread_id: string; root_id: string; request_id: string; fingerprint: string; profile_id: string; task: string }
interface LetterRow { data: string; fingerprint: string }
/** A permission the user answers within this time, watching the child, does not wake its parent. */
export const PERMISSION_WAKE_MS = 30_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Load and the derived live fields arrive in thread.updated without changing team history. */
function teamState(thread: ThreadSummary): string {
  const { load, progress, runningSince, requestSince, backgroundWork, backgroundWait, pendingMove, moveNote, pendingAnswers, openQuestions, retry, pullRequestWatches, ...stored } = thread;
  return JSON.stringify(Object.fromEntries(Object.entries(stored).sort(([left], [right]) => left.localeCompare(right))));
}
/** A family of ordinary threads. No extra orchestrator model or provider process. */
export class Delegation {
  readonly waits: DelegationWaits;
  readonly worktrees: ChildWorktrees;
  readonly retirements: Retirements;
  private closed = false;
  private readonly delivering = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly stopped = new Set<string>();
  private readonly summaries = new Map<string, string>();
  private readonly pendingChanges = new Set<string>();
  private readonly nativeActive = new Set<string>();
  /** Delegated agents whose background work just ended: when a wake that has not come stops being expected. */
  private readonly wakeDeadlines = new Map<string, number>();
  /** Permission requests of delegated agents, by id: when their parent hears of one still open. */
  private readonly permissionWakes = new Map<RequestId, { threadId: string; at: number }>();
  private readonly off: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly core: Core) {
    this.worktrees = new ChildWorktrees(core, threadId => {
      const thread = this.core.journal.getThread(threadId);
      if (thread?.parentThreadId) this.changed(thread.parentThreadId);
    });
    this.waits = new DelegationWaits(core, threadId => this.rows(threadId).map(row => this.member(row)), threadId => this.worktrees.isSettling(threadId));
    this.retirements = new Retirements(core, thread => this.busy(thread) || this.worktrees.isSettling(thread.id), threadId => this.lastTurn(threadId));
    // A core that died preserves relationships/results, but restarts no paid work: a team
    // with mail still to deliver or a child turn cut short waits until its agent or its
    // owner resumes it. A team with nothing pending has nothing to restart and stays usable.
    // A handoff stopped its children on purpose: they resume once the server listens. One this
    // core does not carry on (older than an hour, unreadable) leaves their teams held like a crash.
    const pending = core.threads.handoff.handedOver ? new Set<string>() : new Set([...(core.journal.db.query(`SELECT root_id FROM delegation_messages WHERE status = 'received'
      UNION SELECT a.root_id FROM delegated_agents a JOIN turns t ON t.thread_id = a.thread_id WHERE t.status IN ('queued', 'running')`).all() as { root_id: string }[]).map(row => row.root_id), ...dropRestartCuts(core)]);
    // Only children carry a team summary, and only pending roots get paused: the other threads are not read.
    for (const thread of core.journal.listChildThreads()) this.summaries.set(thread.id, teamState(thread));
    for (const thread of core.journal.listThreadsIn(pending)) {
      if (thread.parentThreadId) continue;
      const config = this.config(thread.id);
      if (config.enabled && !config.paused) this.pause(thread.id, 'restart');
    }
    this.off = core.bus.onCommitted((name, payload) => {
      if (this.closed) return;
      if (name === 'thread.background') {
        const threadId = (payload as RpcEvents['thread.background']).threadId;
        this.core.bus.emit('delegation.changed', { threadId });
        this.backgroundChanged(threadId);
      }
      if (name === 'process.started' || name === 'process.exited') {
        const record = payload as RpcEvents['process.started'];
        if (record.parentPid !== process.pid && processAgentCommand(record)) this.core.bus.emit('delegation.changed', { threadId: record.threadId });
      }
      if (name === 'message.part') {
        const event = payload as RpcEvents['message.part'];
        if (nativeAgentsOfTool(event.part).length) {
          this.nativeActive.add(event.threadId);
          this.core.bus.emit('delegation.changed', { threadId: event.threadId });
        }
      }
      if (name === 'turn.finished') {
        const threadId = (payload as Turn).threadId;
        if (this.nativeActive.delete(threadId)) this.core.bus.emit('delegation.changed', { threadId });
        this.finished(payload as Turn);
        // A thread that yields takes the letters that waited for it now, not at the next tick.
        this.kick((payload as Turn).threadId);
      }
      if (name === 'thread.created' || name === 'thread.updated') {
        const thread = payload as ThreadSummary;
        if (thread.parentThreadId) {
          const state = teamState(thread);
          const previous = this.summaries.get(thread.id);
          this.summaries.set(thread.id, state);
          if (name === 'thread.updated') { if (previous !== state) this.changed(thread.parentThreadId); this.retirements.check(thread.id); }
        }
      }
      if (name === 'workflows.changed') this.retirements.runChanged(payload as RpcEvents['workflows.changed']);
      if (name === 'thread.removed' && !(payload as { undoable?: boolean }).undoable) this.remove((payload as { threadId: string }).threadId);
      if (name === 'question.asked') this.asked(payload as QuestionRequest);
      if (name === 'permission.requested') this.permissionAsked(payload as PermissionRequest);
      if (name === 'question.answered') {
        const event = payload as RpcEvents['question.answered'];
        this.cardClosed(event.threadId, event.questionId);
      }
      if (name === 'permission.resolved') {
        const event = payload as RpcEvents['permission.resolved'];
        this.permissionWakes.delete(event.requestId);
        this.cardClosed(event.threadId, event.requestId);
      }
    });
    // The tick remains for expiry and a steer a driver was not ready for.
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  private track(job: Promise<void>): void {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }
  /** Delivery to one thread once the current synchronous work (a journal write, a turn end) is done. */
  private kick(threadId: string): void {
    queueMicrotask(() => {
      if (!this.live()) return;
      this.track(this.deliver(threadId).catch(error => { if (this.live()) this.core.log('warn', `delegation ${threadId}: ${messageOf(error)}`); }));
    });
  }
  /**
   * Shutdown closes this module before the journal, but a crash, or a test
   * simulating one, can close the journal under a timer or a queued callback:
   * those return quietly instead of throwing on the closed database.
   */
  private live(): boolean {
    return !this.closed && !this.core.journal.isClosed();
  }

  private root(threadId: string): ThreadSummary {
    const thread = this.core.threads.require(threadId);
    return thread.parentThreadId ? this.core.threads.require(thread.parentThreadId) : thread;
  }
  config(rootId: string): DelegationConfig {
    const saved = this.core.journal.getSetting(`delegation:${rootId}`) as DelegationConfig | undefined;
    if (!saved) return structuredClone(DEFAULT_DELEGATION_CONFIG);
    const pause = saved.paused && saved.pausedBy ? { pausedBy: saved.pausedBy, ...(saved.pausedAt === undefined ? {} : { pausedAt: saved.pausedAt }) } : {};
    return { enabled: saved.enabled, paused: saved.paused, ...pause, profiles: saved.profiles, anyModel: saved.anyModel !== false };
  }
  /** Pauses the team, keeping a stricter pause it already holds. */
  private pause(rootId: string, by: PauseOrigin, at = Date.now()): void {
    const config = this.config(rootId);
    const pause = pauseOver(config.paused ? { by: config.pausedBy, at: config.pausedAt } : null, by, at);
    this.saveConfig(rootId, { ...config, paused: true, pausedBy: pause.by, pausedAt: pause.at });
  }
  /** Why the conversation's agent may not lift the team's pause, or null. */
  private hold(rootId: string, config = this.config(rootId)): string | null {
    return config.paused ? pauseHold(this.core, rootId, { by: config.pausedBy, at: config.pausedAt }, 'team') : null;
  }
  private used(rootId: string): number { return (this.core.journal.getSetting(`delegation-turns:${rootId}`) as number | undefined) ?? 0; }
  /** A fresh user request or routine gets fresh delegation usage counters. Results keep their episode. */
  beginEpisode(rootId: string, episodeId: string, config: DelegationConfig): boolean {
    if (this.core.journal.getSetting(`delegation-episode:${rootId}`) === episodeId) return true;
    const children = this.rows(rootId).map(row => this.core.threads.require(row.thread_id));
    if (children.some(t => this.busy(t)) || this.inbox(rootId).length) return false;
    this.core.journal.db.transaction(() => {
      for (const child of children.filter(t => !t.archived)) this.retirements.begin(child, episodeId);
      this.core.journal.setSetting(`delegation-episode:${rootId}`, episodeId);
      this.core.journal.setSetting(`delegation-turns:${rootId}`, 0);
      this.saveConfig(rootId, config);
    })();
    return true;
  }
  private rows(rootId: string): AgentRow[] { return this.core.journal.db.query('SELECT * FROM delegated_agents WHERE root_id = ? ORDER BY rowid').all(rootId) as AgentRow[]; }
  private lastTurn(threadId: string): Turn | null {
    const row = this.core.journal.db.query("SELECT id FROM turns WHERE thread_id = ? AND COALESCE(json_extract(execution, '$.operation'), '') NOT IN ('compact', 'keepalive') ORDER BY rowid DESC LIMIT 1").get(threadId) as { id: string } | null;
    return row ? this.core.journal.getTurn(row.id) : null;
  }
  /** The bounded final answer of a finished turn, or its error. */
  result(turn: Turn | null): string | null {
    if (!turn || turn.status === 'queued' || turn.status === 'running') return null;
    const rows = this.core.journal.db.query(`SELECT substr((SELECT group_concat(substr(json_extract(value, '$.text'), 1, 4001), char(10))
      FROM json_each(messages.parts) WHERE json_extract(value, '$.type') = 'text'), 1, 4001) AS answer
      FROM messages WHERE thread_id = ? AND turn_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 8`).all(turn.threadId, turn.id) as { answer: string | null }[];
    for (const row of rows) {
      const answer = row.answer?.trim();
      if (answer) return answer.length > 4000 ? `${answer.slice(0, 3900)}\n[Truncated. Open the agent conversation for the complete answer.]` : answer;
    }
    return turn.error ?? null;
  }
  private member(row: AgentRow): DelegatedAgent {
    const lastTurn = this.lastTurn(row.thread_id);
    const thread = withLoad(this.core, this.core.threads.require(row.thread_id));
    const terminal = lastTurn !== null && !['queued', 'running'].includes(lastTurn.status);
    // A turn ended to wait on background work left a checkpoint, not a result: none is available
    // while that work may still wake it, and an interrupted wait is settled without one.
    const wait = thread.backgroundWait?.state;
    const needsInput = needsOf(this.core.threads.listQuestions(row.thread_id), this.core.threads.listPermissions(row.thread_id));
    const worktree = this.worktrees.get(row.thread_id);
    return { thread, profileId: row.profile_id, task: row.task, lastTurn, result: this.result(lastTurn),
      ...(terminal && wait !== 'waiting' ? { resultRef: { agentId: row.thread_id, turnId: lastTurn.id }, settlement: wait === 'interrupted' ? 'settled' as const : 'result_available' as const } : lastTurn === null ? { settlement: 'settled' as const } : {}),
      ...(needsInput.length ? { needsInput } : {}), ...(worktree ? { worktree } : {}) };
  }
  /** A turn under way, or one ended on background work that will wake it. */
  private busy(thread: ThreadSummary): boolean {
    return threadBusy(thread) || (this.core.threads.agentState.background.get(thread.id)?.length ?? 0) > 0;
  }
  get(threadId: string): DelegationView {
    const root = this.root(threadId);
    const agents = this.rows(root.id).map(row => this.member(row));
    const totals = this.core.journal.db.query(`SELECT
      SUM(json_extract(usage, '$.inputTokens')) AS inputTokens, SUM(json_extract(usage, '$.outputTokens')) AS outputTokens,
      SUM(json_extract(usage, '$.cacheReadTokens')) AS cacheReadTokens, SUM(json_extract(usage, '$.cacheWriteTokens')) AS cacheWriteTokens,
      SUM(json_extract(usage, '$.costUsdEquivalent')) AS costUsdEquivalent
      FROM turns WHERE thread_id IN (SELECT thread_id FROM delegated_agents WHERE root_id = ?)
      OR (thread_id = ? AND json_extract(execution, '$.operation') = 'delegation')` ).get(root.id, root.id) as Usage;
    const usage: Usage = { inputTokens: totals.inputTokens ?? 0, outputTokens: totals.outputTokens ?? 0, cacheReadTokens: totals.cacheReadTokens ?? 0, cacheWriteTokens: totals.cacheWriteTokens ?? 0, costUsdEquivalent: totals.costUsdEquivalent ?? null };
    const letters = (threadId === root.id
      ? this.core.journal.db.query('SELECT data FROM delegation_messages WHERE root_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(root.id)
      : this.core.journal.db.query('SELECT data FROM delegation_messages WHERE root_id = ? AND (sender_id = ? OR recipient_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT 100').all(root.id, threadId, threadId)) as LetterRow[];
    return { rootThreadId: root.id, settlement: agents.some(agent => (agent.lastTurn && ['queued', 'running'].includes(agent.lastTurn.status)) || agent.thread.backgroundWait?.state === 'waiting') ? 'waiting_for_children' : 'settled', config: this.config(root.id), agents, nativeAgents: nativeAgents(this.core.journal, threadId, this.core.threads.agentState.background.get(threadId), this.core.procs.liveOf(threadId)), messages: letters.reverse().map(row => JSON.parse(row.data) as AgentLetter), turnsUsed: this.used(root.id), usage };
  }
  resultPage(params: RpcParams<'delegation.result'>) { return delegatedResultPage(this.core, params); }
  wait(params: RpcParams<'delegation.wait'>, connection?: Connection) { return this.waits.wait(params, connection); }
  private saveConfig(rootId: string, config: DelegationConfig): void { this.core.journal.setSetting(`delegation:${rootId}`, config); }
  configure(threadId: string, value: DelegationConfig): DelegationView {
    const thread = this.core.threads.require(threadId);
    if (thread.parentThreadId || thread.archived) throw refused('delegation.configure requires an unarchived parent thread');
    const config = this.validateConfig(value, this.config(threadId));
    // Saving other settings of a paused team keeps who paused it; pausing it here is the owner's.
    const current = this.config(threadId);
    const pause = current.paused ? { by: current.pausedBy ?? 'owner', at: current.pausedAt ?? Date.now() } : { by: 'owner' as const, at: Date.now() };
    this.saveConfig(threadId, config.paused ? { ...config, pausedBy: pause.by, pausedAt: pause.at } : config);
    if (!config.enabled || config.paused) this.stop(threadId, undefined, pause.by, pause.at);
    else this.handOver(threadId);
    this.changed(threadId);
    this.core.scheduler.onSettingsChanged();
    return this.get(threadId);
  }
  /** The tick skips a held team's mail, so a resume hands over its backlog now. */
  private handOver(rootId: string): void {
    for (const row of this.core.journal.db.query("SELECT DISTINCT recipient_id FROM delegation_messages WHERE root_id = ? AND status = 'received'").all(rootId) as { recipient_id: string }[]) this.kick(row.recipient_id);
  }
  validateConfig(value: DelegationConfig, previous?: DelegationConfig): DelegationConfig {
    if (!value || typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean' || !Array.isArray(value.profiles) || value.profiles.length > 16) throw invalidParams('config: expected enabled, paused and up to 16 profiles');
    if (value.anyModel !== undefined && typeof value.anyModel !== 'boolean') throw invalidParams('config.anyModel: expected a boolean');
    const config: DelegationConfig = {
      enabled: value.enabled, paused: value.paused, anyModel: value.anyModel !== false,
      profiles: value.profiles.map(p => {
        if (!p || typeof p !== 'object') throw invalidParams('profile: expected an object');
        const id = text(p.id, 'profile.id', 64);
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw invalidParams('profile.id: expected letters, numbers, underscores or hyphens');
        const provider = this.core.providers.require(text(p.providerId, 'profile.providerId', 128));
        const account = this.core.accounts.require(text(p.accountId, 'profile.accountId', 128));
        if (account.providerId !== provider.id) throw refused('profile.accountId must belong to profile.providerId');
        const model = text(p.model, 'profile.model', 256);
        checkSavedSelection(provider, account.id, { model, effort: p.effort }, previous?.profiles.find(profile => profile.id === id));
        return { id, name: text(p.name, 'profile.name', 80), providerId: provider.id, accountId: account.id, model, effort: p.effort };
      }),
    };
    if (new Set(config.profiles.map(p => p.id)).size !== config.profiles.length) throw invalidParams('profile.id: expected unique ids');
    return config;
  }
  /** A workflow needs no enabled team: its steps and its summary stop only for a team the owner paused. */
  private held(config: DelegationConfig, workflow: boolean): boolean {
    return workflow ? config.enabled && config.paused : !config.enabled || config.paused;
  }
  private available(root: ThreadSummary, workflow = false): DelegationConfig {
    const config = this.config(root.id);
    if (this.closed || root.archived || this.held(config, workflow)) {
      if (!config.enabled || this.closed || root.archived) throw refused('subagents are off for this conversation; tell the user the owner turns them back on in Subagents > Settings');
      const hold = this.hold(root.id, config);
      throw refused(hold ? `subagents are paused: ${hold}` : 'subagents are paused; boite delegate resume continues them');
    }
    return config;
  }

  spawn(params: RpcParams<'delegation.spawn'>): DelegatedAgent {
    const parent = this.core.threads.require(params.threadId);
    if (parent.parentThreadId) throw refused('delegation supports one level; ask the parent to delegate another task');
    const requestId = text(params.requestId, 'requestId', 128);
    const task = text(params.task, 'task', 12000);
    const title = params.title === undefined ? task.split('\n')[0]!.slice(0, 80) : text(params.title, 'title', 120);
    if (params.worktree !== undefined && typeof params.worktree !== 'boolean') throw invalidParams('worktree: expected true, false or absent');
    const worktree = params.worktree === true;
    const project = params.project === undefined ? undefined : text(params.project, 'project', 4096);
    const request: RouteRequest = { profileId: params.profileId ?? null, ...(params.model === undefined ? {} : { model: text(params.model, 'model', 256) }), ...(params.effort === undefined ? {} : { effort: text(params.effort, 'effort', 32) }), ...(params.speed === undefined ? {} : { speed: text(params.speed, 'speed', 64) }) };
    // A request id from before routes keeps its fingerprint: profile, task and title only.
    // A spawn that names a context mode adds it, so a request id from before keeps its fingerprint.
    const fingerprint = hash([...(request.model === undefined && request.effort === undefined && request.speed === undefined ? [params.profileId, task, title] : [request, task, title]), ...(params.context === undefined ? [] : [params.context]), ...(worktree ? ['worktree'] : []), ...(project === undefined ? [] : [{ project }])]);
    const existing = this.core.journal.db.query('SELECT * FROM delegated_agents WHERE root_id = ? AND request_id = ?').get(parent.id, requestId) as AgentRow | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      return this.member(existing);
    }
    const config = this.available(parent);
    const profile = resolveRoute(this.core, parent, config, request);
    const persistentOwner = this.core.workforce.resident.ownerOf(parent.id);
    if (persistentOwner && !this.core.workforce.resident.allowed(persistentOwner, { ...profile, permissionMode: parent.permissionMode }, true)) throw refused('account/model access was withdrawn from this bot');
    const provider = this.core.providers.require(profile.providerId);
    assertDriverRunnable(provider.protocol, this.core.providers.summary(provider.id), this.core.accounts.require(profile.accountId), () => this.core.providers.launcherScriptOnly(provider.id));
    const row: AgentRow = { thread_id: '', root_id: parent.id, request_id: requestId, fingerprint, profile_id: profile.id, task };
    // Relationship and creation commit together. Start can fail (missing executable,
    // expired login); keep a visible failed child instead of silently retrying a spawn.
    const id = this.createChild(parent, profile, title, childId => {
      row.thread_id = childId;
      this.core.journal.db.query('INSERT INTO delegated_agents VALUES (?, ?, ?, ?, ?, ?)').run(childId, parent.id, requestId, fingerprint, profile.id, task);
    }, params.context, worktree, undefined, project);
    const own = this.worktrees.get(id);
    const child = this.core.threads.require(id);
    const checkout = own
      ? `You work in a git worktree of your own at ${own.path} on branch ${own.branch}, made from ${parent.projectId === child.projectId ? "the parent's" : "the project's"} HEAD; uncommitted edits are not in it. Commit your work on that branch before your final answer: the parent merges the branch.`
      : `You work in ${child.cwd}. You share that checkout: change only the files your task names and never undo another agent's edits.`;
    try {
      this.core.threads.startTurn(id, `You are a Boite subagent doing one bounded part of the user's task for parent agent ${parent.id}. ${checkout} You cannot start subagents. If you are blocked, run boite delegate send ${parent.id} "<what blocks you>" and keep going on what you can. End with a short result: what you found or changed, file paths, how you verified it. That final answer goes to the parent automatically; do not send it again.\nTask from the parent agent, supplied as JSON data:\n${JSON.stringify(task)}`, [], undefined, 'delegation', undefined, undefined, task);
    } catch (error) {
      this.core.logs.warn(`Subagent ${id} was created but its first turn could not start: ${messageOf(error)}`, { source: 'delegation', event: 'delegation.spawn-failed', threadId: id, data: { parent: parent.id, providerId: profile.providerId, model: profile.model ?? null, profile: profile.id } });
      const child = this.core.threads.require(id);
      this.core.journal.putThread({ ...child, status: 'error' });
      this.core.bus.emit('thread.updated', withLoad(this.core, { ...child, status: 'error' }));
      this.changed(parent.id);
      throw error;
    }
    this.changed(parent.id);
    this.core.logs.info(`Subagent ${id} spawned by ${parent.id} on ${profile.providerId} ${profile.model ?? 'default model'}${profile.effort ? ` at ${profile.effort}` : ''}${own ? ` in a worktree on ${own.branch}` : ''}`, {
      source: 'delegation', event: 'delegation.spawned', threadId: id, data: { parent: parent.id, providerId: profile.providerId, model: profile.model ?? null, effort: profile.effort ?? null, profile: profile.id, taskChars: task.length, worktree: own !== undefined },
    });
    return this.member(row);
  }

  /**
   * The owner profile of that id, else the conversation's own route under its
   * built-in id. A profile an owner already named `conversation` keeps its route.
   */
  route(parent: ThreadSummary, config: DelegationConfig, profileId: string | null): ChildRoute | undefined {
    const named = profileId === null ? undefined : config.profiles.find(p => p.id === profileId);
    if (named) return named;
    if (profileId === null || profileId === CONVERSATION_PROFILE_ID) return conversationRoute(parent);
    return undefined;
  }
  /** A profile, a free model choice or this conversation's model, checked; what a workflow step or a spawn runs on. */
  resolve(parentId: string, request: RouteRequest): ChildRoute {
    const parent = this.root(parentId);
    return resolveRoute(this.core, parent, this.config(parent.id), request);
  }
  /** Read the model lists a spawn or a plan names before the synchronous checks run. */
  async prepareRoutes(parentId: string, probe: ProviderProbe, models: (string | undefined)[]): Promise<void> {
    const named = models.filter((model): model is string => typeof model === 'string' && model.length > 0);
    if (!named.length) return;
    const parent = this.root(parentId);
    const known = catalog(this.core, parent, true).choices;
    const missing = named.filter(model => !known.some(c => `${c.providerId}/${c.model}` === model || c.model === model));
    if (!missing.length) return;
    const only = missing.map(model => providersNamed(this.core, model));
    await discover(this.core, probe, parent, only.some(list => list === undefined) ? undefined : [...new Set(only.flat() as string[])]);
  }
  /** What `boite delegate models` prints: every runnable model, read from each agent once. */
  async models(threadId: string, probe: ProviderProbe): Promise<DelegationModels> {
    const parent = this.root(threadId);
    const failures = await discover(this.core, probe, parent);
    const { choices, unavailable } = catalog(this.core, parent);
    const failed = new Set(failures.map(f => f.providerId));
    return { anyModel: anyModel(this.config(parent.id)), choices, unavailable: [...failures, ...unavailable.filter(u => !failed.has(u.providerId))] };
  }

  /**
   * An ordinary child thread on a profile, or on the parent's own route for a
   * workflow step that names none, in the parent's permission mode and its
   * checkout, or a bot's entrusted project. It uses the route's speed tier or
   * none: never the parent's. The tier is
   * checked here, whoever built the route. `record` runs in the same
   * transaction. `worktree` gives it a git worktree of its own instead of the
   * parent's checkout: its branch and folder now, the worktree itself before
   * its first turn ([worktrees](./delegation/worktrees.ts)). `fixed` is a
   * context mode and a permission mode the core sets itself, such as a memory
   * pass that runs no tool; each driver honours what it can of the mode.
   */
  createChild(parent: ThreadSummary, profile: ChildRoute, title: string, record: (id: string) => void, context?: unknown, worktree = false,
    fixed?: { contextMode: ThreadContextMode; permissionMode: PermissionMode }, project?: string): string {
    const id = newId('thr_');
    const { speed: asked, ...route } = profile;
    if (asked != null && route.model === null) throw invalidParams(SPEED_NEEDS_MODEL);
    const provider = this.core.providers.require(route.providerId);
    const speed = checkSpeed(provider, route.accountId, route.model, asked ?? null);
    const contextMode = fixed ? { ...fixed.contextMode, tools: fixed.contextMode.tools === null ? null : [...fixed.contextMode.tools] } : checkContext(provider, context);
    // Fixed memory passes keep the bot's personal workspace, even with one entrusted project.
    const workspace = fixed ? parent : childProject(this.core, parent, project);
    const planned = worktree ? this.worktrees.plan(workspace, id) : null;
    this.core.journal.db.transaction(() => {
      if (workspace.projectId === null) {
        const now = Date.now();
        const child: ThreadSummary = { ...parent, parentThreadId: parent.id, agentSessionId: undefined, ...route, speed, id, contextMode, ...(fixed ? { permissionMode: fixed.permissionMode } : {}),
          title, titleSource: 'user', status: 'idle', sessionId: null, sessionGeneration: 0, selectionVersion: 0,
          context: null, promptCache: null, load: null, unread: false, pinned: false, createdAt: now, updatedAt: now };
        this.core.journal.append({ type: 'thread.created', threadId: id, version: 1, payload: child }, () => this.core.journal.putThread(child));
        this.core.bus.emit('thread.created', child);
      } else this.core.threads.create({ projectId: workspace.projectId, providerId: route.providerId, accountId: route.accountId, model: route.model ?? undefined, effort: route.effort, speed, title, cwd: planned?.path ?? workspace.cwd, permissionMode: parent.permissionMode, ...(context === undefined ? {} : { context: context as RpcParams<'threads.create'>['context'] }) }, { id, branch: planned?.branch ?? workspace.branch, parentThreadId: parent.id });
      if (planned) this.worktrees.record(id, planned);
      record(id);
      const child = this.core.threads.require(id);
      this.core.journal.putThread({ ...child, titleSource: 'user', ...(fixed ? { contextMode, permissionMode: fixed.permissionMode } : {}) });
    })();
    return id;
  }

  reserveTurn(threadId: string, operation?: string): void {
    this.prepareTurnReservation(threadId, operation)?.();
  }

  /** Reserve durable usage first; a failed enclosing transaction must leave the stopped guard intact. */
  prepareTurnReservation(threadId: string, operation?: string): (() => void) | undefined {
    const thread = this.core.threads.require(threadId);
    if (!thread.parentThreadId && operation !== 'delegation') return;
    const root = this.root(threadId);
    // On the parent, only a workflow summary gets here unchecked: team mail passes the inbox gate first.
    this.available(root, thread.parentThreadId ? this.stepOwned(threadId) : true);
    const used = this.used(root.id);
    this.core.journal.setSetting(`delegation-turns:${root.id}`, used + 1);
    return () => { this.stopped.delete(threadId); };
  }
  /**
   * A child the core runs for a plan rather than for the agent: a workflow
   * step, a `/goal2` reviewer or checklist tracker, or an agent's memory pass. It needs no enabled team, only an unpaused
   * one, and its answer never comes back as mail.
   */
  private stepOwned(threadId: string): boolean {
    return this.core.workflows.owns(threadId) || this.core.activity.ownsReviewer(threadId) || this.core.activity.ownsTracker(threadId) || this.core.workforce.memory.owns(threadId);
  }
  /**
   * Whether a child's team lets its turn start. The scheduler passes the parent it
   * stored at enqueue and one config map per pump, so held turns read no thread row
   * and each team's setting once.
   */
  canRun(threadId: string, parentThreadId?: string | null, configs?: Map<string, DelegationConfig>): boolean {
    const parentId = parentThreadId === undefined ? this.core.journal.getThread(threadId)?.parentThreadId : parentThreadId;
    if (!parentId) return true;
    let config = configs?.get(parentId);
    if (config === undefined) {
      config = this.config(parentId);
      configs?.set(parentId, config);
    }
    return !this.held(config, this.stepOwned(threadId));
  }
  prepareTurn(turn: Turn): boolean {
    const thread = this.core.threads.require(turn.threadId);
    if (!thread.parentThreadId && turn.execution?.operation !== 'delegation') return true;
    const root = this.root(thread.id), config = this.config(root.id);
    const workflow = thread.parentThreadId ? this.stepOwned(thread.id) : true;
    if (this.closed || root.archived || thread.archived || this.held(config, workflow) || this.stopped.has(thread.id)) return false;
    for (const letter of this.letters(thread.id, 'uncertain')) if (letter.error === `Queued for provider turn ${turn.id}`) this.update(letter, 'uncertain', `Awaiting provider turn ${turn.id}`);
    return true;
  }
  private contact(thread: ThreadSummary): AgentLetter['from'] {
    return { coreId: 'local', threadId: thread.id, title: thread.title, project: thread.projectId ? this.core.journal.getProject(thread.projectId)?.name : undefined, machine: 'Boite', resources: '', status: thread.status, mode: 'team' };
  }
  send(params: RpcParams<'delegation.send'>, origin: NonNullable<AgentLetter['origin']> = 'agent', checkpoint = false): AgentLetter {
    const sender = this.core.threads.require(params.threadId), recipient = this.core.threads.require(params.toThreadId);
    const root = this.root(sender.id);
    const permitted = sender.parentThreadId ? recipient.id === sender.parentThreadId : recipient.parentThreadId === sender.id;
    if (!permitted) throw refused('toThreadId must be this agent\'s parent or a direct child');
    const body = text(params.text, 'text', 4000), requestId = text(params.requestId, 'requestId', 128);
    if (origin !== 'result' && requestId.startsWith('result:')) throw invalidParams('requestId: result: is reserved for core completion delivery');
    if (origin !== 'question' && requestId.startsWith('question:')) throw invalidParams('requestId: question: is reserved for the core telling a parent its child asks something');
    const fingerprint = hash([recipient.id, body, origin]);
    const existing = this.core.journal.db.query('SELECT data, fingerprint FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(sender.id, requestId) as LetterRow | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      return JSON.parse(existing.data) as AgentLetter;
    }
    this.available(root);
    if (sender.archived || (recipient.archived && (sender.parentThreadId || !this.retirements.revivable(recipient)))) throw refused('delegation messages require unarchived threads');
    const fromCore = origin === 'result' || origin === 'question';
    const count = this.core.journal.db.query('SELECT count(*) AS n FROM delegation_messages WHERE root_id = ? AND created_at > ?').get(root.id, Date.now() - 3_600_000) as { n: number };
    if (!fromCore && count.n >= 100) throw refused('delegation hourly message limit reached');
    // A parent writing to a child that waits on a question answers that question: a waiting child takes no mail.
    const reply = sender.parentThreadId ? null : delegationReply(this.core.threads.listQuestions(recipient.id), body);
    if (typeof reply === 'string') throw refused(reply, { field: 'text', toThreadId: recipient.id });
    const question = reply?.question, answer = reply?.answer;
    // A question letter stays until the card closes, which withdraws it if it was not delivered yet.
    const letter: AgentLetter = { id: randomUUID(), origin, ...(checkpoint ? { checkpoint: true } : {}), from: this.contact(sender), to: { coreId: 'local', threadId: recipient.id }, toTitle: recipient.title, toProject: this.contact(recipient).project, toMachine: 'Boite', text: body, replyTo: null, createdAt: Date.now(), expiresAt: fromCore ? Number.MAX_SAFE_INTEGER : Date.now() + 15 * 60_000, status: question ? 'delivered' : 'received', error: null, ...(question ? { answered: question.id } : {}) };
    const post = () => this.core.journal.append({ type: 'delegation.sent', threadId: sender.id, version: 1, payload: letter }, () => {
      this.core.journal.db.query('INSERT INTO delegation_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(letter.id, root.id, sender.id, recipient.id, requestId, fingerprint, letter.status, letter.createdAt, JSON.stringify(letter));
    });
    if (recipient.archived) this.retirements.revive(recipient, post); else post();
    for (const id of [sender.id, recipient.id]) this.core.threads.runner.noteMail(id, letter.createdAt);
    // An explicit new instruction resumes this child only. It cannot resume a paused team.
    this.stopped.delete(recipient.id);
    this.changed(root.id);
    if (question && answer) {
      this.core.threads.answerQuestion({ threadId: recipient.id, questionId: question.id, optionIds: answer.optionIds, ...(answer.text === undefined ? {} : { text: answer.text }) }, origin === 'user' ? 'the user, through the parent' : 'the parent agent');
      return letter;
    }
    this.kick(recipient.id);
    return letter;
  }
  private letters(threadId: string, status: AgentLetter['status']): AgentLetter[] {
    return (this.core.journal.db.query('SELECT data FROM delegation_messages WHERE recipient_id = ? AND status = ? ORDER BY created_at, rowid LIMIT 100').all(threadId, status) as LetterRow[]).map(row => JSON.parse(row.data) as AgentLetter);
  }
  private update(letter: AgentLetter, status: AgentLetter['status'], error: string | null = null): void {
    const next = { ...letter, status, error };
    this.core.journal.append({ type: 'delegation.delivery', threadId: letter.to.threadId, version: 1, payload: { id: letter.id, status, error } }, () => {
      this.core.journal.db.query('UPDATE delegation_messages SET status = ?, data = ? WHERE id = ?').run(status, JSON.stringify(next), letter.id);
    });
    const thread = this.core.journal.getThread(letter.to.threadId);
    if (thread) this.changed(thread.parentThreadId ?? thread.id);
    this.retirements.check(letter.from.threadId);
  }
  /** Who wrote a letter, from the side of the thread that reads it. */
  private relationTo(threadId: string): (letter: AgentLetter) => 'your parent' | 'your subagent' | undefined {
    const parent = this.core.journal.getThread(threadId)?.parentThreadId ?? null;
    return letter => letter.from.threadId === parent ? 'your parent'
      : this.core.journal.getThread(letter.from.threadId)?.parentThreadId === threadId ? 'your subagent' : undefined;
  }
  private inbox(threadId: string): AgentLetter[] {
    const root = this.root(threadId), config = this.config(root.id);
    if (this.closed || root.archived || !config.enabled || config.paused || this.stopped.has(threadId)) return [];
    return this.letters(threadId, 'received').filter(letter => letter.expiresAt > Date.now() && !this.retirements.silent(letter.from.threadId)).slice(0, 4);
  }
  take(threadId: string, turnId: string): string | null {
    if (this.delivering.has(threadId)) return null;
    const letters = this.inbox(threadId);
    if (!letters.length) return null;
    const prompt = delegationPrompt(letters, this.relationTo(threadId));
    this.core.threads.noteCoordination(threadId, turnId, prompt);
    for (const letter of letters) this.update(letter, 'delivered');
    return prompt;
  }
  /** Drivers without live input still receive pending results on an ordinary next turn. */
  initialInput(threadId: string, turnId: string): string {
    if (this.delivering.has(threadId)) return '';
    const letters = this.inbox(threadId);
    if (!letters.length) return '';
    const prompt = delegationPrompt(letters, this.relationTo(threadId));
    for (const letter of letters) this.update(letter, 'uncertain', `Awaiting provider turn ${turnId}`);
    this.core.threads.noteCoordination(threadId, turnId, prompt);
    return `\n${prompt}`;
  }
  submitted(threadId: string, turnId: string, success: boolean): void {
    for (const letter of this.letters(threadId, 'uncertain')) {
      if (letter.error === `Awaiting provider turn ${turnId}`) this.update(letter, success ? 'delivered' : 'uncertain', success ? null : 'Provider turn did not complete; not retried automatically');
    }
  }
  /** Whether results wait in the thread's inbox, about to open its next turn. */
  hasMail(threadId: string): boolean {
    return this.inbox(threadId).length > 0;
  }
  private async deliver(threadId: string): Promise<void> {
    if (this.delivering.has(threadId) || this.closed) return;
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived) return;
    // A cache keepalive in the way stops, and its `turn.finished` brings the result back here (`threads/cache-keepalive.ts`).
    if ((thread.status === 'queued' || thread.status === 'running') && this.inbox(threadId).length > 0 && this.core.threads.cacheKeepalive.yieldTo(threadId)) return;
    if (['queued', 'waiting'].includes(thread.status) || (thread.status === 'error' && (!thread.parentThreadId || this.stopped.has(threadId)))) return;
    const letters = this.inbox(threadId);
    if (!letters.length) return;
    this.delivering.add(threadId);
    try {
      const prompt = delegationPrompt(letters, this.relationTo(threadId));
      if (thread.status === 'running') {
        if (!this.core.threads.canSteer(threadId)) return;
        for (const letter of letters) this.update(letter, 'uncertain', 'Awaiting provider acknowledgement');
        try {
          const accepted = await this.core.threads.steer(threadId, prompt);
          if (!this.closed) for (const letter of letters) {
            const root = this.root(threadId), config = this.config(root.id);
            if (this.stopped.has(threadId) || config.paused || !config.enabled) this.update(letter, 'uncertain', 'Stopped while awaiting provider acknowledgement; not retried');
            else this.update(letter, accepted ? 'delivered' : 'received');
          }
        } catch (error) {
          if (!this.closed) for (const letter of letters) this.update(letter, 'uncertain', messageOf(error));
        }
      } else {
        const turn = this.core.threads.startTurn(threadId, prompt, [], undefined, 'delegation');
        // The scheduler may have started it synchronously before startTurn returns.
        for (const letter of letters) this.update(letter, 'uncertain', `${turn.status === 'queued' && this.core.journal.getTurn(turn.id)?.status === 'queued' ? 'Queued for' : 'Awaiting'} provider turn ${turn.id}`);
      }
    } catch (error) {
      // A persistent agent that is paused or out of budget: the results wait in its inbox.
      if (isAgentHeld(error)) { this.core.agentRuntime.whenAdmitted(threadId, 'delegation', () => this.kick(threadId)); return; }
      for (const letter of letters) this.update(letter, 'rejected', messageOf(error));
    } finally { this.delivering.delete(threadId); }
  }
  private finished(turn: Turn): void {
    if (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive') return;
    const thread = this.core.journal.getThread(turn.threadId);
    if (!thread) return;
    // A parent's own turn ending badly (a provider error, an agent update, a restart) is no
    // reason to stop its team: the children keep working and their results wake it again.
    // Only the owner's Stop (`threads.stopTurn`, `delegation.stop`) pauses a team.
    if (!thread.parentThreadId) return;
    // A restart handoff stopped it on purpose: the next core continues it, so this is no result,
    // and its worktree is still in use. A child the user or its parent stopped is in `stopped` first.
    if (turn.status === 'stopped' && this.core.threads.handoff.active && !this.stopped.has(thread.id) && this.delegated(thread.id)) {
      recordRestartCut(this.core, turn);
      return;
    }
    // Ended to wait on its own background work: it is not done, and its worktree is still in use.
    const live = turn.status === 'done' ? this.core.threads.agentState.background.get(thread.id) ?? [] : [];
    const settling = live.length > 0 ? null : this.worktrees.settle(thread.id);
    // A workflow step's answer goes to its run, and a goal reviewer's to its goal, never to the parent as mail.
    if (this.stepOwned(thread.id)) return;
    const root = this.core.journal.getThread(thread.parentThreadId);
    if (!root) return;
    this.changed(root.id);
    // A stopped turn is someone's Stop, not a problem to group.
    this.core.logs.record(turn.status === 'done' || turn.status === 'stopped' ? 'info' : 'warn', `Subagent ${thread.id} of ${root.id} finished its turn: ${turn.status}`, {
      source: 'delegation', event: 'delegation.finished', threadId: thread.id, turnId: turn.id,
      ...(turn.startedAt !== null && turn.finishedAt !== null ? { durationMs: turn.finishedAt - turn.startedAt } : {}), data: { parent: root.id, status: turn.status },
    });
    // Stopping a child is final until an explicit new instruction, and ends its pull request watches; no failure retry loop.
    if (turn.status !== 'done') { this.stopped.add(thread.id); this.core.pullRequestWatches.endThread(thread.id); }
    // A child that is over leaves no question behind for its parent to find.
    if (live.length === 0) this.closeQuestions(thread.id, `the core, since the subagent's turn ended ${turn.status}`);
    const config = this.config(root.id);
    if (!config.enabled || config.paused || root.archived) return;
    const result = this.result(turn);
    // Ended to wait on its own background work: what it says is a checkpoint, the result follows.
    if (live.length > 0) this.wakeDeadlines.delete(thread.id);
    const head = live.length > 0
      ? `${thread.title}: waiting on its background work (${[...new Set(live.map(task => task.description.trim() || task.kind))].join(', ')})\nCheckpoint, not its final result: that work wakes it and its final result follows.`
      : `${thread.title}: ${turn.status}`;
    const deliver = () => {
      // The worktree line is never cut: the parent needs the branch to merge.
      const worktree = live.length > 0 ? undefined : this.worktrees.get(thread.id);
      const tail = worktree ? `\n${worktreeLine(worktree)}` : '';
      try {
        this.send({ threadId: thread.id, toThreadId: root.id, requestId: `result:${turn.id}`, text: `${`${head}\n${result ?? 'No text result was returned.'}`.slice(0, 4000 - tail.length)}${tail}` }, 'result', live.length > 0);
      } catch (error) { this.core.log('warn', `delegation result ${thread.id}: ${messageOf(error)}`); }
    };
    if (settling) this.track(settling.then(() => { if (!this.closed) deliver(); }));
    else deliver();
  }
  /** Is this thread a delegated agent the parent spawned, rather than a workflow step or a reviewer? */
  delegated(threadId: string): boolean {
    return this.core.journal.db.query('SELECT 1 FROM delegated_agents WHERE thread_id = ?').get(threadId) !== null;
  }
  /** A delegated agent asked something: its parent learns at once. */
  private asked(request: QuestionRequest): void {
    const child = this.core.journal.getThread(request.threadId);
    if (!child?.parentThreadId || !answerable(request) || !this.delegated(child.id)) return;
    this.changed(child.parentThreadId);
    this.wake(child, request.id, questionWake(child, request));
  }
  /** A permission request: the parent learns of it only if the user has not answered it in a moment. */
  private permissionAsked(request: PermissionRequest): void {
    const child = this.core.journal.getThread(request.threadId);
    if (!child?.parentThreadId || !this.delegated(child.id)) return;
    this.changed(child.parentThreadId);
    this.permissionWakes.set(request.id, { threadId: child.id, at: Date.now() });
  }
  private wake(child: ThreadSummary, requestId: RequestId, text: string): void {
    try {
      this.send({ threadId: child.id, toThreadId: child.parentThreadId!, requestId: `question:${requestId}`, text }, 'question');
    } catch (error) { this.core.log('warn', `delegation question ${child.id}: ${messageOf(error)}`); }
  }
  /** A card closed: a parent that was not told yet is not told at all. */
  private cardClosed(threadId: string, requestId: RequestId): void {
    const row = this.core.journal.db.query("SELECT data FROM delegation_messages WHERE sender_id = ? AND request_id = ?").get(threadId, `question:${requestId}`) as LetterRow | null;
    const thread = this.core.journal.getThread(threadId);
    if (thread?.parentThreadId && this.delegated(threadId)) this.changed(thread.parentThreadId);
    if (!row) return;
    const letter = JSON.parse(row.data) as AgentLetter;
    if (letter.status === 'received') this.update(letter, 'expired', 'The question closed before it was delivered');
  }
  /** The open asynchronous questions of a delegated agent that is over or stopped. */
  private closeQuestions(threadId: string, by: string): void {
    for (const question of this.core.threads.listQuestions(threadId)) {
      // A blocking one goes with its turn; only an asynchronous card outlives it.
      if (!answerable(question) || question.async !== true) continue;
      try { this.core.threads.skipQuestion({ threadId, questionId: question.id }, by); } catch { /* Already closed by a nested settle. */ }
    }
  }
  /**
   * A delegated agent's background work changed. Once it ended, the agent gets
   * a moment to wake; the tick looks again when that moment is over.
   */
  private backgroundChanged(threadId: string): void {
    const thread = this.core.journal.getThread(threadId);
    if (!thread?.parentThreadId || this.stepOwned(threadId)) return;
    this.changed(thread.parentThreadId);
    this.settleWait(thread);
  }
  /** Re-reads a child's wait: keeps watching it while a wake is expected, tells its parent once it is interrupted. */
  private settleWait(thread: ThreadSummary): void {
    const wait = withLoad(this.core, thread).backgroundWait ?? null;
    if (wait?.state === 'waiting' && wait.until !== null) this.wakeDeadlines.set(thread.id, wait.until);
    else this.wakeDeadlines.delete(thread.id);
    if (wait?.state === 'interrupted') this.interrupted(thread, wait);
  }
  /** The parent learns once per turn that the wait it was told about ended without a result. */
  private interrupted(thread: ThreadSummary, wait: Extract<BackgroundWait, { state: 'interrupted' }>): void {
    const root = this.core.journal.getThread(thread.parentThreadId!);
    const turn = this.lastTurn(thread.id);
    if (!root || !turn || this.stopped.has(thread.id)) return;
    const config = this.config(root.id);
    if (!config.enabled || config.paused || root.archived || thread.archived) return;
    const requestId = `result:interrupted:${turn.id}`;
    if (this.core.journal.db.query('SELECT 1 FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(thread.id, requestId)) return;
    this.core.logs.warn(`Subagent ${thread.id} of ${root.id} was waiting on ${wait.for}; it ended without waking it: ${INTERRUPTION_TEXT[wait.reason]}`, {
      source: 'delegation', event: 'delegation.interrupted', threadId: thread.id, turnId: turn.id, data: { parent: root.id, reason: wait.reason },
    });
    try {
      this.send({ threadId: thread.id, toThreadId: root.id, requestId, text: `${thread.title}: interrupted\nIt was waiting on its background work (${wait.for}), which ended without waking it: ${INTERRUPTION_TEXT[wait.reason]}. Its last message was a checkpoint, not its final result. boite delegate resume ${thread.id} continues it; boite delegate send ${thread.id} "<instruction>" steers it.`.slice(0, 4000) }, 'result');
    } catch (error) { this.core.log('warn', `delegation interruption ${thread.id}: ${messageOf(error)}`); }
  }
  /**
   * `by` is who asked, recorded on the pause it may leave: the owner's Stop
   * (the default), the owner's settings, or the conversation's own agent.
   * `at` dates that pause; saving the settings of a paused team keeps its own.
   */
  stop(threadId: string, agentId?: string, by: PauseOrigin = 'stop', at = Date.now()): number {
    const thread = this.core.threads.require(threadId);
    if (thread.parentThreadId && agentId && agentId !== threadId) throw refused('an agent may stop only itself or its direct children');
    const root = this.root(threadId);
    const children = this.rows(root.id);
    // Nothing delegated, nothing to stop: a stopped or failed turn must not leave the team paused for no reason.
    if (!thread.parentThreadId && !agentId && children.length === 0 && !this.core.workflows.active(root.id)) return 0;
    const ids = thread.parentThreadId ? [threadId] : agentId ? [agentId] : children.map(row => row.thread_id);
    for (const id of ids) if (this.core.threads.require(id).parentThreadId !== root.id) throw refused('agentId must name a direct child');
    // Children that all finished and delivered are history: only unfinished work is worth a pause the owner must lift.
    const wake = this.lastTurn(root.id);
    const live = () => this.core.workflows.active(root.id)
      || (wake?.execution?.operation === 'delegation' && ['queued', 'running'].includes(wake.status))
      || children.some(row => this.busy(this.core.threads.require(row.thread_id)))
      || this.core.journal.db.query("SELECT 1 FROM delegation_messages WHERE root_id = ? AND status = 'received' LIMIT 1").get(root.id) !== null;
    const pausing = !thread.parentThreadId && !agentId && live();
    if (pausing) this.pause(root.id, by, at);
    const workflow = this.core.workflows.active(root.id);
    this.core.logs.info(`Stopping ${ids.length > 0 ? `${ids.length} subagents` : 'the workflows'} of ${root.id}${pausing ? `; the team is paused (${this.config(root.id).pausedBy})` : ''}`, { source: 'delegation', event: 'delegation.stopped', threadId: root.id, data: { agents: ids.length, workflow, paused: pausing, by: agentId ? 'agent' : thread.parentThreadId ? 'self' : 'parent', pausedBy: pausing ? by : null } });
    let stopped = 0;
    for (const id of ids) {
      // A child at rest on its own background work is at work too: stopping it ends that work.
      const waiting = withLoad(this.core, this.core.threads.require(id)).backgroundWait?.state === 'waiting';
      this.stopped.add(id);
      this.core.pullRequestWatches.endThread(id);
      this.core.activity.pauseAll(id);
      this.core.coordination.pause(id);
      if (this.core.scheduler.stop(id) || waiting) stopped++;
      this.closeQuestions(id, 'the core, since the subagent was stopped');
      this.core.threads.releaseAgent(id);
      for (const letter of this.letters(id, 'received')) this.update(letter, 'rejected', 'Agent stopped');
      for (const letter of this.letters(id, 'uncertain')) {
        if (letter.error?.startsWith('Queued for provider turn ')) this.update(letter, 'rejected', 'Agent stopped before provider delivery');
      }
    }
    if (!thread.parentThreadId && !agentId) {
      const turn = this.lastTurn(root.id);
      if (turn?.execution?.operation === 'delegation' && ['queued', 'running'].includes(turn.status) && this.core.scheduler.stop(root.id)) stopped++;
    }
    this.changed(root.id);
    return stopped;
  }
  /**
   * Continues what a pause or a stop left: lifts the team's pause when the
   * caller may (`pauseHold`), hands over the mail it held, sends each child
   * whose last turn stopped, failed or lost its wait a continuation (only
   * `agentId` when named) and, without `agentId`, resumes the root's paused
   * runs the caller may resume.
   */
  resume(threadId: string, agentId: string | undefined, principal: Principal): DelegationResumed {
    const root = this.core.threads.require(threadId);
    if (root.parentThreadId) throw refused('a subagent cannot resume its team; tell its parent what blocks you with boite delegate send');
    if (root.archived || this.closed) throw refused('subagents of an archived thread stay stopped');
    if (agentId !== undefined && this.core.journal.getThread(agentId)?.parentThreadId !== root.id) throw invalidParams(`agentId: ${agentId} is not a direct child of this thread; boite delegate list shows them`);
    if (!this.config(root.id).enabled) throw refused('subagents are off for this conversation; tell the user the owner turns them back on in Subagents > Settings');
    const unpaused = this.unpause(root.id, principal);
    const agents: string[] = [];
    for (const row of this.rows(root.id)) {
      if (agentId !== undefined && row.thread_id !== agentId) continue;
      const child = this.core.journal.getThread(row.thread_id);
      const turn = this.lastTurn(row.thread_id);
      if (!child || child.archived || !turn || this.busy(child)) continue;
      const lost = withLoad(this.core, child).backgroundWait?.state === 'interrupted';
      if (turn.status === 'done' && !lost) continue;
      const why = turn.status === 'done' ? 'its background work ended without waking it' : `it ended ${turn.status}${turn.error ? `: ${turn.error}` : ''}`;
      // One continuation per stopped turn, whoever asks: a second resume finds it on its way; one a Stop rejected goes again.
      const requestId = `resume:${turn.id}`;
      const sent = this.core.journal.db.query('SELECT status FROM delegation_messages WHERE sender_id = ? AND (request_id = ? OR substr(request_id, 1, ?) = ?)').all(root.id, requestId, requestId.length + 1, `${requestId}:`) as { status: string }[];
      if (sent.some(row => row.status !== 'rejected')) continue;
      this.send({ threadId: root.id, toThreadId: child.id, requestId: sent.length ? `${requestId}:${sent.length}` : requestId, text: `Continue your task from where your last turn stopped (${why}). Check what is already done before redoing anything, then finish and end with your result.`.slice(0, 4000) }, principal === 'agent' ? 'agent' : 'user');
      agents.push(child.id);
    }
    const runs = agentId === undefined ? this.core.workflows.resumePaused(root.id, principal) : [];
    this.changed(root.id);
    return { unpaused, agents, runs };
  }
  /** Lifts the team's pause when the caller may (`pauseHold`), refused with the reason otherwise; false when it was not paused. */
  unpause(rootId: string, principal: Principal): boolean {
    const config = this.config(rootId);
    if (!config.paused) return false;
    const hold = principal === 'owner' ? null : this.hold(rootId, config);
    if (hold) throw refused(`subagents stay paused: ${hold}`);
    const { pausedBy: _by, pausedAt: _at, ...rest } = config;
    this.saveConfig(rootId, { ...rest, paused: false });
    this.core.logs.info(`The team of ${rootId} was resumed by ${principal === 'owner' ? 'the owner' : 'its agent'} after a pause by ${config.pausedBy ?? 'owner'}`, { source: 'delegation', event: 'delegation.resumed', threadId: rootId, data: { pausedBy: config.pausedBy ?? null, principal } });
    this.handOver(rootId);
    this.changed(rootId);
    this.core.scheduler.onSettingsChanged();
    return true;
  }
  /** Once the server listens after a restart handoff: the children it cut go on (`delegation/restart.ts`). */
  resumeAfterRestart(): number {
    return this.closed || this.core.journal.isClosed() ? 0 : resumeRestartCuts(this.core);
  }
  /**
   * Native subagent tools are off in Boite, so a parent learns the Boite way on
   * every fresh session, and again on a turn about delegation or workflows or
   * while its team is paused. Children get one line about their parent.
   */
  instructions(threadId: string, request?: string, fresh = true): string {
    const thread = this.core.threads.require(threadId), root = this.root(threadId), config = this.config(root.id);
    if (thread.parentThreadId && this.core.workflows.owns(threadId)) return this.core.workflows.instructions(threadId);
    // A memory pass's or a `/goal2` checklist pass's prompt says everything it needs; it neither delegates nor writes mail.
    if (thread.parentThreadId && (this.core.workforce.memory.owns(threadId) || this.core.activity.ownsTracker(threadId))) return '';
    if (thread.parentThreadId && this.core.activity.ownsReviewer(threadId)) return '\nYou are a Boite goal reviewer. Your final answer and its VERDICT line go to the goal automatically; do not message the parent, start subagents or edit project files.\n';
    if (thread.parentThreadId) {
      const own = this.worktrees.get(threadId);
      const checkout = own ? `Own worktree ${own.path} on branch ${own.branch}: commit your work there; the parent merges it.` : 'Shared checkout: change only the files your task names.';
      return config.enabled ? `\nYou are a Boite subagent of ${root.id}. Blocked: boite delegate send ${root.id} "<what blocks you>". Your final answer returns automatically. You cannot start subagents or workflows. Waiting on your PR: boite pr watch, never a polling loop; each wake opens your next turn and its answer goes to the parent. ${checkout}\n` : '';
    }
    // With delegation off, only a workflow request is worth the words; spawn would be refused anyway.
    const asked = request === undefined || /workflow/i.test(request) || (config.enabled && DELEGATION_WORDS.test(request));
    // A persistent agent splits its work like a thread: the guide joins a fresh session while its subagents are on.
    if ((!fresh || (thread.agentSessionId && !config.enabled)) && !asked && !config.paused) return '';
    return `\n${subagentGuide(config)}\n`;
  }
  private changed(rootId: string): void {
    if (this.closed || this.pendingChanges.has(rootId)) return;
    this.pendingChanges.add(rootId);
    queueMicrotask(() => {
      this.pendingChanges.delete(rootId);
      if (!this.live()) return;
      this.core.bus.emit('delegation.changed', { threadId: rootId });
      for (const row of this.rows(rootId)) this.core.bus.emit('delegation.changed', { threadId: row.thread_id });
    });
  }
  private tick(): void {
    if (this.closed) return;
    // The journal closed without this module: nothing left to deliver or expire, so the timer stops.
    if (this.core.journal.isClosed()) { clearInterval(this.timer); return; }
    // A result never expires, so only other letters are parsed. A paused or off team takes no
    // mail; its letters wait for the owner, whose resume kicks them (`configure`).
    const rows = this.core.journal.db.query(`SELECT root_id, recipient_id, CASE WHEN request_id GLOB 'result:*' THEN NULL ELSE data END AS data
      FROM delegation_messages WHERE status = 'received'`).all() as { root_id: string; recipient_id: string; data: string | null }[];
    const recipients = new Set<string>(), configs = new Map<string, DelegationConfig>();
    for (const row of rows) {
      const letter = row.data === null ? null : JSON.parse(row.data) as AgentLetter;
      if (letter && letter.expiresAt <= Date.now()) { this.update(letter, 'expired', 'Message expired before delivery'); continue; }
      if (recipients.has(row.recipient_id)) continue;
      let config = configs.get(row.root_id);
      if (config === undefined) configs.set(row.root_id, config = this.config(row.root_id));
      if (config.enabled && !config.paused) recipients.add(row.recipient_id);
    }
    for (const threadId of recipients) this.track(this.deliver(threadId).catch(error => { if (this.live()) this.core.log('warn', `delegation ${threadId}: ${messageOf(error)}`); }));
    // A wake that did not come in time: the child is done, or interrupted, and its row says so.
    const now = Date.now();
    for (const [requestId, entry] of this.permissionWakes) {
      if (now - entry.at < PERMISSION_WAKE_MS) continue;
      this.permissionWakes.delete(requestId);
      const request = this.core.threads.listPermissions(entry.threadId).find(open => open.id === requestId);
      const child = this.core.journal.getThread(entry.threadId);
      if (request && child) this.wake(child, requestId, permissionWake(child, request));
    }
    for (const [threadId, until] of this.wakeDeadlines) {
      if (until > now) continue;
      this.wakeDeadlines.delete(threadId);
      const thread = this.core.journal.getThread(threadId);
      if (!thread?.parentThreadId) continue;
      this.core.bus.emit('thread.updated', withLoad(this.core, thread));
      this.changed(thread.parentThreadId);
      this.settleWait(thread);
    }
  }
  private remove(threadId: string): void {
    this.nativeActive.delete(threadId);
    this.wakeDeadlines.delete(threadId);
    this.summaries.delete(threadId);
    for (const [requestId, entry] of this.permissionWakes) if (entry.threadId === threadId) this.permissionWakes.delete(requestId);
    this.core.journal.db.query('DELETE FROM delegated_agents WHERE thread_id = ? OR root_id = ?').run(threadId, threadId);
    this.core.journal.db.query('DELETE FROM delegation_messages WHERE root_id = ? OR sender_id = ? OR recipient_id = ?').run(threadId, threadId, threadId);
  }
  beginClose(): void { this.waits.close(); this.closed = true; clearInterval(this.timer); this.off(); this.summaries.clear(); this.pendingChanges.clear(); this.nativeActive.clear(); this.wakeDeadlines.clear(); this.permissionWakes.clear(); }
  async close(): Promise<void> {
    this.beginClose();
    // Driver cancellation releases an in-flight steer. Do not wait here before
    // scheduler.drain, which owns that cancellation and its bounded wait.
  }
}
