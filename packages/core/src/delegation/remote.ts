/*
 * Subagents on another machine of the group: `boite delegate spawn --machine`.
 * The parent's machine (the caller) asks a member to start the child; the
 * member starts an ordinary thread in one of its projects and reports back.
 * The transport retries a request across addresses, and either machine may
 * restart or be away, so every operation is idempotent:
 *
 * - `delegation.start`, caller to member: the child, keyed by the parent and
 *   its request id. Asked again, the member answers the child it started;
 *   the same id with other content is refused.
 * - `delegation.report`, member to caller: an outbox kept in the member's
 *   journal until the caller took it, sent again once the caller is heard
 *   from. A child's state replaces the one waiting; a letter (result,
 *   question, message) is filed once by its request id.
 * - `delegation.letter`, caller to member: the parent steers its child or
 *   answers its question, keyed by the parent and its request id.
 * - `delegation.read`, caller to member: a page of a result, read live.
 * - `delegation.stop`, caller to member: an outbox of stops, and of
 *   retirements when the parent is archived or deleted.
 *
 * The member takes a start or a letter only while its owner keeps
 * `groupThreads` on. A stop, a read and the reports always pass.
 */
import { createHash, randomUUID } from 'node:crypto';
import { CONVERSATION_PROFILE_ID, delegationReply } from '@boite/contracts';
import type { AgentLetter, CoordinationPeer, ContextPreset, ContextRequest, DelegatedAgent, DelegationConfig, DelegationInput, DelegationResultPage, DelegationWorktree, PermissionMode, RpcParams, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { PeerRefusal } from '../coordination-wire.ts';
import { assertDriverRunnable } from '../drivers/index.ts';
import { invalidParams, messageOf, refused, requiredText as text, unavailable } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ProviderProbe } from '../providers/probe.ts';
import { GROUP_THREADS_OFF, machineArg, memberModels, memberNamed, peerRefusal, PERMISSION_MODES } from '../threads/group-spawn.ts';
import { modelsFor } from '../threads/selection.ts';
import { anyModel, catalog, chooseModel, conversationRoute, discover, loggedInAccount } from './routes.ts';
import { Outbox } from './outbox.ts';
import { resultPageOf } from './results.ts';

const RECORDS = 'remote-delegates:';
const PARENT = 'remote-parent:';
const REPORTS = 'remote-delegation-reports:';
const STOPS = 'remote-delegation-stops:';
/** How long a member reads a model list nobody read yet before it starts, under the caller's 5 s per request. */
const READ_MS = 3000;
const LETTER_MS = 15 * 60_000;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The model a child runs on there. `strict`: picked from that machine's list, so exactly that or nothing. */
interface WireRoute { providerId: string; model: string | null; effort: string | null; speed: string | null; strict?: true }

/** What the caller's machine sends with `delegation.start`. */
interface Start {
  parent: { threadId: string; title: string; projectId: string; project: string };
  requestId: string;
  /** The caller's fingerprint of the spawn: the same request id with another one is refused. */
  fingerprint: string;
  task: string;
  title: string;
  worktree: boolean;
  project?: string;
  context?: ContextRequest | ContextPreset;
  route: WireRoute;
  permissionMode: PermissionMode;
}

/** A child as the member last saw it: what `delegate list` shows on the caller's machine. */
export interface ChildState {
  thread: ThreadSummary;
  lastTurn: Turn | null;
  result: string | null;
  needsInput?: DelegationInput[];
  worktree?: DelegationWorktree;
  /** Its project's name on the member. */
  project?: string;
}

/** What a member answers to `delegation.start`. */
interface Started { childId: string; at: number; state: ChildState }

/** One entry of the member's outbox to the caller. */
interface Report {
  key: string;
  parentId: string;
  childId: string;
  requestId: string;
  at: number;
  state?: ChildState;
  removed?: true;
  letter?: { origin: 'result' | 'question' | 'agent'; requestId: string; text: string; checkpoint?: true };
}

/** One entry of the caller's outbox to the member. */
interface Stop { key: string; parentId: string; childId: string; retire?: true }

/** The caller's record of a child on another machine. `childId` is null until that machine answered or reported. */
interface RemoteChild {
  coreId: string;
  machine: string;
  childId: string | null;
  requestId: string;
  fingerprint: string;
  task: string;
  profileId: string;
  title: string;
  state: ChildState | null;
  /** When the member took the state kept here; an older one arriving late is ignored. */
  at: number;
  createdAt: number;
  retired?: true;
}

/** The member's link from a child here to its parent on another machine. */
export interface ParentLink { coreId: string; machine: string; parentId: string; title: string; projectId: string; project: string; requestId: string; fingerprint: string; at: number }

/** What the delegation module lends this one: its private state and its mail. */
export interface RemoteHost {
  available(root: ThreadSummary): DelegationConfig;
  changed(rootId: string): void;
  kick(threadId: string): void;
  snapshot(threadId: string): Omit<ChildState, 'project'>;
  /** Stops one child here, as `delegate stop` does; true when it was at work. */
  halt(threadId: string): boolean;
  /** An explicit new instruction: a stopped child takes mail again. */
  instructed(threadId: string): void;
  file(letter: AgentLetter, rootId: string, senderId: string, recipientId: string, requestId: string, fingerprint: string): void;
  update(letter: AgentLetter, status: AgentLetter['status'], error: string | null): void;
}

const readableState = (value: unknown): value is ChildState => {
  const state = value as ChildState | null;
  return typeof state?.thread?.id === 'string' && typeof state.thread.status === 'string' && typeof state.thread.title === 'string'
    && (state.lastTurn === null || typeof state.lastTurn?.id === 'string') && (state.result === null || typeof state.result === 'string')
    && (state.needsInput === undefined || Array.isArray(state.needsInput));
};

/** Both sides of a subagent on another machine of the group. */
export class RemoteDelegation {
  /** Parents here with a child on another machine. */
  private readonly roots = new Set<string>();
  /** Children here whose parent is on another machine. Kept in memory too: a deleted thread's setting is gone before its removal is heard. */
  private readonly parents = new Map<string, ParentLink>();
  private readonly spawning = new Map<string, { fingerprint: string; result: Promise<DelegatedAgent> }>();
  private readonly starting = new Map<string, { fingerprint: string; result: Promise<Started> }>();
  private readonly reports: Outbox<Report>;
  private readonly stops: Outbox<Stop>;
  private probe: ProviderProbe | null = null;
  private closed = false;
  private readonly boot: ReturnType<typeof setTimeout>;

  constructor(private readonly core: Core, private readonly host: RemoteHost) {
    this.reports = new Outbox(core, REPORTS, (peer, reports) => core.coordination.request(peer, 'delegation.report', { reports }));
    // A retirement asked once stays asked, whatever stop follows it.
    this.stops = new Outbox(core, STOPS, (peer, stops) => core.coordination.request(peer, 'delegation.stop', { stops }), (kept, next) => (kept.retire || next.retire ? { ...next, retire: true } : next));
    for (const { key } of this.keys(RECORDS)) this.roots.add(key.slice(RECORDS.length));
    for (const { key } of this.keys(PARENT)) {
      const link = core.journal.getSetting(key) as ParentLink | undefined;
      if (link) this.parents.set(key.slice(PARENT.length), link);
    }
    // Once the rest of the core is built: what waited goes, and each child here tells its parent where it stands now.
    this.boot = setTimeout(() => this.start(), 0);
    this.boot.unref?.();
  }

  useProbe(probe: ProviderProbe): void { this.probe = probe; }

  private start(): void {
    if (this.closed || this.core.journal.isClosed()) return;
    for (const childId of this.parents.keys()) {
      try { this.state(childId); } catch (error) { this.core.log('warn', `remote subagent ${childId}: ${messageOf(error)}`); }
    }
    this.reports.start();
    this.stops.start();
  }

  private keys(prefix: string): { key: string }[] {
    return this.core.journal.db.query('SELECT key FROM settings WHERE key GLOB ?').all(`${prefix}*`) as { key: string }[];
  }

  /** A member of the group was heard from: what waits for it goes now. Never throws: the caller is the transport. */
  heard(coreId: string): void {
    try {
      this.reports.heard(coreId);
      this.stops.heard(coreId);
    } catch (error) { this.core.log('warn', `remote subagents for ${coreId}: ${messageOf(error)}`); }
  }

  /** Sends what waits for that machine now; tests drive it instead of waiting for a retry. */
  async flush(coreId: string): Promise<void> {
    await this.reports.flush(coreId);
    await this.stops.flush(coreId);
  }

  /** What waits for that machine: reports from here, stops from here. */
  waiting(coreId: string): { reports: number; stops: number } {
    return { reports: this.reports.entries(coreId).length, stops: this.stops.entries(coreId).length };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.boot);
    this.reports.close();
    this.stops.close();
  }

  // -- the caller: a parent here, its child on another machine ------------------

  private records(rootId: string): RemoteChild[] { return (this.core.journal.getSetting(`${RECORDS}${rootId}`) as RemoteChild[] | undefined) ?? []; }
  private save(rootId: string, records: RemoteChild[]): void {
    if (records.length) {
      this.core.journal.setSetting(`${RECORDS}${rootId}`, records);
      this.roots.add(rootId);
    } else {
      this.core.journal.deleteSetting(`${RECORDS}${rootId}`);
      this.roots.delete(rootId);
    }
  }

  /** Whether this parent has a child on another machine. */
  has(rootId: string): boolean { return this.roots.has(rootId); }

  /** That child of this parent, on another machine, once that machine answered. */
  child(rootId: string, childId: string | undefined): RemoteChild | undefined {
    if (childId === undefined || !this.roots.has(rootId)) return undefined;
    return this.records(rootId).find(record => record.childId === childId && record.state !== null);
  }

  childIds(rootId: string): string[] {
    if (!this.roots.has(rootId)) return [];
    return this.records(rootId).flatMap(record => (record.childId !== null && record.state !== null ? [record.childId] : []));
  }

  /** Whether a spawn of this parent on another machine took that request id. */
  holds(rootId: string, requestId: string): boolean {
    return this.roots.has(rootId) && this.records(rootId).some(record => record.requestId === requestId);
  }

  /** The children of this parent on other machines, as `delegate list` shows them. */
  members(rootId: string): DelegatedAgent[] {
    if (!this.roots.has(rootId)) return [];
    return this.records(rootId).flatMap(record => (record.childId !== null && record.state !== null ? [this.member(rootId, record)] : []));
  }

  /** Whether a child of this parent on another machine is at work, as far as that machine reported. */
  busy(rootId: string): boolean {
    return this.members(rootId).some(agent => (agent.lastTurn !== null && ['queued', 'running'].includes(agent.lastTurn.status)) || ['queued', 'running', 'waiting'].includes(agent.thread.status) || agent.thread.backgroundWait?.state === 'waiting');
  }

  private member(rootId: string, record: RemoteChild): DelegatedAgent {
    const state = record.state!, childId = record.childId!;
    const lastTurn = state.lastTurn;
    const terminal = lastTurn !== null && !['queued', 'running'].includes(lastTurn.status);
    const wait = state.thread.backgroundWait?.state;
    return {
      thread: { ...state.thread, parentThreadId: rootId }, profileId: record.profileId, task: record.task, lastTurn, result: state.result,
      ...(terminal && wait !== 'waiting' ? { resultRef: { agentId: childId, turnId: lastTurn.id }, settlement: wait === 'interrupted' ? 'settled' as const : 'result_available' as const } : lastTurn === null ? { settlement: 'settled' as const } : {}),
      ...(state.needsInput?.length ? { needsInput: state.needsInput } : {}), ...(state.worktree ? { worktree: state.worktree } : {}),
      machine: { coreId: record.coreId, name: record.machine },
    };
  }

  private peerOf(record: RemoteChild): CoordinationPeer {
    const peer = this.core.group.peers().find(member => member.coreId === record.coreId);
    if (peer === undefined) throw refused(`${record.machine} is no longer in this group; its subagent ${record.childId ?? record.requestId} is out of reach`, { field: 'machine' });
    return peer;
  }

  /**
   * `delegation.spawn` with `machine`: the parent's gates here, the model
   * picked from that machine's list when one is named, then the member's
   * answer. A record is written before asking, so a report of a child whose
   * answer was lost still finds its parent, and the same request id asks again.
   */
  async spawn(params: RpcParams<'delegation.spawn'>): Promise<DelegatedAgent> {
    const parent = this.core.threads.require(params.threadId);
    if (parent.parentThreadId || this.parentOf(parent.id)) throw refused('delegation supports one level; ask the parent to delegate another task');
    if (parent.agentSessionId) throw refused('delegation.spawn.machine: a bot\'s subagents run on its own machine', { field: 'machine' });
    const requestId = text(params.requestId, 'requestId', 128);
    const task = text(params.task, 'task', 12000);
    const title = params.title === undefined ? task.split('\n')[0]!.slice(0, 80) : text(params.title, 'title', 120);
    if (params.worktree !== undefined && typeof params.worktree !== 'boolean') throw invalidParams('worktree: expected true, false or absent');
    const worktree = params.worktree === true;
    const project = params.project === undefined ? undefined : text(params.project, 'project', 4096).trim();
    const context = params.context;
    if (context !== undefined && (context === null || (typeof context !== 'string' && typeof context !== 'object') || Array.isArray(context))) throw invalidParams('context: expected a preset or a context request');
    const request = {
      profileId: params.profileId ?? null,
      ...(params.model === undefined ? {} : { model: text(params.model, 'model', 256).trim() }),
      ...(params.effort === undefined ? {} : { effort: text(params.effort, 'effort', 32).trim() }),
      ...(params.speed === undefined ? {} : { speed: text(params.speed, 'speed', 64).trim() }),
    };
    const peer = memberNamed(this.core, text(params.machine, 'delegation.spawn.machine', 128).trim(), 'delegation.spawn');
    const fingerprint = hash([request, task, title, context ?? null, worktree, project ?? null, { machine: peer.coreId }]);
    if (this.core.journal.db.query('SELECT 1 FROM delegated_agents WHERE root_id = ? AND request_id = ?').get(parent.id, requestId)) throw refused('requestId already used for different content');
    const known = this.records(parent.id).find(record => record.requestId === requestId);
    if (known) {
      if (known.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      if (known.childId !== null && known.state !== null) return this.member(parent.id, known);
    }
    const key = JSON.stringify([parent.id, requestId]);
    const active = this.spawning.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      return active.result;
    }
    const result = Promise.resolve().then(() => this.startThere(parent, peer, { requestId, fingerprint, task, title, worktree, project, context, request }, known !== undefined));
    this.spawning.set(key, { fingerprint, result });
    try { return await result; }
    finally { this.spawning.delete(key); }
  }

  private async startThere(parent: ThreadSummary, peer: CoordinationPeer, ask: { requestId: string; fingerprint: string; task: string; title: string; worktree: boolean; project?: string; context?: unknown; request: { profileId: string | null; model?: string; effort?: string; speed?: string } },
    retry: boolean): Promise<DelegatedAgent> {
    // A start asked before whose answer was lost passed these gates then: it is only asked again.
    const config = retry ? this.core.delegation.config(parent.id) : this.host.available(parent);
    const { request } = ask;
    const base = this.core.delegation.route(parent, config, request.profileId);
    if (!base) throw invalidParams(`profileId: expected ${[...new Set([CONVERSATION_PROFILE_ID, ...config.profiles.map(p => p.id)])].join(', ')}`);
    let route: WireRoute, profileId = base.id;
    if (request.model !== undefined || request.effort !== undefined || request.speed !== undefined) {
      const models = await memberModels(this.core, parent, peer, 'run subagents on a model chosen from another machine');
      const picked = chooseModel(models.choices, { providerId: base.providerId, model: base.model, effort: base.effort ?? null, speed: null }, request, `boite delegate models --machine ${machineArg(this.core, peer)}`);
      if (request.model !== undefined && !anyModel(config)) {
        const allowed = [conversationRoute(parent), ...config.profiles];
        if (!allowed.some(r => r.providerId === picked.providerId && r.model === picked.model)) {
          throw refused(`the owner limited subagents to this conversation's model and the profiles (${allowed.map(r => r.id).join(', ')}); leave --model out or name one of them`);
        }
      }
      route = { providerId: picked.providerId, model: picked.model, effort: picked.effort, speed: picked.speed, strict: true };
      if (request.model !== undefined) profileId = `${picked.providerId}/${picked.model}`;
    } else {
      route = { providerId: base.providerId, model: base.model, effort: base.effort ?? null, speed: null };
    }
    const from = parent.projectId === null ? null : this.core.journal.getProject(parent.projectId);
    const start: Start = {
      parent: { threadId: parent.id, title: parent.title, projectId: parent.projectId ?? '', project: from?.name ?? '' },
      requestId: ask.requestId, fingerprint: ask.fingerprint, task: ask.task, title: ask.title, worktree: ask.worktree,
      ...(ask.project === undefined ? {} : { project: ask.project }),
      ...(ask.context === undefined ? {} : { context: ask.context as ContextRequest | ContextPreset }),
      route, permissionMode: parent.permissionMode,
    };
    if (!retry) {
      this.save(parent.id, [...this.records(parent.id), {
        coreId: peer.coreId, machine: peer.name, childId: null, requestId: ask.requestId, fingerprint: ask.fingerprint, task: ask.task, profileId, title: ask.title, state: null, at: 0, createdAt: Date.now(),
      }]);
    }
    let answer: unknown;
    try { answer = await this.core.coordination.request(peer, 'delegation.start', start); }
    catch (error) {
      if (error instanceof PeerRefusal) {
        // Refused there: nothing started, and the request id is free again.
        this.save(parent.id, this.records(parent.id).filter(record => !(record.requestId === ask.requestId && record.state === null)));
        throw peerRefusal(this.core, peer, error, 'run subagents for another machine');
      }
      throw unavailable(`${peer.name} did not answer: ${messageOf(error)}; if the subagent started there, boite delegate list shows it once ${peer.name} reports it, and the same --request-id answers it`, { field: 'machine' });
    }
    const started = answer as Started | null;
    if (typeof started?.childId !== 'string' || typeof started.at !== 'number' || !readableState(started.state)) throw unavailable(`${peer.name} gave an answer this machine does not read; update Boite on both machines`, { field: 'machine' });
    const records = this.records(parent.id);
    const index = records.findIndex(record => record.requestId === ask.requestId);
    // Deleted while the request was out: the child there is retired with it.
    if (index < 0) {
      this.stops.push(peer.coreId, { key: `child:${started.childId}`, parentId: parent.id, childId: started.childId, retire: true });
      throw refused(`this thread was deleted while ${peer.name} started its subagent; that subagent is stopped`);
    }
    const record = { ...records[index]!, childId: started.childId };
    records[index] = started.at >= record.at ? { ...record, state: started.state, at: started.at } : record;
    this.save(parent.id, records);
    // It started there, so the setting was on: a card still asking for it is settled.
    this.core.threads.cards.settle(card => (card.setting?.kind === 'change' && card.setting.key === 'groupThreads' && card.setting.machine?.coreId === peer.coreId && card.setting.previous !== true
      ? { optionIds: [card.setting.value === true ? 'applied' : 'changed'], value: true } : null), `${peer.name}'s settings`);
    if (this.core.journal.getThread(parent.id)?.archived) this.retire(parent.id);
    this.host.changed(parent.id);
    if (!retry) {
      this.core.logs.info(`Subagent ${started.childId} spawned by ${parent.id} on ${peer.name} with ${route.providerId} ${route.model ?? 'default model'}${route.effort ? ` at ${route.effort}` : ''}`, {
        source: 'delegation', event: 'delegation.spawned', threadId: parent.id, data: { parent: parent.id, machine: peer.coreId, child: started.childId, providerId: route.providerId, model: route.model, effort: route.effort, profile: profileId, taskChars: ask.task.length, worktree: ask.worktree },
      });
    }
    return this.member(parent.id, records[index]!);
  }

  /** `delegation.send` from the parent to its child on another machine. */
  async send(params: RpcParams<'delegation.send'>, origin: 'agent' | 'user'): Promise<AgentLetter> {
    const root = this.core.threads.require(params.threadId);
    const record = this.child(root.id, params.toThreadId);
    if (!record) throw refused('toThreadId must be this agent\'s parent or a direct child');
    const body = text(params.text, 'text', 4000), requestId = text(params.requestId, 'requestId', 128);
    if (requestId.startsWith('result:')) throw invalidParams('requestId: result: is reserved for core completion delivery');
    if (requestId.startsWith('question:')) throw invalidParams('requestId: question: is reserved for the core telling a parent its child asks something');
    const childId = record.childId!, recipient = `${record.coreId}:${childId}`;
    const fingerprint = hash([recipient, body, origin]);
    const existing = this.core.journal.db.query('SELECT data, fingerprint FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(root.id, requestId) as { data: string; fingerprint: string } | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      return JSON.parse(existing.data) as AgentLetter;
    }
    this.host.available(root);
    const peer = this.peerOf(record);
    let answer: unknown;
    try { answer = await this.core.coordination.request(peer, 'delegation.letter', { parentId: root.id, childId, requestId, text: body, origin }); }
    catch (error) {
      if (error instanceof PeerRefusal) throw peerRefusal(this.core, peer, error, 'steer subagents for another machine');
      throw unavailable(`${peer.name} did not answer: ${messageOf(error)}; the same --request-id sends it once`, { field: 'machine' });
    }
    const reply = answer as { id?: unknown; answered?: unknown } | null;
    if (typeof reply?.id !== 'string') throw unavailable(`${peer.name} gave an answer this machine does not read; update Boite on both machines`, { field: 'machine' });
    const now = Date.now();
    // The copy here is history: it was delivered to that machine, which holds the letter itself.
    const letter: AgentLetter = {
      id: reply.id, origin, from: this.contact(root), to: { coreId: record.coreId, threadId: childId }, toTitle: record.state?.thread.title ?? record.title, toProject: record.state?.project,
      toMachine: peer.name, text: body, replyTo: null, createdAt: now, expiresAt: now + LETTER_MS, status: 'delivered', error: null, ...(typeof reply.answered === 'string' ? { answered: reply.answered } : {}),
    };
    this.host.file(letter, root.id, root.id, recipient, requestId, fingerprint);
    this.core.threads.runner.noteMail(root.id, now);
    this.host.changed(root.id);
    return JSON.parse((this.core.journal.db.query('SELECT data FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(root.id, requestId) as { data: string }).data) as AgentLetter;
  }

  /** `delegation.result` for a child on another machine: read from it now. */
  async read(params: RpcParams<'delegation.result'>): Promise<DelegationResultPage> {
    const record = this.child(params.threadId, params.agentId);
    if (!record) throw refused('agentId: expected a direct delegated child of threadId');
    const peer = this.peerOf(record);
    let answer: unknown;
    try { answer = await this.core.coordination.request(peer, 'delegation.read', { parentId: params.threadId, childId: record.childId, turnId: params.turnId, ...(params.offset === undefined ? {} : { offset: params.offset }), ...(params.limit === undefined ? {} : { limit: params.limit }) }); }
    catch (error) {
      if (error instanceof PeerRefusal) throw peerRefusal(this.core, peer, error, 'read subagent results for another machine');
      throw unavailable(`${peer.name} did not answer: ${messageOf(error)}; boite delegate list keeps its last result`, { field: 'machine' });
    }
    const page = answer as DelegationResultPage | null;
    if (typeof page?.text !== 'string' || typeof page.total !== 'number' || typeof page.offset !== 'number') throw unavailable(`${peer.name} gave an answer this machine does not read; update Boite on both machines`, { field: 'machine' });
    return page;
  }

  /** `delegate stop <id>` for a child on another machine: true when it was at work as last reported. The stop goes once that machine takes it. */
  stop(rootId: string, childId: string): boolean {
    const record = this.child(rootId, childId);
    if (!record) return false;
    this.stops.push(record.coreId, { key: `child:${childId}`, parentId: rootId, childId });
    const agent = this.member(rootId, record);
    return (agent.lastTurn !== null && ['queued', 'running'].includes(agent.lastTurn.status)) || ['queued', 'running', 'waiting'].includes(agent.thread.status) || agent.thread.backgroundWait?.state === 'waiting';
  }

  /** Every child of this parent on another machine; how many were at work. */
  stopAll(rootId: string): number {
    return this.childIds(rootId).filter(childId => this.stop(rootId, childId)).length;
  }

  /** The parent was archived: its children elsewhere are stopped and archived there, once. */
  retire(rootId: string): void {
    if (!this.roots.has(rootId)) return;
    const records = this.records(rootId);
    if (records.every(record => record.retired || record.childId === null)) return;
    for (const record of records) {
      if (record.retired || record.childId === null) continue;
      this.stops.push(record.coreId, { key: `child:${record.childId}`, parentId: rootId, childId: record.childId, retire: true });
      record.retired = true;
    }
    this.save(rootId, records);
  }

  /** The parent was deleted: its children elsewhere are retired, and nothing of them stays here. */
  forget(rootId: string): void {
    if (!this.roots.has(rootId)) return;
    this.retire(rootId);
    this.save(rootId, []);
  }

  private contact(thread: ThreadSummary): AgentLetter['from'] {
    return { coreId: 'local', threadId: thread.id, title: thread.title, project: thread.projectId ? this.core.journal.getProject(thread.projectId)?.name : undefined, machine: 'Boite', resources: '', status: thread.status, mode: 'team' };
  }

  /** `delegation.report`: what a member says of the children it runs for parents here. A bad entry is skipped, never the batch. */
  private received(peer: CoordinationPeer, payload: unknown): { ok: true } {
    const reports = (payload as { reports?: unknown } | null)?.reports;
    if (!Array.isArray(reports)) throw invalidParams('delegation.report.reports: expected a list');
    const touched = new Set<string>();
    for (const report of reports) {
      try {
        const rootId = this.receive(peer, report as Report);
        if (rootId !== null) touched.add(rootId);
      } catch (error) { this.core.log('warn', `delegation report from ${peer.name}: ${messageOf(error)}`); }
    }
    for (const rootId of touched) this.host.changed(rootId);
    return { ok: true };
  }

  private receive(peer: CoordinationPeer, report: Report): string | null {
    const parentId = text(report?.parentId, 'delegation.report.parentId', 128), childId = text(report.childId, 'delegation.report.childId', 128);
    const requestId = text(report.requestId, 'delegation.report.requestId', 128);
    if (typeof report.at !== 'number') throw invalidParams('delegation.report.at: expected a time');
    if (!this.roots.has(parentId)) return null;
    const records = this.records(parentId);
    const index = records.findIndex(record => record.coreId === peer.coreId && (record.childId === childId || (record.childId === null && record.requestId === requestId)));
    // A child this machine no longer follows.
    if (index < 0) return null;
    if (report.removed) {
      this.save(parentId, records.filter((_record, at) => at !== index));
      return parentId;
    }
    let record: RemoteChild = { ...records[index]!, childId };
    const fresh = report.state !== undefined && readableState(report.state) && report.at >= record.at;
    if (fresh) record = { ...record, state: report.state!, at: report.at };
    records[index] = record;
    this.save(parentId, records);
    if (fresh) this.closedQuestions(peer, childId, report.state!);
    if (report.letter !== undefined) this.fileLetter(parentId, peer, record, report.letter);
    return parentId;
  }

  /** A question the parent was told of and did not read yet, closed there since: it is not told at all. */
  private closedQuestions(peer: CoordinationPeer, childId: string, state: ChildState): void {
    const open = new Set((state.needsInput ?? []).map(need => need.id));
    const rows = this.core.journal.db.query("SELECT data, request_id FROM delegation_messages WHERE sender_id = ? AND request_id GLOB 'question:*' AND status = 'received'").all(`${peer.coreId}:${childId}`) as { data: string; request_id: string }[];
    for (const row of rows) {
      if (!open.has(row.request_id.slice('question:'.length))) this.host.update(JSON.parse(row.data) as AgentLetter, 'expired', 'The question closed before it was delivered');
    }
  }

  /** A result, a question or a message of a child elsewhere, filed for its parent here once, as a local child's is. */
  private fileLetter(rootId: string, peer: CoordinationPeer, record: RemoteChild, letter: NonNullable<Report['letter']>): void {
    if (!['result', 'question', 'agent'].includes(letter.origin)) throw invalidParams('delegation.report.letter.origin: expected result, question or agent');
    const body = text(letter.text, 'delegation.report.letter.text', 4000), requestId = text(letter.requestId, 'delegation.report.letter.requestId', 160);
    const sender = `${peer.coreId}:${record.childId}`;
    if (this.core.journal.db.query('SELECT 1 FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(sender, requestId)) return;
    const root = this.core.journal.getThread(rootId);
    const config = this.core.delegation.config(rootId);
    // An off, paused or archived team hears no result, as with a child here.
    if (!root || root.archived || !config.enabled || config.paused) return;
    const fromCore = letter.origin !== 'agent';
    const now = Date.now();
    const filed: AgentLetter = {
      id: randomUUID(), origin: letter.origin, ...(letter.checkpoint === true ? { checkpoint: true } : {}),
      from: { coreId: peer.coreId, threadId: record.childId!, title: record.state?.thread.title ?? record.title, ...(record.state?.project === undefined ? {} : { project: record.state.project }), machine: peer.name, resources: '', status: record.state?.thread.status ?? 'idle', mode: 'team' },
      to: { coreId: 'local', threadId: root.id }, toTitle: root.title, toProject: this.contact(root).project, toMachine: 'Boite', text: body, replyTo: null,
      createdAt: now, expiresAt: fromCore ? Number.MAX_SAFE_INTEGER : now + LETTER_MS, status: 'received', error: null,
    };
    this.host.file(filed, root.id, sender, root.id, requestId, hash([root.id, body, letter.origin]));
    this.core.threads.runner.noteMail(root.id, now);
    this.host.kick(root.id);
  }

  // -- the member: a child here, its parent on another machine ------------------

  /** The parent on another machine of a child here. */
  parentOf(childId: string): ParentLink | undefined { return this.parents.get(childId); }

  /** A child here changed: its parent hears where it stands. */
  state(childId: string): void {
    const link = this.parents.get(childId);
    if (!link || this.closed || this.core.journal.isClosed() || !this.core.journal.getThread(childId)) return;
    this.reports.push(link.coreId, { key: `state:${childId}`, parentId: link.parentId, childId, requestId: link.requestId, at: Date.now(), state: this.snapshot(childId) });
  }

  /** A result, a question or a message for the parent, with where the child stands. */
  letter(childId: string, letter: NonNullable<Report['letter']>): void {
    const link = this.parents.get(childId);
    if (!link || this.closed || this.core.journal.isClosed()) return;
    this.reports.push(link.coreId, { key: `letter:${childId}:${letter.requestId}`, parentId: link.parentId, childId, requestId: link.requestId, at: Date.now(), state: this.snapshot(childId), letter });
  }

  /** A question letter not sent yet whose card closed: the parent is not told at all. */
  withdraw(childId: string, requestId: string): void {
    const link = this.parents.get(childId);
    if (link) this.reports.remove(link.coreId, `letter:${childId}:${requestId}`);
  }

  /** A child here deleted for good: its parent forgets it. */
  removed(childId: string): void {
    const link = this.parents.get(childId);
    if (!link) return;
    this.parents.delete(childId);
    if (!this.core.journal.isClosed()) {
      this.core.journal.deleteSetting(`${PARENT}${childId}`);
      this.reports.push(link.coreId, { key: `state:${childId}`, parentId: link.parentId, childId, requestId: link.requestId, at: Date.now(), removed: true });
    }
  }

  private snapshot(childId: string): ChildState {
    const state = this.host.snapshot(childId);
    const project = state.thread.projectId ? this.core.journal.getProject(state.thread.projectId)?.name : undefined;
    return { ...state, ...(project === undefined ? {} : { project }) };
  }

  /**
   * `delegate send <parent>` from a child here whose parent is on another
   * machine: filed here as history and sent with the reports.
   */
  tell(params: RpcParams<'delegation.send'>, origin: NonNullable<AgentLetter['origin']>): AgentLetter {
    const child = this.core.threads.require(params.threadId);
    const link = this.parents.get(child.id);
    if (!link || params.toThreadId !== link.parentId) throw refused('toThreadId must be this agent\'s parent or a direct child');
    const body = text(params.text, 'text', 4000), requestId = text(params.requestId, 'requestId', 128);
    if (requestId.startsWith('result:')) throw invalidParams('requestId: result: is reserved for core completion delivery');
    if (requestId.startsWith('question:')) throw invalidParams('requestId: question: is reserved for the core telling a parent its child asks something');
    const recipient = `${link.coreId}:${link.parentId}`;
    const fingerprint = hash([recipient, body, origin]);
    const existing = this.core.journal.db.query('SELECT data, fingerprint FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(child.id, requestId) as { data: string; fingerprint: string } | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      return JSON.parse(existing.data) as AgentLetter;
    }
    if (child.archived) throw refused('delegation messages require unarchived threads');
    const now = Date.now();
    const letter: AgentLetter = {
      id: randomUUID(), origin, from: this.contact(child), to: { coreId: link.coreId, threadId: link.parentId }, toTitle: link.title, toProject: link.project, toMachine: link.machine,
      text: body, replyTo: null, createdAt: now, expiresAt: now + LETTER_MS, status: 'delivered', error: null,
    };
    this.host.file(letter, child.id, child.id, recipient, requestId, fingerprint);
    this.letter(child.id, { origin: 'agent', requestId, text: body });
    return letter;
  }

  /** A sealed `delegation.*` request of a member of the group. */
  async peer(peer: CoordinationPeer, operation: string, payload: unknown): Promise<unknown> {
    switch (operation) {
      case 'delegation.start': return this.startFor(peer, payload);
      case 'delegation.report': return this.received(peer, payload);
      case 'delegation.letter': return this.letterFor(peer, payload);
      case 'delegation.read': return this.readFor(peer, payload);
      case 'delegation.stop': return this.stopFor(peer, payload);
      default: throw invalidParams('operation: expected delegation.catalog, delegation.start, delegation.report, delegation.letter, delegation.read or delegation.stop');
    }
  }

  private linked(peer: CoordinationPeer, parentId: unknown, childId: unknown, method: string): { link: ParentLink; childId: string } {
    const parent = text(parentId, `${method}.parentId`, 128), child = text(childId, `${method}.childId`, 128);
    const link = this.parents.get(child);
    if (!link || link.coreId !== peer.coreId || link.parentId !== parent || !this.core.journal.getThread(child)) throw refused(`${method}.childId: ${child} is no subagent of ${parent} here`, { field: 'childId' });
    return { link, childId: child };
  }

  /** `delegation.start`, the member's side. Asked again with the same request, it answers the child it started, whatever its settings say now. */
  private async startFor(peer: CoordinationPeer, payload: unknown): Promise<Started> {
    const start = checkStart(payload);
    for (const [childId, link] of this.parents) {
      if (link.coreId !== peer.coreId || link.parentId !== start.parent.threadId || link.requestId !== start.requestId) continue;
      if (link.fingerprint !== start.fingerprint) throw refused('delegation.start.requestId was already used for different content', { field: 'requestId' });
      return { childId, at: Date.now(), state: this.snapshot(childId) };
    }
    if (this.core.settings.get().groupThreads !== true) throw refused(GROUP_THREADS_OFF);
    const key = JSON.stringify([peer.coreId, start.parent.threadId, start.requestId]);
    const active = this.starting.get(key);
    if (active) {
      if (active.fingerprint !== start.fingerprint) throw refused('delegation.start.requestId was already used for different content', { field: 'requestId' });
      return active.result;
    }
    const result = Promise.resolve().then(() => this.startChild(peer, start));
    this.starting.set(key, { fingerprint: start.fingerprint, result });
    try { return await result; }
    finally { this.starting.delete(key); }
  }

  private async startChild(peer: CoordinationPeer, start: Start): Promise<Started> {
    const here = this.core.coordination.identity().name;
    const target = start.project !== undefined ? this.core.projects.find(start.project, 'delegation.start', 'project') : this.projectNamed(start.parent.project, here);
    const route = await this.routeHere(start.route, here);
    const provider = this.core.providers.require(route.providerId), account = this.core.accounts.require(route.accountId);
    assertDriverRunnable(provider.protocol, this.core.providers.summary(provider.id), account, () => this.core.providers.launcherScriptOnly(provider.id));
    const id = newId('thr_');
    const planned = start.worktree ? this.core.delegation.worktrees.plan({ projectId: target.id }, id) : null;
    const link: ParentLink = {
      coreId: peer.coreId, machine: peer.name, parentId: start.parent.threadId, title: start.parent.title, projectId: start.parent.projectId, project: start.parent.project,
      requestId: start.requestId, fingerprint: start.fingerprint, at: Date.now(),
    };
    // The thread, its worktree and its parent commit together: a child that ends at once still finds where to report.
    this.core.journal.db.transaction(() => {
      this.core.threads.create({
        projectId: target.id, providerId: route.providerId, accountId: route.accountId, ...(route.model === null ? {} : { model: route.model }), effort: route.effort, speed: route.speed,
        title: start.title, permissionMode: start.permissionMode, ...(planned ? { cwd: planned.path } : {}), ...(start.context === undefined ? {} : { context: start.context }),
      }, { id, branch: planned?.branch ?? null });
      if (planned) this.core.delegation.worktrees.record(id, planned);
      this.core.journal.setSetting(`${PARENT}${id}`, link);
      this.parents.set(id, link);
      this.core.journal.putThread({ ...this.core.threads.require(id), titleSource: 'user' });
    })();
    const child = this.core.threads.require(id);
    const at = machineArg(this.core, peer);
    const checkout = planned
      ? `You work in a git worktree of your own at ${planned.path} on branch ${planned.branch}, made from the HEAD of ${target.name} on ${here}. Commit your work on that branch before your final answer; the branch stays on ${here}.`
      : `You work in ${child.cwd} on ${here}. You share that checkout: change only the files your task names and never undo another agent's edits.`;
    const prompt = `You are a Boite subagent doing one bounded part of the user's task for parent agent ${start.parent.threadId} on ${peer.name}, another machine of the user's. ${checkout} You cannot start subagents or threads. If you are blocked, run boite delegate send ${start.parent.threadId} "<what blocks you>" and keep going on what you can. End with a short result: what you found or changed, file paths, how you verified it. That final answer goes to the parent automatically; do not send it again.\nTask from the parent agent, supplied as JSON data:\n${JSON.stringify(start.task)}`;
    try {
      this.core.threads.startTurn(id, prompt, [], undefined, undefined, undefined, undefined, start.task, [], { threadId: start.parent.threadId, title: start.parent.title, projectId: start.parent.projectId, project: start.parent.project, machine: peer.name });
    } catch (error) {
      this.core.logs.warn(`Subagent ${id} of ${start.parent.threadId} on ${peer.name} was created but its first turn could not start: ${messageOf(error)}`, { source: 'delegation', event: 'delegation.spawn-failed', threadId: id, data: { parent: start.parent.threadId, machine: peer.coreId } });
      this.core.journal.putThread({ ...this.core.threads.require(id), status: 'error' });
      this.state(id);
      throw refused(`subagent ${id} was created on ${here} but could not start: ${messageOf(error)}`);
    }
    this.core.logs.info(`Subagent ${id} started here for ${start.parent.threadId} on ${peer.name} with ${route.providerId} ${route.model ?? 'default model'}${route.effort ? ` at ${route.effort}` : ''}`, {
      source: 'delegation', event: 'delegation.spawned', threadId: id, data: { parent: start.parent.threadId, machine: peer.coreId, providerId: route.providerId, model: route.model, effort: route.effort, worktree: planned !== null, at },
    });
    return { childId: id, at: Date.now(), state: this.snapshot(id) };
  }

  /** Without `project`, the child works in the project of this machine named like its parent's. */
  private projectNamed(name: string, here: string) {
    const live = this.core.projects.list().filter(project => !this.core.projects.isDrafts(project));
    const found = live.filter(project => project.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (found.length === 1) return found[0]!;
    const names = live.map(project => project.name);
    throw refused(found.length > 1
      ? `delegation.start.project: ${found.length} projects are named ${name} on ${here}; name one with --project`
      : `delegation.start.project: ${here} has no project named ${name || 'like the parent\'s'}; name one of its projects with --project: ${names.join(', ') || 'none'}`, { field: 'project', expected: names });
  }

  /**
   * The model a child starts on here: exactly the one named, never another.
   * A strict route takes its level and speed too, or is refused; otherwise a
   * level this model lacks gives way to its default, and the speed is standard.
   */
  private async routeHere(wire: WireRoute, here: string): Promise<{ providerId: string; accountId: string; model: string | null; effort: string | null; speed: string | null }> {
    const { providerId, model, effort, speed, strict } = wire;
    const provider = this.core.providers.available().some(summary => summary.id === providerId) ? this.core.providers.require(providerId) : null;
    const account = provider === null ? undefined : loggedInAccount(this.core.accounts.list().filter(entry => entry.providerId === providerId));
    if (this.probe !== null && provider !== null && account !== undefined && model !== null && !modelsFor(provider, account.id).some(entry => entry.id === model)) {
      await discover(this.core, this.probe, { providerId, accountId: account.id, model }, [providerId], READ_MS).catch(() => []);
    }
    const labels = () => catalog(this.core, { providerId, accountId: account?.id ?? '', model }).choices.map(choice => `${choice.providerId}/${choice.model}`);
    if (provider === null || account === undefined) {
      const expected = labels();
      throw refused(`${providerId} is not signed in on ${here}; name a model of ${here} with --model: ${expected.join(', ') || 'none'}`, { field: 'model', expected });
    }
    if (model === null) return { providerId, accountId: account.id, model: null, effort: null, speed: null };
    const listed = modelsFor(provider, account.id).find(entry => entry.id === model);
    const name = `${providerId}/${model}`;
    if (listed === undefined) {
      const expected = labels();
      throw refused(`${name} is not a model of ${here}; name one with --model: ${expected.join(', ') || 'none'}`, { field: 'model', expected });
    }
    const levels = listed.effort?.levels.map(level => level.id) ?? [];
    if (strict && effort !== null && !levels.includes(effort)) throw refused(`${name} has no "${effort}" level on ${here}; expected ${levels.join(', ') || 'none'}`, { field: 'effort', expected: levels });
    const tiers = listed.speeds?.map(tier => tier.id) ?? [];
    if (strict && speed !== null && !tiers.includes(speed)) throw refused(`${name} has no "${speed}" tier on ${here}; expected ${tiers.join(', ') || 'none'}`, { field: 'speed', expected: tiers });
    return { providerId, accountId: account.id, model: listed.id, effort: effort !== null && levels.includes(effort) ? effort : listed.effort?.default ?? null, speed: strict ? speed : null };
  }

  /** `delegation.letter`: the parent on another machine steers its child here or answers its question. */
  private letterFor(peer: CoordinationPeer, payload: unknown): { id: string; status: AgentLetter['status']; answered?: string } {
    if (this.core.settings.get().groupThreads !== true) throw refused(GROUP_THREADS_OFF);
    const raw = (payload ?? {}) as Record<string, unknown>;
    const { link, childId } = this.linked(peer, raw.parentId, raw.childId, 'delegation.letter');
    const requestId = text(raw.requestId, 'delegation.letter.requestId', 128), body = text(raw.text, 'delegation.letter.text', 4000);
    if (raw.origin !== 'agent' && raw.origin !== 'user') throw invalidParams('delegation.letter.origin: expected agent or user');
    const origin = raw.origin;
    const sender = `${peer.coreId}:${link.parentId}`;
    const fingerprint = hash([childId, body, origin]);
    const existing = this.core.journal.db.query('SELECT data, fingerprint FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(sender, requestId) as { data: string; fingerprint: string } | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('delegation.letter.requestId was already used for different content', { field: 'requestId' });
      const filed = JSON.parse(existing.data) as AgentLetter;
      return { id: filed.id, status: filed.status, ...(filed.answered === undefined ? {} : { answered: filed.answered }) };
    }
    const child = this.core.threads.require(childId);
    if (child.archived) throw refused('delegation messages require unarchived threads');
    // A parent writing to a child that waits on a question answers that question.
    const reply = delegationReply(this.core.threads.listQuestions(childId), body);
    if (typeof reply === 'string') throw refused(reply, { field: 'text', toThreadId: childId });
    const question = reply?.question, answer = reply?.answer;
    const now = Date.now();
    const letter: AgentLetter = {
      id: randomUUID(), origin, from: { coreId: peer.coreId, threadId: link.parentId, title: link.title, project: link.project, machine: link.machine, resources: '', status: 'idle', mode: 'team' },
      to: { coreId: 'local', threadId: childId }, toTitle: child.title, toProject: this.contact(child).project, toMachine: 'Boite', text: body, replyTo: null,
      createdAt: now, expiresAt: now + LETTER_MS, status: question ? 'delivered' : 'received', error: null, ...(question ? { answered: question.id } : {}),
    };
    this.host.file(letter, childId, sender, childId, requestId, fingerprint);
    this.core.threads.runner.noteMail(childId, now);
    // An explicit new instruction resumes this child.
    this.host.instructed(childId);
    this.host.changed(childId);
    if (question && answer) {
      this.core.threads.answerQuestion({ threadId: childId, questionId: question.id, optionIds: answer.optionIds, ...(answer.text === undefined ? {} : { text: answer.text }) }, origin === 'user' ? 'the user, through the parent' : 'the parent agent');
    } else this.host.kick(childId);
    return { id: letter.id, status: letter.status, ...(letter.answered === undefined ? {} : { answered: letter.answered }) };
  }

  /** `delegation.read`: a page of a result of a child here, for its parent elsewhere. */
  private readFor(peer: CoordinationPeer, payload: unknown): DelegationResultPage {
    const raw = (payload ?? {}) as Record<string, unknown>;
    const { childId } = this.linked(peer, raw.parentId, raw.childId, 'delegation.read');
    const turnId = text(raw.turnId, 'delegation.read.turnId', 128);
    return resultPageOf(this.core, childId, turnId, raw.offset as number | undefined, raw.limit as number | undefined);
  }

  /** `delegation.stop`: stops, and retirements of children whose parent is archived or deleted there. An unknown child is skipped. */
  private stopFor(peer: CoordinationPeer, payload: unknown): { stopped: number } {
    const stops = (payload as { stops?: unknown } | null)?.stops;
    if (!Array.isArray(stops)) throw invalidParams('delegation.stop.stops: expected a list');
    let stopped = 0;
    for (const entry of stops as Stop[]) {
      try {
        const { childId } = this.linked(peer, entry?.parentId, entry?.childId, 'delegation.stop');
        if (this.host.halt(childId)) stopped++;
        if (entry.retire === true && !this.core.threads.require(childId).archived) this.core.threads.archive(childId, true);
      } catch (error) { this.core.log('info', `delegation stop from ${peer.name}: ${messageOf(error)}`); }
    }
    return { stopped };
  }
}

/** A `delegation.start` request checked field by field. */
function checkStart(value: unknown): Start {
  const raw = (value ?? {}) as Record<string, unknown>;
  const parent = (raw.parent ?? {}) as Record<string, unknown>;
  const route = (raw.route ?? {}) as Record<string, unknown>;
  const optional = (field: unknown, name: string, max: number): string | null => (field === null || field === undefined ? null : text(field, `delegation.start.route.${name}`, max));
  if (typeof raw.worktree !== 'boolean') throw invalidParams('delegation.start.worktree: expected true or false');
  if (typeof raw.permissionMode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(raw.permissionMode)) throw invalidParams(`delegation.start.permissionMode: expected ${PERMISSION_MODES.join(', ')}`);
  if (route.strict !== undefined && route.strict !== true) throw invalidParams('delegation.start.route.strict: expected true or absent');
  const context = raw.context;
  if (context !== undefined && (context === null || (typeof context !== 'string' && typeof context !== 'object') || Array.isArray(context))) throw invalidParams('delegation.start.context: expected a preset or a context request');
  return {
    parent: {
      threadId: text(parent.threadId, 'delegation.start.parent.threadId', 128),
      title: text(parent.title, 'delegation.start.parent.title', 200),
      projectId: typeof parent.projectId === 'string' ? parent.projectId.slice(0, 128) : '',
      project: typeof parent.project === 'string' ? parent.project.slice(0, 200) : '',
    },
    requestId: text(raw.requestId, 'delegation.start.requestId', 128),
    fingerprint: text(raw.fingerprint, 'delegation.start.fingerprint', 128),
    task: text(raw.task, 'delegation.start.task', 12_000),
    title: text(raw.title, 'delegation.start.title', 120),
    worktree: raw.worktree,
    ...(raw.project === undefined ? {} : { project: text(raw.project, 'delegation.start.project', 4096) }),
    ...(context === undefined ? {} : { context: context as ContextRequest | ContextPreset }),
    route: {
      providerId: text(route.providerId, 'delegation.start.route.providerId', 128),
      model: optional(route.model, 'model', 256),
      effort: optional(route.effort, 'effort', 64),
      speed: optional(route.speed, 'speed', 64),
      ...(route.strict === true ? { strict: true as const } : {}),
    },
    permissionMode: raw.permissionMode as PermissionMode,
  };
}
