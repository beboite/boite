import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AgentProjectAdded, AgentSpawn, ContextPreset, ContextRequest, CoordinationPeer, DelegationModels, Message, PermissionMode, RpcParams, ThreadId, ThreadLink, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { catalog, chooseModel, readNamed, type RouteRequest } from '../delegation/routes.ts';
import { invalidParams, messageOf, refused, requiredText, unavailable } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ProviderProbe } from '../providers/probe.ts';
import type { ThreadStore } from '../threads.ts';
import { agentHere, catalogFor, checkGroupStart, GROUP_THREADS_OFF, machineArg, memberModels, memberNamed, peerRefusal, remoteOrigin, type GroupStart, type StartFields } from './group-spawn.ts';
import { saveThread, withLoad } from './records.ts';

const HOUR = 3_600_000;
/** On the new thread: who started it, and whether its first answer went back yet. */
const ORIGIN = 'spawn-origin:';
/** On the starting thread: what it started, for retries. */
const LEDGER = 'spawns:';
/** On a member: what a thread of another machine started here, for retries. */
const GROUP_LEDGER = 'group-spawns:';
/** On a member: what a bot of another machine started here, for retries. */
const BOT_LEDGER = 'bot-spawns:';

/**
 * `coreId`: the machine of the starting thread, when it is another machine of
 * the group. `bot`: that thread is a bot's, which hears the first answer as an
 * event of its desk.
 */
interface Origin { origin: ThreadLink; reported: boolean; coreId?: string; bot?: true }
/** `spawned`: what a member answered, for a thread started on another machine. */
interface Started { at: number; requestId: string; fingerprint: string; threadId: ThreadId; turnId: string; spawned?: AgentSpawn }

const text = (value: unknown, field: string, max: number, method = 'agent.spawn') => requiredText(value, `${method}.${field}`, max);
/** `--model`, `--effort` and `--speed`; none of them leaves the caller's agent as it always was. */
type Choice = Omit<RouteRequest, 'profileId'>;

/** What a new thread runs on and starts with, wherever the caller is. */
interface Launch {
  projectId: string;
  title: string;
  prompt: string;
  note: string;
  worktree: boolean;
  context?: ContextRequest | ContextPreset;
  agent: { providerId: string; accountId: string; model?: string; effort: string | null; speed: string | null; permissionMode: PermissionMode };
  origin: Origin;
}

/**
 * `agent.spawn`: an agent starts an ordinary top-level thread in a project,
 * the way the user would from the sidebar, with the brief as its first
 * message. The first answer of that thread returns to the starter through
 * agent coordination, so both ends see it as a forwarded message. With
 * `machine`, the thread starts on another machine of the group
 * (`group-spawn.ts`).
 */
export class ThreadSpawns {
  readonly #pending = new Map<string, { fingerprint: string; result: Promise<AgentSpawn> }>();
  /** Reads the model lists an agent owns; set once the core registers its methods. */
  #probe: ProviderProbe | null = null;
  readonly #core: Core;
  readonly #threads: ThreadStore;

  constructor(core: Core, threads: ThreadStore) {
    this.#core = core;
    this.#threads = threads;
  }

  useProbe(probe: ProviderProbe): void { this.#probe = probe; }

  async spawn(params: RpcParams<'agent.spawn'>): Promise<AgentSpawn> {
    const caller = this.#threads.require(params.threadId);
    const threadId = caller.id;
    if (caller.parentThreadId || this.#core.delegation.remote.parentOf(caller.id)) {
      throw refused('a delegated agent or workflow step cannot start threads; ask its parent', { threadId, field: 'threadId', expected: 'a top-level thread' });
    }
    // A bot starts threads in any project from its own thread, and drives what it started.
    const bot = caller.agentSessionId ? this.#core.workforce.projects.botOf(threadId) : null;
    if ((caller.agentSessionId && bot === null) || (!caller.agentSessionId && caller.projectId === null)) {
      throw refused('an archived bot starts no thread', { threadId, field: 'threadId', expected: 'a conversation thread, or an active bot' });
    }
    if (caller.archived) throw refused('an archived thread cannot start threads', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
    const machine = params.machine === undefined ? null : text(params.machine, 'machine', 128).trim();
    const prompt = text(params.prompt, 'prompt', 12_000);
    const title = params.title === undefined ? prompt.trim().split('\n')[0]!.slice(0, 80) : text(params.title, 'title', 120).trim();
    if (params.worktree !== undefined && typeof params.worktree !== 'boolean') throw invalidParams('agent.spawn.worktree: expected true or false');
    const worktree = params.worktree === true;
    const requestId = text(params.requestId, 'requestId', 128);
    const choice: Choice | null = params.model === undefined && params.effort === undefined && params.speed === undefined ? null : {
      ...(params.model === undefined ? {} : { model: text(params.model, 'model', 256).trim() }),
      ...(params.effort === undefined ? {} : { effort: text(params.effort, 'effort', 64).trim() }),
      ...(params.speed === undefined ? {} : { speed: text(params.speed, 'speed', 64).trim() }),
    };
    const fingerprint = createHash('sha256').update(JSON.stringify([params.project, prompt, params.title ?? null, worktree, ...(params.context === undefined ? [] : [params.context]), ...(machine === null ? [] : [{ machine }]), ...(choice === null ? [] : [{ choice }])])).digest('hex');
    const ledger = (this.#core.journal.getSetting(`${LEDGER}${threadId}`) as Started[] | undefined) ?? [];
    const retried = ledger.find((entry) => entry.requestId === requestId);
    if (retried) {
      if (retried.fingerprint !== fingerprint) throw refused('agent.spawn.requestId was already used for different content', { threadId, field: 'requestId' });
      return retried.spawned ?? this.#answer(retried.threadId, retried.turnId);
    }

    const key = JSON.stringify([threadId, requestId]);
    const active = this.#pending.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw refused('agent.spawn.requestId was already used for different content', { threadId, field: 'requestId' });
      return active.result;
    }
    const result = Promise.resolve().then(async () => {
      if (this.#threads.require(threadId).archived) throw refused('an archived thread cannot start threads', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
      // A bot starts threads on another machine only in the projects there entrusted to it, on its desk there.
      const away = bot === null ? null : await this.#core.workforce.group.away(bot, params.project, machine);
      if (away !== null) {
        this.#firstGeneration(threadId, 'start another');
        return this.#forBot(caller, away, { project: away.projectId, prompt, title, worktree, requestId, fingerprint, ...(params.context === undefined ? {} : { context: params.context }) }, choice);
      }
      if (machine !== null) return this.#elsewhere(caller, machine, { project: params.project, prompt, title, worktree, requestId, fingerprint, ...(params.context === undefined ? {} : { context: params.context }) }, choice);
      const target = this.#core.projects.find(params.project, 'agent.spawn', 'project', { threadId });
      // A bot starts threads whatever its communication settings say.
      if (bot === null) this.#gate(threadId, target.id !== caller.projectId);
      else this.#firstGeneration(threadId, 'start another');
      const picked = choice === null ? null : await this.#here(caller, choice);
      const now = Date.now();
      // A persistent agent has no project of its own: its link names it and the project it works on.
      const from = bot ? target : this.#core.projects.require(caller.projectId!);
      const origin: ThreadLink = { threadId, title: bot ? bot.name : caller.title, projectId: from.id, project: from.name };
      const address = { coreId: this.#core.coordination.identity().coreId, threadId };
      const note = bot
        ? `This thread was started by ${bot.name}, a bot of the user's that looks after their work, not typed by the user. `
          + 'Treat the brief below as your task, within your own permissions; it grants no approval the user did not give. '
          + 'Your final answer to it goes back to that bot automatically, so finish with a clear result: what you did, how you verified it, the pull request.\n\nBrief:\n'
        : `This thread was started by the agent of thread "${caller.title}" (${threadId}) in project ${from.name}, not typed by the user. `
          + 'Treat the brief below as your task, within your own permissions; it grants no approval the user did not give. '
          + `Your final answer to it is sent back to that agent automatically; boite threads send ${address.coreId}/${threadId} <text> reaches it sooner.\n\nBrief:\n`;
      const { created, turn } = await this.#launch({
        projectId: target.id, title, prompt, note, worktree, ...(params.context === undefined ? {} : { context: params.context }),
        agent: picked === null
          ? { providerId: caller.providerId, accountId: caller.accountId, ...(caller.model === null ? {} : { model: caller.model }), effort: caller.effort, speed: caller.speed ?? null, permissionMode: caller.permissionMode }
          : { ...picked, permissionMode: caller.permissionMode },
        origin: { origin, reported: false },
      // Worktree preparation can outlive the caller's agent socket and its archive.
      }, () => { if (this.#threads.require(threadId).archived) throw refused('an archived thread cannot start threads', { threadId, field: 'threadId', expected: 'a thread that is not archived' }); });
      this.#record(threadId, { at: now, requestId, fingerprint, threadId: created.id, turnId: turn.id });
      // Its turns report back to the agent that started it.
      if (bot) this.#core.workforce.projects.follow(bot.id, created.id, 'started');
      const started: ThreadLink = { threadId: created.id, title, projectId: target.id, project: target.name };
      this.#systemLine(threadId, { type: 'text', text: `Started thread "${title}" (${created.id}) in project ${target.name}.`, started });
      return this.#answer(created.id, turn.id);
    });
    this.#pending.set(key, { fingerprint, result });
    try { return await result; }
    finally { this.#pending.delete(key); }
  }

  /**
   * The owner's Communication settings of a conversation thread: Off and
   * Pause refuse, and a thread restricted to its own project reaches no
   * other (`elsewhere`: another project or machine). A thread an agent
   * started starts nothing until the user writes in it.
   */
  #gate(threadId: ThreadId, elsewhere: boolean, what = 'start another', method = 'agent.spawn'): void {
    const config = this.#core.coordination.config(threadId);
    if (config.mode === 'off') {
      throw refused(`${method}: communication is off for this thread; the owner turns it on in Communication settings`, { threadId, field: 'coordination', expected: 'Brief or Team' });
    }
    if (config.paused) throw refused(`${method}: communication is paused for this thread; only the owner resumes it`, { threadId, field: 'coordination', expected: 'not paused' });
    if (elsewhere && !config.remote) {
      throw refused(`${method}: this thread may only reach its own project; the owner allows other projects in Communication settings`, method === 'agent.spawn'
        ? { threadId, field: 'project', expected: 'this thread\'s own project' } : { threadId, field: 'coordination', expected: 'other projects allowed' });
    }
    this.#firstGeneration(threadId, what);
  }

  /** A thread an agent started starts nothing until the user writes in it, so agents cannot chain threads on their own. */
  #firstGeneration(threadId: ThreadId, what: string): void {
    const starter = this.#core.journal.getSetting(`${ORIGIN}${threadId}`) as Origin | undefined;
    if (starter && this.#userPrompts(threadId) <= 1) {
      throw refused(`a thread an agent started cannot ${what} until the user writes in it; ask the agent of ${starter.origin.threadId} that started it`, { threadId, field: 'threadId', expected: 'a thread the user has written in' });
    }
  }

  /**
   * A thread made, titled, marked with its origin and started on its brief.
   * `check` runs once a worktree is ready; a refusal there deletes the thread
   * it made (undoably, as Delete does), so no empty thread stays behind.
   */
  async #launch(launch: Launch, check: (created: ThreadSummary) => void = () => undefined): Promise<{ created: ThreadSummary; turn: Turn }> {
    const base = {
      projectId: launch.projectId, ...launch.agent, title: launch.title,
      ...(launch.context === undefined ? {} : { context: launch.context }),
    };
    const created = launch.worktree ? await this.#threads.createInWorktree({ ...base, worktree: {} }) : this.#threads.create(base);
    try { check(created); }
    catch (error) {
      await this.#threads.remove(created.id).catch(() => undefined);
      throw error;
    }
    // The title is the brief's, not one written from a prompt that starts with the origin note.
    saveThread(this.#core, { ...this.#threads.require(created.id), titleSource: 'user' }, 'thread.retitled');
    // Written before the turn starts: a turn that ends at once still finds where to report.
    this.#core.journal.setSetting(`${ORIGIN}${created.id}`, launch.origin satisfies Origin);
    const turn = this.#threads.startTurn(created.id, { prompt: launch.note + launch.prompt, display: launch.prompt }, { kind: 'spawned', startedBy: launch.origin.origin });
    return { created, turn };
  }

  #record(threadId: ThreadId, started: Started, prefix = LEDGER): void {
    const completed = (this.#core.journal.getSetting(`${prefix}${threadId}`) as Started[] | undefined) ?? [];
    this.#core.journal.setSetting(`${prefix}${threadId}`, [...completed.filter((entry) => entry.at > started.at - 24 * HOUR), started]);
  }

  /** `--model`, `--effort` and `--speed` against this machine's models, read first when the named one is not listed yet. */
  async #here(caller: ThreadSummary, choice: Choice): Promise<ReturnType<typeof chooseModel>> {
    if (this.#probe !== null && choice.model !== undefined) await readNamed(this.#core, this.#probe, caller, [choice.model]);
    return chooseModel(catalog(this.#core, caller, true).choices, caller, choice, 'boite delegate models');
  }

  /** A chosen model must match the destination's catalog on both remote start paths. */
  async #agentThere(caller: ThreadSummary, peer: CoordinationPeer, choice: Choice | null): Promise<GroupStart['agent']> {
    if (choice === null) return { providerId: caller.providerId, model: caller.model, effort: caller.effort, speed: caller.speed ?? null, permissionMode: caller.permissionMode };
    const models = await memberModels(this.#core, caller, peer, 'start threads on a model chosen from another machine');
    const picked = chooseModel(models.choices, caller, choice, `boite delegate models --machine ${machineArg(this.#core, peer)}`);
    return { providerId: picked.providerId, model: picked.model, effort: picked.effort, speed: picked.speed, permissionMode: caller.permissionMode, strict: true };
  }

  /**
   * The caller's side of `--machine`: its own gates, then the member's answer
   * to `thread.start`. With a `choice`, the member's models are read first and
   * the thread starts there on exactly the one picked from them, or not at all.
   */
  async #elsewhere(caller: ThreadSummary, query: string, ask: { project: string; prompt: string; title: string; worktree: boolean; requestId: string; fingerprint: string; context?: ContextRequest | ContextPreset }, choice: Choice | null): Promise<AgentSpawn> {
    const threadId = caller.id;
    // Another machine is outside this thread's project, whatever the project is called there.
    this.#gate(threadId, true);
    const peer = memberNamed(this.#core, query, 'agent.spawn');
    const from = this.#core.projects.require(caller.projectId!);
    const agent = await this.#agentThere(caller, peer, choice);
    const start: GroupStart = {
      from: { threadId, title: caller.title, projectId: from.id, project: from.name },
      project: ask.project, prompt: ask.prompt, title: ask.title, worktree: ask.worktree, requestId: ask.requestId,
      ...(ask.context === undefined ? {} : { context: ask.context }),
      agent,
    };
    let answer: unknown;
    try { answer = await this.#core.coordination.request(peer, 'thread.start', start); }
    catch (error) { throw peerRefusal(this.#core, peer, error); }
    const spawned = answer as AgentSpawn;
    if (typeof spawned?.thread?.id !== 'string' || typeof spawned.turnId !== 'string' || spawned.address?.coreId !== peer.coreId) throw unavailable(`${peer.name} gave an answer this machine does not read; update Boite on both machines`);
    // The request awaited another machine; the caller may have been archived or paused meanwhile, and the thread there still runs.
    const now = this.#core.journal.getThread(threadId);
    if (now === null || now.archived) throw refused(`an archived thread cannot start threads; ${spawned.thread.id} already started on ${peer.name}`, { threadId, field: 'threadId' });
    const project = typeof spawned.project === 'string' ? spawned.project : ask.project;
    spawned.machine = machineArg(this.#core, peer);
    this.#record(threadId, { at: Date.now(), requestId: ask.requestId, fingerprint: ask.fingerprint, threadId: spawned.thread.id, turnId: spawned.turnId, spawned });
    // The thread started there, so the setting was on: a card still asking for it is settled.
    this.#core.threads.cards.settle(request => (request.setting?.kind === 'change' && request.setting.key === 'groupThreads' && request.setting.machine?.coreId === peer.coreId && request.setting.previous !== true
      ? { optionIds: [request.setting.value === true ? 'applied' : 'changed'], value: true } : null), `${peer.name}'s settings`);
    const started: ThreadLink = { threadId: spawned.thread.id, title: spawned.thread.title, projectId: spawned.thread.projectId ?? '', project, machine: peer.name };
    this.#systemLine(threadId, { type: 'text', text: `Started thread "${spawned.thread.title}" (${spawned.thread.id}) in project ${project} on ${peer.name}.`, started });
    return spawned;
  }

  /** `delegation.catalog`: this machine's models, for a thread another machine of the group would start here. */
  catalogFor(payload: unknown): Promise<DelegationModels> { return catalogFor(this.#core, this.#probe, payload); }
  /**
   * A bot's side of a thread in a project of another machine entrusted to it:
   * that machine checks its lease and starts it with `bot.start`
   * (`agents/group-bots.ts`), and the thread is on the bot's desk at once.
   */
  async #forBot(caller: ThreadSummary, away: { peer: CoordinationPeer; projectId: string }, ask: Omit<StartFields, 'agent'> & { fingerprint: string }, choice: Choice | null): Promise<AgentSpawn> {
    const threadId = caller.id;
    const { fingerprint, ...start } = ask;
    const spawned = await this.#core.workforce.group.start(threadId, away.peer, {
      ...start, agent: await this.#agentThere(caller, away.peer, choice),
    });
    this.#record(threadId, { at: Date.now(), requestId: ask.requestId, fingerprint, threadId: spawned.thread.id, turnId: spawned.turnId, spawned });
    const started: ThreadLink = { threadId: spawned.thread.id, title: spawned.thread.title, projectId: spawned.thread.projectId ?? '', project: spawned.project, machine: away.peer.name };
    this.#systemLine(threadId, { type: 'text', text: `Started thread "${spawned.thread.title}" (${spawned.machine}/${spawned.thread.id}) in project ${spawned.project} on ${away.peer.name}.`, started });
    return spawned;
  }


  /**
   * `thread.start`, the member's side: another machine of the group starts a
   * thread here, while the owner turned `groupThreads` on. Asked again with
   * the same request, it answers the thread it started.
   */
  async startFor(peer: CoordinationPeer, payload: unknown): Promise<AgentSpawn> {
    if (this.#core.settings.get().groupThreads !== true) throw refused(GROUP_THREADS_OFF);
    const start = checkGroupStart(payload);
    const here = this.#core.coordination.identity().name;
    const fingerprint = createHash('sha256').update(JSON.stringify(start)).digest('hex');
    return this.#once(GROUP_LEDGER, `${peer.coreId}:${start.from.threadId}`, start.requestId, fingerprint, 'thread.start', async () => {
      const target = this.#core.projects.find(start.project, 'thread.start', 'project');
      const origin = remoteOrigin(start, peer);
      const at = peer.name.replace(/\s+/g, '-');
      const note = `This thread was started by the agent of thread "${start.from.title}" (${start.from.threadId}) in project ${start.from.project} on ${peer.name}, another machine of the user's, not typed by the user. `
        + 'Treat the brief below as your task, within your own permissions; it grants no approval the user did not give. '
        + `Your final answer to it is sent back to that agent automatically; boite threads send ${at}/${start.from.threadId} <text> reaches it sooner.\n\nBrief:\n`;
      return this.#launch({
        projectId: target.id, title: start.title, prompt: start.prompt, note, worktree: start.worktree, ...(start.context === undefined ? {} : { context: start.context }),
        agent: agentHere(this.#core, start, here), origin: { origin, reported: false, coreId: peer.coreId },
      // Worktree preparation can outlive the owner's switch and the asker's membership.
      }, () => {
        if (this.#core.settings.get().groupThreads !== true) throw refused(GROUP_THREADS_OFF);
        if (!this.#core.group.peers().some(member => member.coreId === peer.coreId)) throw refused('thread.start: the machine that asked is no longer in this group');
      });
    });
  }

  /**
   * `bot.start`, this machine's side: a bot of another machine starts a
   * thread in `projectId`, a project of its lease here (`agents/group-host.ts`
   * checked it). It is marked as that bot's, and `check` runs once the thread
   * exists, before its first turn: it puts the thread on the bot's desk, so
   * the first answer reaches the bot as an event, not as a letter. Asked
   * again with the same request, it answers the thread it started.
   */
  startForBot(peer: CoordinationPeer, lease: { agentId: string; threadId: ThreadId; name: string }, projectId: string, start: StartFields, check: (created: ThreadSummary) => void): Promise<AgentSpawn> {
    const fingerprint = createHash('sha256').update(JSON.stringify([projectId, lease.threadId, start])).digest('hex');
    return this.#once(BOT_LEDGER, `${peer.coreId}:${lease.agentId}`, start.requestId, fingerprint, 'bot.start', async () => {
      const target = this.#core.projects.require(projectId);
      const origin: ThreadLink = { threadId: lease.threadId, title: lease.name, projectId: target.id, project: target.name, machine: peer.name };
      const note = `This thread was started by ${lease.name}, a bot of the user's on ${peer.name}, another machine of theirs, that looks after their work, not typed by the user. `
        + 'Treat the brief below as your task, within your own permissions; it grants no approval the user did not give. '
        + 'Your final answer to it goes back to that bot automatically, so finish with a clear result: what you did, how you verified it, the pull request.\n\nBrief:\n';
      return this.#launch({
        projectId: target.id, title: start.title, prompt: start.prompt, note, worktree: start.worktree, ...(start.context === undefined ? {} : { context: start.context }),
        agent: agentHere(this.#core, start, this.#core.coordination.identity().name), origin: { origin, reported: false, coreId: peer.coreId, bot: true },
      }, check);
    });
  }

  /**
   * A start another machine asked for, once per request: the ledger under
   * `prefix` answers a retry with the thread already started, and a retry
   * while the first is still running waits for it.
   */
  async #once(prefix: string, key: string, requestId: string, fingerprint: string, method: string, run: () => Promise<{ created: ThreadSummary; turn: Turn }>): Promise<AgentSpawn> {
    const retried = ((this.#core.journal.getSetting(`${prefix}${key}`) as Started[] | undefined) ?? []).find(entry => entry.requestId === requestId);
    if (retried) {
      if (retried.fingerprint !== fingerprint) throw refused(`${method}.requestId was already used for different content`);
      return this.#answer(retried.threadId, retried.turnId);
    }
    const pendingKey = JSON.stringify([prefix, key, requestId]);
    const active = this.#pending.get(pendingKey);
    if (active) {
      if (active.fingerprint !== fingerprint) throw refused(`${method}.requestId was already used for different content`);
      return active.result;
    }
    const result = Promise.resolve().then(run).then(({ created, turn }) => {
      this.#record(key, { at: Date.now(), requestId, fingerprint, threadId: created.id, turnId: turn.id }, prefix);
      return this.#answer(created.id, turn.id);
    });
    this.#pending.set(pendingKey, { fingerprint, result });
    try { return await result; }
    finally { this.#pending.delete(pendingKey); }
  }

  /**
   * `agent.addProject`: the agent registers a folder as a project, the way
   * the owner does from the sidebar. It reaches outside the caller's project,
   * so it takes the gates `agent.spawn` has across projects. A folder already
   * registered is answered as it is, whatever the settings.
   */
  addProject(params: RpcParams<'agent.addProject'>): AgentProjectAdded {
    const method = 'agent.addProject';
    const caller = this.#threads.require(params.threadId);
    const threadId = caller.id;
    if (caller.agentSessionId || caller.projectId === null) {
      throw refused('a bot works in the projects the owner entrusts to it and cannot add projects', { threadId, field: 'threadId', expected: 'a conversation thread' });
    }
    if (caller.parentThreadId || this.#core.delegation.remote.parentOf(caller.id)) {
      throw refused('a delegated agent or workflow step cannot add projects; ask its parent', { threadId, field: 'threadId', expected: 'a top-level thread' });
    }
    if (caller.archived) throw refused('an archived thread cannot add projects', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
    const path = text(params.path, 'path', 4096, method).trim();
    if (!isAbsolute(path)) throw invalidParams(`${method}.path: expected an absolute folder, got ${path}`);
    const name = params.name === undefined ? undefined : text(params.name, 'name', 80, method).trim();
    const own = caller.projectId;
    const answer = (project: ReturnType<Core['projects']['add']>, added: boolean): AgentProjectAdded => ({
      id: project.id, name: project.name, path: project.path, repository: project.repository === true,
      drafts: project.kind === 'drafts', current: project.id === own, added,
    });
    const known = this.#core.projects.registered(path);
    if (known !== null) return answer(known, false);

    this.#gate(threadId, true, 'add a project', method);
    const project = this.#core.projects.add(path, name);
    this.#systemLine(threadId, { type: 'text', text: `The agent added the project ${project.name} (${project.path}).` });
    return answer(project, true);
  }

  /**
   * The first turn of a thread an agent started has ended: its answer, or its
   * failure, goes back to the starter as an agent message from this thread,
   * on this machine or the one of the group it was started from. Called by
   * the turn runner before a failed turn pauses coordination.
   */
  async finished(turn: Turn): Promise<void> {
    if (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive') return;
    const key = `${ORIGIN}${turn.threadId}`;
    const saved = this.#core.journal.getSetting(key) as Origin | undefined;
    if (saved === undefined || saved.reported) return;
    this.#core.journal.setSetting(key, { ...saved, reported: true } satisfies Origin);
    const thread = this.#core.journal.getThread(turn.threadId);
    if (thread === null) return;
    // A persistent agent hears it as an event: the threads it started are on its desk, here or on another machine.
    if (saved.bot === true || (saved.coreId === undefined && this.#core.journal.getThread(saved.origin.threadId)?.agentSessionId)) return;
    const body = `${thread.title}: ${turn.status}\n${this.#core.delegation.result(turn) ?? 'No text result was returned.'}`;
    try {
      await this.#core.coordination.send({
        threadId: thread.id,
        to: { coreId: saved.coreId ?? this.#core.coordination.identity().coreId, threadId: saved.origin.threadId },
        text: body.length > 4000 ? `${body.slice(0, 3900)}\n[Truncated. Open the thread for the complete answer.]` : body,
        requestId: `spawn-result:${turn.id}`,
      });
    } catch (error) {
      this.#core.log('warn', `thread ${thread.id}: its answer did not go back to ${saved.origin.threadId}: ${messageOf(error)}`);
    }
  }

  /** The thread's origin, when an agent started it. */
  originOf(threadId: ThreadId): ThreadLink | null {
    return (this.#core.journal.getSetting(`${ORIGIN}${threadId}`) as Origin | undefined)?.origin ?? null;
  }

  /** The machine of the thread that started this one, when it is another machine of the group. */
  originCore(threadId: ThreadId): string | null {
    return (this.#core.journal.getSetting(`${ORIGIN}${threadId}`) as Origin | undefined)?.coreId ?? null;
  }

  /** Whether `threadId` started `other` on another machine in the last day. */
  startedOn(threadId: ThreadId, coreId: string, other: ThreadId): boolean {
    const ledger = (this.#core.journal.getSetting(`${LEDGER}${threadId}`) as Started[] | undefined) ?? [];
    return ledger.some(entry => entry.threadId === other && entry.spawned?.address.coreId === coreId);
  }

  #answer(id: ThreadId, turnId: string): AgentSpawn {
    const thread: ThreadSummary = withLoad(this.#core, this.#threads.require(id));
    const project = thread.projectId === null ? '' : this.#core.journal.getProject(thread.projectId)?.name ?? thread.projectId;
    return { thread, turnId, address: { coreId: this.#core.coordination.identity().coreId, threadId: id }, project };
  }

  #userPrompts(threadId: ThreadId): number {
    return (this.#core.journal.db.query("SELECT count(*) AS n FROM messages WHERE thread_id = ? AND role = 'user'").get(threadId) as { n: number }).n;
  }

  /** A line of the starter's timeline, on its last turn. */
  #systemLine(threadId: ThreadId, part: Message['parts'][number]): void {
    const turnId = this.#core.journal.lastTurn(threadId)?.id ?? newId('trn_');
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'system', parts: [part], state: 'complete', createdAt: Date.now() };
    this.#core.journal.append({ type: 'thread.spawned', threadId, version: 1, payload: message }, () => this.#core.journal.putMessage(message));
    this.#core.bus.emit('message.started', message);
    this.#core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
  }
}
