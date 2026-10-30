/**
 * Teams of bots (`docs/teams.md`): a few bots and the owner in one group. The
 * team chat is a projectless thread that runs no agent; each post is one turn
 * there. A post addressed to a bot becomes a team letter in its inbox
 * (`TeamLetters.accept`, `coordination-team.ts`), rendered from what that bot has not seen
 * yet. Member keys are `<coreId>/<botId>`, so the rows fit members on other
 * machines; this version takes this machine's bots only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  routeTeamPost, teamMemberKey, teamPostVisible, TEAM_BRIEF_MAX, TEAM_MEMBERS_MAX, TEAM_NAME_MAX, TEAM_OWNER, TEAM_POST_MAX,
  type AgentLetter, type AgentProfile, type Message, type RequestId, type RpcParams, type Team, type TeamAsk, type TeamAudience,
  type TeamDelivery, type TeamMember, type TeamParty, type TeamPost, type TeamPostRef, type TeamReading, type ThreadSummary, type Turn,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, notFound, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import { finalText, quietText } from '../agents/runtime.ts';
import { RESIDENT_LETTER_TTL_MS } from '../coordination-letter.ts';
import { withLoad } from '../threads/records.ts';
import { planTeamLetter, teamPostLine, teamPrompt, type TeamChannel } from './prompt.ts';

type TeamRow = { id: string; host: string; version: number; thread_id: string; last_seq: number; data: string; created_at: number; updated_at: number };
type PostRow = {
  team_id: string; seq: number; id: string; fingerprint: string; author: string; text: string; audience: TeamAudience; to_keys: string;
  routed_by: TeamPost['routedBy']; why: string | null; in_reply_to: string | null; turn_id: string | null; notice: string | null; created_at: number;
};
type Stored = Pick<Team, 'name' | 'brief' | 'members' | 'dispatcher' | 'paused' | 'archived' | 'createdBy'>;

/** The letter states that keep a snapshot in flight; any other ends it. */
const IN_FLIGHT = new Set(['Queued for provider delivery', 'Awaiting provider acknowledgement']);
const inFlight = (error: string | null): boolean => error !== null && (IN_FLIGHT.has(error) || error.startsWith('Awaiting provider turn '));
const ACTIVE = new Set(['queued', 'running']);
const LATER = 'members on other machines come in a later version';

/** A final answer's post id: the same turn always gives the same id, so a retried publication posts once. */
export function answerPostId(turnId: string): string {
  const hash = createHash('sha256').update(`team-answer:${turnId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** What a batch's team letters read, and what changes with them. */
export interface TeamRendering {
  /** By letter id. */
  texts: Map<string, string>;
  /** Triggers that did not fit, by letter: each set goes to a new waiting letter. */
  leftovers: { letter: AgentLetter; seqs: number[]; owner: boolean }[];
  /** The one channel every team letter of the batch shares, when asked for one. */
  channel: TeamChannel | null;
}

export class TeamStore {
  readonly #core: Core;
  readonly #off: () => void;

  constructor(core: Core) {
    this.#core = core;
    this.#off = core.bus.onAny((name, payload) => {
      if (name !== 'turn.finished' || core.journal.isClosed()) return;
      const turn = payload as Turn;
      try { this.#finished(turn); } catch (error) { core.log('warn', `teams after turn ${turn.id}: ${messageOf(error)}`); }
      // An answer a failure left unpublished gets another try at each turn's end.
      this.#replayAnswers();
    });
  }

  close(): void { this.#off(); }

  /**
   * After a restart, what a stopped core left half done: snapshots of
   * letters nothing will settle any more are released, recipients whose
   * letter was never written get it, and finished answers are posted.
   */
  recover(): void {
    this.#releaseOrphans();
    this.#repair();
    this.#replayAnswers();
  }

  get #db() { return this.#core.journal.db; }
  get #self(): string { return this.#core.coordination.card().coreId; }

  /** Every team method and command refuses while the `teams` experiment is off. */
  gate(): void {
    const experiments = this.#core.clients.desktopExperiments() ?? this.#core.clients.current()?.experiments ?? [];
    if (!experiments.includes('teams')) throw refused('teams need the Teams experiment, which is off in the desktop app (Settings, Experiments)', { reason: 'experiment-off' });
  }

  // Teams.

  #team(row: TeamRow): Team {
    const stored = JSON.parse(row.data) as Stored;
    const members = stored.members.map(member => ({ ...member, name: this.#botName(member) }));
    return { id: row.id, host: row.host, version: row.version, ...stored, members, threadId: row.thread_id, lastSeq: row.last_seq, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  get(teamId: string): Team | null {
    const row = this.#db.query('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | null;
    return row ? this.#team(row) : null;
  }

  #require(teamId: unknown): Team {
    const team = typeof teamId === 'string' ? this.get(teamId) : null;
    if (!team) throw notFound(`teamId: no team ${JSON.stringify(teamId)}`, { field: 'teamId' });
    return team;
  }

  #all(): Team[] { return (this.#db.query('SELECT * FROM teams ORDER BY created_at').all() as TeamRow[]).map(row => this.#team(row)); }

  /** The team a bot names, by id or name, among the teams it belongs to; the owner names any. */
  #named(ref: unknown, member: TeamParty): Team {
    const wanted = typeof ref === 'string' ? ref.trim() : '';
    if (!wanted) throw invalidParams('team: expected a team name or id');
    const mine = this.#all().filter(team => member === TEAM_OWNER || team.members.some(entry => entry.key === member));
    const found = mine.find(team => team.id === wanted) ?? mine.filter(team => !team.archived && team.name.toLowerCase() === wanted.toLowerCase())[0];
    if (!found) throw refused(`team: no team ${JSON.stringify(wanted)}${member === TEAM_OWNER ? '' : ' you are a member of'}; yours: ${mine.filter(team => !team.archived).map(team => team.name).join(', ') || 'none'}`, { field: 'team' });
    return found;
  }

  #botName(member: Pick<TeamMember, 'coreId' | 'botId' | 'name'>): string {
    if (member.coreId !== this.#self) return member.name;
    return this.#core.workforce.records.find('profile', member.botId)?.name ?? member.name;
  }

  /** How a party reads in a prompt. */
  #name(team: Team, party: TeamParty): string {
    if (party === TEAM_OWNER) return 'owner';
    const member = team.members.find(entry => entry.key === party);
    if (member) return this.#botName(member);
    const botId = party.slice(party.indexOf('/') + 1);
    return this.#core.workforce.records.find('profile', botId)?.name ?? party;
  }

  #key(botId: string): TeamParty { return teamMemberKey(this.#self, botId); }

  /** A bot of this machine, by id or name. `<machine>/<bot>` waits for a later version. */
  #bot(ref: unknown, field = 'members'): AgentProfile {
    const wanted = typeof ref === 'string' ? ref.trim() : '';
    if (!wanted) throw invalidParams(`${field}: expected a bot name or id`);
    if (wanted.includes('/')) throw refused(LATER, { field });
    const live = this.#core.workforce.records.list('profile').filter(agent => agent.status !== 'archived');
    const byId = live.find(agent => agent.id === wanted);
    if (byId) return byId;
    const named = live.filter(agent => agent.name.toLowerCase() === wanted.toLowerCase());
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw refused(`${field}: ${named.length} bots are named ${JSON.stringify(wanted)}; name it by id: ${named.map(agent => agent.id).join(', ')}`, { field });
    throw refused(`${field}: no bot ${JSON.stringify(wanted)}; the bots are ${live.map(agent => agent.name).join(', ') || 'none yet'}`, { field });
  }

  /** The bot whose own thread calls. */
  #caller(threadId: unknown): AgentProfile {
    const bot = typeof threadId === 'string' ? this.#core.workforce.agentOfThread(threadId) : null;
    if (!bot) throw refused('threadId: teams are for bots; this thread is no bot\'s conversation', { field: 'threadId' });
    return bot;
  }

  /** A team the calling bot belongs to, and its key there. */
  #mine(threadId: unknown, ref: unknown): { team: Team; bot: AgentProfile; key: TeamParty } {
    const bot = this.#caller(threadId);
    const key = this.#key(bot.id);
    return { team: this.#named(ref, key), bot, key };
  }

  /** A member by bot id, or by a name no other member has. */
  #member(team: Team, ref: unknown, field: string): TeamMember {
    const wanted = typeof ref === 'string' ? ref.trim() : '';
    if (wanted.includes('/')) throw refused(LATER, { field });
    const named = team.members.filter(entry => entry.name.toLowerCase() === wanted.toLowerCase());
    const member = team.members.find(entry => entry.botId === wanted) ?? (named.length === 1 ? named[0] : undefined);
    if (member) return member;
    throw refused(named.length > 1 ? `${field}: ${named.length} members are named ${JSON.stringify(wanted)}; name one by id: ${named.map(entry => entry.botId).join(', ')}`
      : `${field}: ${JSON.stringify(wanted)} is no member of ${team.name}`, { field });
  }

  /** A member's own thread on this machine. */
  #threadOf(member: TeamMember): string | null {
    if (member.coreId !== this.#self) return null;
    try { return this.#core.workforce.open(member.botId).threadId; } catch { return null; }
  }

  #checkName(value: unknown, except?: string): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > TEAM_NAME_MAX) throw invalidParams(`name: expected 1 to ${TEAM_NAME_MAX} characters`);
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.startsWith('@')) throw invalidParams('name: a team name does not start with @');
    if (this.#all().some(team => !team.archived && team.id !== except && team.name.toLowerCase() === name.toLowerCase())) throw refused(`name: a team is already named ${JSON.stringify(name)}`, { field: 'name' });
    return name;
  }

  #checkBrief(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > TEAM_BRIEF_MAX) throw invalidParams(`brief: expected at most ${TEAM_BRIEF_MAX} characters`);
    return value.trim();
  }

  #bots(refs: unknown): AgentProfile[] {
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > TEAM_MEMBERS_MAX) throw invalidParams(`members: expected 1 to ${TEAM_MEMBERS_MAX} bots`);
    const bots = refs.map(ref => this.#bot(ref));
    return bots.filter((bot, index) => bots.findIndex(other => other.id === bot.id) === index);
  }

  #changed(team: Pick<Team, 'id' | 'version'>): void { this.#core.bus.emit('teams.changed', { teamId: team.id, version: team.version }); }

  /** Saves a change of the team: its version moves on, so a member on another machine can tell it apart. */
  #save(team: Team, change: Partial<Stored>): Team {
    const next: Team = { ...team, ...change, version: team.version + 1, updatedAt: Date.now() };
    const stored: Stored = { name: next.name, brief: next.brief, members: next.members, dispatcher: next.dispatcher, paused: next.paused, archived: next.archived, createdBy: next.createdBy };
    this.#core.journal.append({ type: 'teams.saved', threadId: team.threadId, version: 1, payload: { teamId: team.id, version: next.version, ...stored } }, db => {
      const saved = db.query('UPDATE teams SET version = ?, data = ?, updated_at = ? WHERE id = ? AND version = ?').run(next.version, JSON.stringify(stored), next.updatedAt, team.id, team.version);
      if (saved.changes !== 1) throw refused(`${team.name} changed meanwhile; read it again`, { field: 'teamId' });
    });
    this.#changed(next);
    return this.get(team.id)!;
  }

  list(params: RpcParams<'teams.list'> = {}): Team[] {
    this.gate();
    const member = params.threadId === undefined ? TEAM_OWNER : this.#key(this.#caller(params.threadId).id);
    return this.#all().filter(team => (params.archived === true || !team.archived) && (member === TEAM_OWNER || team.members.some(entry => entry.key === member)));
  }

  create(params: RpcParams<'teams.create'>): Team {
    this.gate();
    const ask = params.card === undefined ? null : this.#card(params.card, 'create');
    const name = this.#checkName(params.name);
    const brief = this.#checkBrief(params.brief);
    const bots = this.#bots(params.members);
    const id = randomUUID();
    const now = Date.now();
    const cwd = join(this.#core.dataDir, 'teams', id);
    mkdirSync(cwd, { recursive: true });
    const first = bots[0]!;
    const thread: ThreadSummary = {
      id: newId('thr_'), projectId: null, teamId: id, title: name, titleSource: 'user', ...first.selection, speed: null, cwd, branch: null,
      status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, createdAt: now, updatedAt: now,
    };
    const stored: Stored = {
      name, brief, members: bots.map(bot => ({ key: this.#key(bot.id), coreId: this.#self, botId: bot.id, name: bot.name, joinedSeq: 0 })),
      dispatcher: null, paused: false, archived: false, createdBy: ask === null ? TEAM_OWNER : this.#key(ask.by),
    };
    this.#core.journal.append({ type: 'thread.created', threadId: thread.id, version: 1, payload: thread }, db => {
      this.#core.journal.putThread(thread);
      db.query('INSERT INTO teams (id, host, version, thread_id, last_seq, data, created_at, updated_at) VALUES (?, ?, 1, ?, 0, ?, ?, ?)').run(id, this.#self, thread.id, JSON.stringify(stored), now, now);
    });
    this.#core.bus.emit('thread.created', withLoad(this.#core, thread));
    const team = this.get(id)!;
    this.#changed(team);
    if (params.card !== undefined) this.#settle(params.card, `applied: the team ${JSON.stringify(name)} exists, with ${team.members.map(member => member.name).join(', ')}`);
    return team;
  }

  update(params: RpcParams<'teams.update'>): Team {
    this.gate();
    const team = this.#require(params.teamId);
    const change: Partial<Stored> = {};
    if (params.name !== undefined) change.name = this.#checkName(params.name, team.id);
    if (params.brief !== undefined) change.brief = this.#checkBrief(params.brief);
    const saved = this.#save(team, change);
    if (change.name !== undefined && change.name !== team.name) {
      const thread = this.#core.threads.require(team.threadId);
      const renamed = { ...thread, title: change.name, updatedAt: Date.now() };
      this.#core.journal.append({ type: 'thread.updated', threadId: thread.id, version: 1, payload: renamed }, () => this.#core.journal.putThread(renamed));
      this.#core.bus.emit('thread.updated', withLoad(this.#core, renamed));
    }
    return saved;
  }

  archive(params: RpcParams<'teams.archive'>): Team {
    this.gate();
    const team = this.#require(params.teamId);
    if (typeof params.archived !== 'boolean') throw invalidParams('archived: expected a boolean');
    if (team.archived === params.archived) return team;
    const saved = this.#save(team, { archived: params.archived });
    if (params.archived) this.#core.coordination.teamLetters.reject(team.id, null, `The team ${team.name} was archived`);
    else this.#kickMembers(saved);
    return saved;
  }

  pause(params: RpcParams<'teams.pause'>): Team {
    this.gate();
    const team = this.#require(params.teamId);
    if (typeof params.paused !== 'boolean') throw invalidParams('paused: expected a boolean');
    if (team.paused === params.paused) return team;
    const saved = this.#save(team, { paused: params.paused });
    // Resumed: the letters it held go now, not at the next sweep.
    if (!params.paused) this.#kickMembers(saved);
    return saved;
  }

  #kickMembers(team: Team): void {
    for (const member of team.members) {
      const threadId = this.#threadOf(member);
      if (threadId !== null) this.#core.coordination.teamLetters.kick(threadId);
    }
  }

  addMember(params: RpcParams<'teams.members.add'>): Team {
    this.gate();
    const team = this.#require(params.teamId);
    const ask = params.card === undefined ? null : this.#card(params.card, 'invite');
    if (ask !== null && ask.kind === 'invite' && ask.teamId !== team.id) throw refused(`card: it asks about another team, ${ask.teamName}`, { field: 'card' });
    const bot = this.#bot(params.botId, 'botId');
    if (team.archived) throw refused(`${team.name} is archived`, { field: 'teamId' });
    if (team.members.some(member => member.botId === bot.id)) throw refused(`${bot.name} is already a member of ${team.name}`, { field: 'botId' });
    if (team.members.length >= TEAM_MEMBERS_MAX) throw refused(`a team holds at most ${TEAM_MEMBERS_MAX} bots`, { field: 'botId' });
    // A new member starts reading after the posts already there; `boite team read` shows the older ones.
    const saved = this.#save(team, { members: [...team.members, { key: this.#key(bot.id), coreId: this.#self, botId: bot.id, name: bot.name, joinedSeq: team.lastSeq }] });
    if (params.card !== undefined) this.#settle(params.card, `applied: ${bot.name} joined ${team.name}`);
    return saved;
  }

  removeMember(params: RpcParams<'teams.members.remove'>): Team {
    this.gate();
    const team = this.#require(params.teamId);
    const ask = params.card === undefined ? null : this.#card(params.card, 'leave');
    if (ask !== null && ask.kind === 'leave' && ask.teamId !== team.id) throw refused(`card: it asks about another team, ${ask.teamName}`, { field: 'card' });
    const member = this.#member(team, params.botId, 'botId');
    const saved = this.#save(team, { members: team.members.filter(entry => entry.key !== member.key) });
    const threadId = this.#threadOf(member);
    const reason = `${member.name} left the team ${team.name}`;
    if (threadId !== null) this.#core.coordination.teamLetters.reject(team.id, threadId, reason);
    this.#core.journal.append({ type: 'teams.member.removed', threadId: team.threadId, version: 1, payload: { teamId: team.id, member: member.key } }, db => {
      // A post interrupted before its letter has none to reject: its delivery ends with the membership too.
      db.query("UPDATE team_deliveries SET state = 'rejected', reason = ?, at = ? WHERE member = ? AND state = 'waiting' AND post_id IN (SELECT id FROM team_posts WHERE team_id = ?)")
        .run(reason, Date.now(), member.key, team.id);
      db.query('DELETE FROM team_cursors WHERE team_id = ? AND member = ?').run(team.id, member.key);
      db.query('DELETE FROM team_seen WHERE team_id = ? AND member = ?').run(team.id, member.key);
    });
    if (params.card !== undefined) this.#settle(params.card, `applied: ${member.name} left ${team.name}`);
    return saved;
  }

  // Posts.

  #toPost(row: PostRow): TeamPost {
    return {
      id: row.id, teamId: row.team_id, seq: row.seq, author: row.author, text: row.text, audience: row.audience, to: JSON.parse(row.to_keys) as TeamParty[],
      routedBy: row.routed_by, why: row.why, inReplyTo: row.in_reply_to, turnId: row.turn_id, fingerprint: row.fingerprint, createdAt: row.created_at,
      ...(row.notice === null ? {} : { notice: row.notice }),
    };
  }

  #postAt(teamId: string, seq: number): TeamPost | null {
    const row = this.#db.query('SELECT * FROM team_posts WHERE team_id = ? AND seq = ?').get(teamId, seq) as PostRow | null;
    return row ? this.#toPost(row) : null;
  }

  #postById(id: string): TeamPost | null {
    const row = this.#db.query('SELECT * FROM team_posts WHERE id = ?').get(id) as PostRow | null;
    return row ? this.#toPost(row) : null;
  }

  /**
   * One post: kept once by its id, ordered, routed (`routeTeamPost`), shown in
   * the team chat as a turn of its own, then handed to each recipient bot as a
   * team letter. A retry with the same id and content returns the first post.
   */
  #post(team: Team, input: { id: unknown; author: TeamParty; text: unknown; audience: TeamAudience; to?: TeamParty[]; inReplyTo?: unknown; turnId?: string | null }): TeamPost {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id || id.length > 100) throw invalidParams('id: expected 1 to 100 characters');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > TEAM_POST_MAX) throw invalidParams(`text: expected 1 to ${TEAM_POST_MAX} characters`);
    const inReplyTo = input.inReplyTo === undefined || input.inReplyTo === null ? null : String(input.inReplyTo);
    const to = input.audience === 'private' ? [...new Set(input.to ?? [])] : [...new Set(input.to ?? [])].sort();
    const fingerprint = createHash('sha256').update(JSON.stringify([input.author, input.audience, to, text, inReplyTo])).digest('hex');
    const known = this.#postById(id);
    if (known) {
      if (known.teamId !== team.id || known.fingerprint !== fingerprint) throw refused('id: already used for a different post', { field: 'id' });
      // A retry after an interruption hands over the letters the first try did not.
      this.#repair(known.id);
      return known;
    }
    if (team.archived) throw refused(`${team.name} is archived`, { field: 'team' });
    let replied: TeamPost | null = null;
    if (inReplyTo !== null) {
      replied = this.#postById(inReplyTo);
      if (!replied || replied.teamId !== team.id || !teamPostVisible(replied, input.author)) throw refused('inReplyTo: no post of this team you may read', { field: 'inReplyTo' });
    }
    if (input.audience === 'private') {
      const recipient = to[0];
      if (to.length !== 1 || recipient === undefined) throw invalidParams('to: a private post has exactly one recipient');
      if (recipient === input.author) throw refused('to: a private post goes to someone else', { field: 'to' });
      if (recipient !== TEAM_OWNER && !team.members.some(member => member.key === recipient)) throw refused('to: the recipient is no member of the team', { field: 'to' });
    }
    const routing = routeTeamPost(team, { author: input.author, text, audience: input.audience, to, inReplyTo }, replied?.author ?? null);
    const now = Date.now();
    const thread = this.#core.threads.require(team.threadId);
    const turn: Turn = {
      id: newId('trn_'), threadId: thread.id, status: 'done', queuedAt: now, startedAt: now, finishedAt: now, usage: null, error: null,
      execution: { providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort, speed: null, permissionMode: thread.permissionMode, sessionId: null, sessionGeneration: 0, selectionVersion: 0 },
    };
    let post: TeamPost | null = null;
    let message: Message | null = null;
    let chat: ThreadSummary | null = null;
    this.#core.journal.append({ type: 'teams.posted', threadId: thread.id, version: 1, payload: { teamId: team.id, id, author: input.author } }, db => {
      const seq = (db.query('SELECT last_seq FROM teams WHERE id = ?').get(team.id) as { last_seq: number }).last_seq + 1;
      post = {
        id, teamId: team.id, seq, author: input.author, text, audience: input.audience, to: input.audience === 'private' ? to : routing.to, routedBy: routing.routedBy,
        why: null, inReplyTo, turnId: input.turnId ?? null, fingerprint, createdAt: now, ...(routing.notice ? { notice: routing.notice } : {}),
      };
      db.query(`INSERT INTO team_posts (team_id, seq, id, fingerprint, author, text, audience, to_keys, routed_by, why, in_reply_to, turn_id, notice, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`).run(team.id, seq, id, fingerprint, input.author, text, input.audience, JSON.stringify(post.to), post.routedBy, inReplyTo, post.turnId, routing.notice ?? null, now);
      db.query('UPDATE teams SET last_seq = ? WHERE id = ?').run(seq, team.id);
      for (const recipient of post.to) {
        if (recipient !== TEAM_OWNER) db.query('INSERT OR REPLACE INTO team_deliveries (post_id, member, state, reason, letter_id, at) VALUES (?, ?, ?, ?, NULL, ?)').run(id, recipient, 'waiting', null, now);
      }
      const ref: TeamPostRef = { id, teamId: team.id, seq, author: post.author, audience: post.audience, to: post.to, routedBy: post.routedBy, inReplyTo, ...(post.notice ? { notice: post.notice } : {}) };
      message = { id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: input.author === TEAM_OWNER ? 'user' : 'assistant', parts: [{ type: 'text', text, teamPost: ref }], state: 'complete', createdAt: now };
      this.#core.journal.putTurn(turn);
      this.#core.journal.putMessage(message);
      // A bot's post is news in the team chat, as a finished turn is in a thread; the owner's own is not.
      chat = { ...thread, updatedAt: now, unread: input.author === TEAM_OWNER ? thread.unread : thread.unread || !this.#core.subscribers.hasSubscribers(thread.id) };
      this.#core.journal.putThread(chat);
    });
    this.#core.bus.emit('message.started', message!);
    this.#core.bus.emit('message.completed', { threadId: thread.id, messageId: message!.id, state: 'complete' });
    this.#core.bus.emit('thread.updated', withLoad(this.#core, chat!));
    const saved = post as unknown as TeamPost;
    // A private post to the owner reaches the owner's devices; group posts wait in the chat.
    if (saved.audience === 'private' && saved.to[0] === TEAM_OWNER) this.#core.push.teamPost(thread.id, `${this.#name(team, saved.author)}: ${text}`, `team-post-${saved.id}`);
    this.#changed(team);
    this.#hand(team, saved);
    return saved;
  }

  /** Each recipient's letter. */
  #hand(team: Team, post: TeamPost): void {
    for (const recipient of post.to) {
      const member = team.members.find(entry => entry.key === recipient);
      const threadId = member ? this.#threadOf(member) : null;
      if (threadId !== null) this.#accept(team, threadId, post.seq, post.author === TEAM_OWNER);
    }
  }

  /** The post stands: a letter that fails is logged and its delivery stays `waiting` until a retried id or the next start repairs it (`#repair`). */
  #accept(team: Team, threadId: string, seq: number, owner: boolean): void {
    try { this.#core.coordination.teamLetters.accept(team, threadId, seq, owner); } catch (error) { this.#core.log('warn', `teams letter of #${seq} in ${team.id}: ${messageOf(error)}`); }
  }

  /**
   * A post committed before its letters: a recipient still `waiting` with no
   * letter of that team carrying the post gets one now. Letters live six
   * hours, so older posts are left as they are, and so is a post from before
   * the member's current membership.
   */
  #repair(postId?: string): void {
    const rows = this.#db.query(`SELECT p.team_id, p.seq, p.author, d.member FROM team_deliveries d JOIN team_posts p ON p.id = d.post_id
      WHERE d.state = 'waiting' AND d.at > ? AND (? IS NULL OR d.post_id = ?) ORDER BY p.team_id, p.seq`).all(Date.now() - RESIDENT_LETTER_TTL_MS, postId ?? null, postId ?? null) as { team_id: string; seq: number; author: string; member: string }[];
    for (const row of rows) {
      const team = this.get(row.team_id);
      const member = team?.archived === false ? team.members.find(entry => entry.key === row.member) : undefined;
      const threadId = member ? this.#threadOf(member) : null;
      if (!team || !member || threadId === null || row.seq <= member.joinedSeq) continue;
      const carried = this.#db.query(`SELECT 1 FROM coordination_letters l, json_each(l.data, '$.team.triggers') t WHERE l.thread_id = ? AND l.direction = 'in'
        AND l.status IN ('received', 'uncertain') AND json_extract(l.data, '$.team.teamId') = ? AND t.value = ? LIMIT 1`).get(threadId, team.id, row.seq);
      if (!carried) this.#accept(team, threadId, row.seq, row.author === TEAM_OWNER);
    }
  }

  /** The owner's post. `to` lists bot ids: the composer's recipients, or the one reader of a private post. */
  ownerPost(params: RpcParams<'teams.post'>): TeamPost {
    this.gate();
    const team = this.#require(params.teamId);
    const audience = params.audience ?? 'team';
    if (audience !== 'team' && audience !== 'private') throw invalidParams('audience: expected team or private');
    const to = (params.to ?? []).map(ref => this.#member(team, ref, 'to').key);
    return this.#post(team, { id: params.id, author: TEAM_OWNER, text: params.text, audience, to, inReplyTo: params.inReplyTo });
  }

  /** `boite team say`: a group post from the bot's own thread. */
  say(params: RpcParams<'teams.say'>): TeamPost {
    this.gate();
    const { team, key } = this.#mine(params.threadId, params.team);
    return this.#post(team, { id: params.id ?? randomUUID(), author: key, text: params.text, audience: 'team', inReplyTo: params.inReplyTo, turnId: this.#core.journal.runningTurn(params.threadId)?.id ?? null });
  }

  /** `boite team dm`: a private post to one member or the owner. */
  dm(params: RpcParams<'teams.dm'>): TeamPost {
    this.gate();
    const { team, key } = this.#mine(params.threadId, params.team);
    const wanted = typeof params.to === 'string' ? params.to.trim() : '';
    if (!wanted) throw invalidParams('to: expected a member or owner');
    const recipient = wanted.toLowerCase() === TEAM_OWNER ? TEAM_OWNER : this.#member(team, wanted, 'to').key;
    return this.#post(team, { id: params.id ?? randomUUID(), author: key, text: params.text, audience: 'private', to: [recipient], turnId: this.#core.journal.runningTurn(params.threadId)?.id ?? null });
  }

  /** Posts before `before`, the newest page, oldest first; a bot reads only what it may see. */
  read(params: RpcParams<'teams.read'>): TeamReading {
    this.gate();
    const reader = params.threadId === undefined ? TEAM_OWNER : this.#key(this.#caller(params.threadId).id);
    const team = this.#named(params.team, reader);
    const limit = params.limit === undefined ? 30 : params.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidParams('limit: expected 1 to 100');
    const before = params.before === undefined ? Number.MAX_SAFE_INTEGER : params.before;
    if (!Number.isSafeInteger(before) || before < 1) throw invalidParams('before: expected a post number');
    const posts: TeamPost[] = [];
    let more = false;
    const statement = this.#db.prepare('SELECT * FROM team_posts WHERE team_id = ? AND seq < ? ORDER BY seq DESC');
    try {
      for (const row of statement.iterate(team.id, before) as Iterable<PostRow>) {
        const post = this.#toPost(row);
        if (!teamPostVisible(post, reader)) continue;
        if (posts.length === limit) { more = true; break; }
        posts.push(post);
      }
    } finally { statement.finalize(); }
    posts.reverse();
    const deliveries = reader !== TEAM_OWNER || posts.length === 0 ? [] : (this.#db.query('SELECT post_id, member, state, reason, at FROM team_deliveries WHERE post_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(posts.map(post => post.id))) as { post_id: string; member: string; state: TeamDelivery['state']; reason: string | null; at: number }[])
      .map(row => ({ postId: row.post_id, member: row.member, state: row.state, reason: row.reason, at: row.at }));
    return { team, posts, deliveries, more };
  }

  // Cards: a bot never creates or joins a team by itself.

  #card(card: RequestId, kind: TeamAsk['kind']): TeamAsk {
    const ask = this.#core.threads.listQuestions().find(request => request.id === card)?.team;
    if (ask === undefined || ask.kind !== kind) throw notFound(`card: ${String(card)} is no open team ${kind} card`, { field: 'card' });
    return ask;
  }

  #settle(card: RequestId, text: string): void {
    this.#core.threads.cards.settle(request => (request.id === card ? { optionIds: [], text } : null), 'the owner');
  }

  #draw(threadId: string, text: string, team: TeamAsk): { questionId: RequestId } {
    const thread = this.#core.threads.require(threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId });
    if (this.#core.threads.listQuestions(threadId).some(request => request.team !== undefined && JSON.stringify(request.team) === JSON.stringify(team))) {
      throw refused('the same card is already open in this thread; the owner has not answered it yet', { field: 'card' });
    }
    return this.#core.threads.cards.drawAsync(thread, { text, options: [{ id: 'refuse', label: 'Refuse' }], allowText: false, multiple: false, async: true, team });
  }

  propose(params: RpcParams<'teams.propose'>): { questionId: RequestId } {
    this.gate();
    const bot = this.#caller(params.threadId);
    const name = this.#checkName(params.name);
    const brief = this.#checkBrief(params.brief);
    const others = this.#bots(params.members).filter(other => other.id !== bot.id);
    if (others.length === 0) throw invalidParams('members: name at least one other bot');
    const members = [bot, ...others];
    const text = `${bot.name} proposes the team ${JSON.stringify(name)}: ${members.map(member => member.name).join(', ')}.${brief ? ` ${brief}` : ''}`;
    return this.#draw(params.threadId, text, { kind: 'create', by: bot.id, name, brief, members: members.map(member => member.id) });
  }

  invite(params: RpcParams<'teams.invite'>): { questionId: RequestId } {
    this.gate();
    const { team, bot } = this.#mine(params.threadId, params.team);
    const guest = this.#bot(params.bot, 'bot');
    if (team.members.some(member => member.botId === guest.id)) throw refused(`${guest.name} is already a member of ${team.name}`, { field: 'bot' });
    return this.#draw(params.threadId, `${bot.name} asks to add ${guest.name} to the team ${JSON.stringify(team.name)}.`, { kind: 'invite', by: bot.id, teamId: team.id, teamName: team.name, botId: guest.id });
  }

  leave(params: RpcParams<'teams.leave'>): { questionId: RequestId } {
    this.gate();
    const { team, bot } = this.#mine(params.threadId, params.team);
    return this.#draw(params.threadId, `${bot.name} asks to leave the team ${JSON.stringify(team.name)}.`, { kind: 'leave', by: bot.id, teamId: team.id, teamName: team.name, botId: bot.id });
  }

  // Delivery (`Coordination`): every path asks these, inside its own transaction.

  /** A team letter may reach its bot now: the team stands here, runs, and keeps the bot; a bot's letter also waits while bots are held. */
  mayReceive(letter: AgentLetter): boolean {
    const ref = letter.team;
    if (ref === undefined) return false;
    const team = this.get(ref.teamId);
    if (!team || team.host !== this.#self || team.paused || team.archived) return false;
    const bot = this.#core.workforce.agentOfThread(letter.to.threadId);
    if (!bot || !team.members.some(member => member.key === this.#key(bot.id))) return false;
    return ref.owner || !this.#core.agentRuntime.holds(letter.to.threadId);
  }

  #low(team: Team, member: TeamMember): number {
    const row = this.#db.query('SELECT low FROM team_cursors WHERE team_id = ? AND member = ?').get(team.id, member.key) as { low: number } | null;
    return Math.max(row?.low ?? 0, member.joinedSeq);
  }

  /**
   * Moves the member's cursor up across seen posts and posts it may not
   * read, so a private post between two others never pins it.
   */
  #fold(team: Team, member: TeamMember): void {
    let low = this.#low(team, member);
    const start = low;
    const seen = new Set((this.#db.query("SELECT seq FROM team_seen WHERE team_id = ? AND member = ? AND state = 'seen'").all(team.id, member.key) as { seq: number }[]).map(row => row.seq));
    const last = (this.#db.query('SELECT last_seq FROM teams WHERE id = ?').get(team.id) as { last_seq: number }).last_seq;
    while (low < last) {
      const next = low + 1;
      if (!seen.has(next)) {
        const post = this.#postAt(team.id, next);
        if (post !== null && teamPostVisible(post, member.key) && post.author !== member.key) break;
      }
      low = next;
    }
    if (low === start) return;
    this.#db.query('INSERT INTO team_cursors (team_id, member, low) VALUES (?, ?, ?) ON CONFLICT (team_id, member) DO UPDATE SET low = excluded.low').run(team.id, member.key, low);
    this.#db.query('DELETE FROM team_seen WHERE team_id = ? AND member = ? AND seq <= ?').run(team.id, member.key, low);
  }

  /**
   * Freezes the snapshot of each team letter of a batch: its triggers, whole,
   * oldest first, then what the bot may read above its cursor that is neither
   * seen nor held by another snapshot in flight. `seen` (hook, waiter) marks
   * them read now; `flight` (steer, wake) until the letter is settled.
   * `reply` asks for the one channel a wake's final answer goes to.
   */
  render(threadId: string, letters: AgentLetter[], mode: 'seen' | 'flight', reply: boolean): TeamRendering {
    const rendering: TeamRendering = { texts: new Map(), leftovers: [], channel: null };
    const bot = this.#core.workforce.agentOfThread(threadId);
    if (letters.length === 0 || !bot) return rendering;
    const you = this.#key(bot.id);
    const planned = letters.map(letter => {
      const team = this.get(letter.team!.teamId)!;
      const member = team.members.find(entry => entry.key === you)!;
      const low = this.#low(team, member);
      const triggers = letter.team!.triggers.map(seq => this.#postAt(team.id, seq)).filter((post): post is TeamPost => post !== null);
      const newest = Math.max(0, ...triggers.map(post => post.seq));
      const trigger = new Set(triggers.map(post => post.seq));
      const held = new Set((this.#db.query('SELECT seq FROM team_seen WHERE team_id = ? AND member = ?').all(team.id, you) as { seq: number }[]).map(row => row.seq));
      const context = (this.#db.query('SELECT * FROM team_posts WHERE team_id = ? AND seq > ? AND seq <= ? ORDER BY seq').all(team.id, low, newest) as PostRow[])
        .map(row => this.#toPost(row)).filter(post => !trigger.has(post.seq) && !held.has(post.seq) && post.author !== you && teamPostVisible(post, you));
      const name = (party: TeamParty) => this.#name(team, party);
      const plan = planTeamLetter(triggers, context, (post, isTrigger) => teamPostLine(post, you, name, isTrigger));
      return { letter, team, member, plan, name };
    });
    if (reply) rendering.channel = this.#channel(planned.map(entry => ({ teamId: entry.team.id, triggers: entry.plan.triggers })));
    for (const { letter, team, member, plan, name } of planned) {
      const owner = (posts: TeamPost[]) => posts.some(post => post.author === TEAM_OWNER);
      if (plan.leftover.length > 0) {
        rendering.leftovers.push({ letter, seqs: plan.leftover.map(post => post.seq), owner: owner(plan.leftover) });
        letter.team = { ...letter.team!, triggers: plan.triggers.map(post => post.seq), owner: owner(plan.triggers) };
      }
      rendering.texts.set(letter.id, teamPrompt({ team: team.name, you, plan, channel: rendering.channel, name }));
      const seqs = [...plan.triggers, ...plan.context, ...plan.omitted].map(post => post.seq);
      const low = this.#low(team, member);
      for (const seq of seqs.filter(seq => seq > low)) {
        if (mode === 'seen') this.#db.query("INSERT INTO team_seen (team_id, member, seq, state, letter_id) VALUES (?, ?, ?, 'seen', NULL) ON CONFLICT (team_id, member, seq) DO UPDATE SET state = 'seen', letter_id = NULL").run(team.id, you, seq);
        // A post another snapshot holds stays its: whichever settles first decides, so it can come twice, never zero times.
        else this.#db.query("INSERT INTO team_seen (team_id, member, seq, state, letter_id) VALUES (?, ?, ?, 'flight', ?) ON CONFLICT (team_id, member, seq) DO NOTHING").run(team.id, you, seq, letter.id);
      }
      if (mode === 'seen') this.#fold(team, member);
    }
    return rendering;
  }

  /** The one channel of a wake: one team, and the group or one private author. */
  #channel(entries: { teamId: string; triggers: TeamPost[] }[]): TeamChannel | null {
    const teams = new Set(entries.map(entry => entry.teamId));
    const posts = entries.flatMap(entry => entry.triggers).sort((a, b) => a.seq - b.seq);
    const newest = posts.at(-1);
    if (teams.size !== 1 || newest === undefined) return null;
    const teamId = newest.teamId;
    if (posts.every(post => post.audience === 'team')) return { teamId, audience: 'team', recipient: null, inReplyTo: newest.id };
    const authors = new Set(posts.map(post => post.author));
    if (posts.every(post => post.audience === 'private') && authors.size === 1) return { teamId, audience: 'private', recipient: newest.author, inReplyTo: newest.id };
    return null;
  }

  /** The reply envelope of an accepted wake, never changed after: where its final answer goes. */
  envelope(turnId: string, threadId: string, channel: TeamChannel): void {
    this.#db.query('INSERT OR IGNORE INTO team_replies (turn_id, thread_id, team_id, audience, recipient, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(turnId, threadId, channel.teamId, channel.audience, channel.recipient, channel.inReplyTo, Date.now());
  }

  /**
   * A team letter changed state, in the same transaction: delivered marks its
   * snapshot seen; back in the inbox, refused, expired or failed releases it,
   * so the next delivery renders those posts again.
   */
  letterChanged(letter: AgentLetter): void {
    const ref = letter.team;
    if (ref === undefined) return;
    if (letter.status === 'uncertain' && inFlight(letter.error)) return;
    const team = this.get(ref.teamId);
    const bot = this.#core.workforce.agentOfThread(letter.to.threadId);
    const member = team && bot ? team.members.find(entry => entry.key === this.#key(bot.id)) : undefined;
    if (letter.status === 'delivered') this.#db.query("UPDATE team_seen SET state = 'seen', letter_id = NULL WHERE letter_id = ? AND state = 'flight'").run(letter.id);
    else this.#db.query("DELETE FROM team_seen WHERE letter_id = ? AND state = 'flight'").run(letter.id);
    if (team && member && letter.status === 'delivered') this.#fold(team, member);
    const state = letter.status === 'delivered' ? 'delivered' : letter.status === 'rejected' ? 'rejected' : letter.status === 'expired' ? 'expired' : null;
    if (team && bot && state !== null) {
      for (const seq of ref.triggers) {
        const post = this.#postAt(team.id, seq);
        if (post) this.#db.query('UPDATE team_deliveries SET state = ?, reason = ?, letter_id = ?, at = ? WHERE post_id = ? AND member = ?').run(state, state === 'delivered' ? null : letter.error, letter.id, Date.now(), post.id, this.#key(bot.id));
      }
    }
  }

  /** A team wake that settled without reaching its provider's answer: its snapshot is released, its letter stays as it is. */
  #release(turn: Turn): void {
    const letters = this.#db.query("SELECT id FROM coordination_letters WHERE thread_id = ? AND direction = 'in' AND status = 'uncertain' AND json_extract(data, '$.error') = ? AND json_extract(data, '$.team') IS NOT NULL")
      .all(turn.threadId, `Awaiting provider turn ${turn.id}`) as { id: string }[];
    if (letters.length === 0) return;
    this.#core.journal.append({ type: 'teams.released', threadId: turn.threadId, version: 1, payload: { turnId: turn.id, letters: letters.map(row => row.id) } }, db => {
      for (const { id } of letters) db.query("DELETE FROM team_seen WHERE letter_id = ? AND state = 'flight'").run(id);
    });
  }

  /**
   * Snapshots in flight whose letter nothing will settle: gone, settled, a
   * steer that no provider acknowledged before a restart, or a wake whose
   * turn ended. The letter stays as it is; its posts render again.
   */
  #releaseOrphans(): void {
    const rows = this.#db.query(`SELECT DISTINCT s.letter_id AS id, l.status, json_extract(l.data, '$.error') AS error FROM team_seen s
      LEFT JOIN coordination_letters l ON l.id = s.letter_id WHERE s.state = 'flight'`).all() as { id: string; status: string | null; error: string | null }[];
    const orphans = rows.filter(row => {
      if (row.status !== 'uncertain' || row.error === null) return true;
      if (row.error === 'Queued for provider delivery') return false;
      const turnId = row.error.startsWith('Awaiting provider turn ') ? row.error.slice('Awaiting provider turn '.length) : null;
      return turnId === null || !ACTIVE.has(this.#core.journal.getTurn(turnId)?.status ?? '');
    }).map(row => row.id);
    if (orphans.length === 0) return;
    this.#core.journal.append({ type: 'teams.released', threadId: null, version: 1, payload: { letters: orphans } }, db => {
      for (const id of orphans) db.query("DELETE FROM team_seen WHERE letter_id = ? AND state = 'flight'").run(id);
    });
  }

  /** Envelopes whose turn ended and whose answer was not posted yet: done ones post it, the others have none. */
  #replayAnswers(): void {
    if (this.#core.journal.isClosed()) return;
    const pending = this.#db.query('SELECT r.turn_id, r.thread_id, t.status FROM team_replies r LEFT JOIN turns t ON t.id = r.turn_id WHERE r.published = 0').all() as { turn_id: string; thread_id: string; status: string | null }[];
    for (const row of pending) {
      if (row.status !== null && ACTIVE.has(row.status)) continue;
      try {
        if (row.status === 'done') this.publishAnswer({ id: row.turn_id, threadId: row.thread_id });
        else this.#db.query('UPDATE team_replies SET published = 1 WHERE turn_id = ?').run(row.turn_id);
      } catch (error) { this.#core.log('warn', `teams answer of ${row.turn_id}: ${messageOf(error)}`); }
    }
  }

  #finished(turn: Turn): void {
    if (turn.execution?.operation !== 'coordination') return;
    if (turn.status !== 'done') { this.#release(turn); return; }
    this.publishAnswer(turn);
  }

  /**
   * A team wake's final answer, posted on its envelope's channel with an id
   * the turn gives, so a retry posts once. `[quiet]` posts nothing; a turn
   * without an envelope never posts to a team.
   */
  publishAnswer(turn: Pick<Turn, 'id' | 'threadId'>): TeamPost | null {
    const envelope = this.#db.query('SELECT * FROM team_replies WHERE turn_id = ?').get(turn.id) as { thread_id: string; team_id: string; audience: TeamAudience; recipient: string | null; in_reply_to: string | null } | null;
    if (envelope === null) return null;
    const post = this.#answer(turn, envelope);
    // Posted, or nothing to post: a later start does not try again.
    this.#db.query('UPDATE team_replies SET published = 1 WHERE turn_id = ?').run(turn.id);
    return post;
  }

  #answer(turn: Pick<Turn, 'id' | 'threadId'>, envelope: { thread_id: string; team_id: string; audience: TeamAudience; recipient: string | null; in_reply_to: string | null }): TeamPost | null {
    const team = this.get(envelope.team_id);
    const bot = this.#core.workforce.agentOfThread(envelope.thread_id);
    if (!team || team.archived || !bot || !team.members.some(member => member.botId === bot.id)) return null;
    if (envelope.recipient !== null && envelope.recipient !== TEAM_OWNER && !team.members.some(member => member.key === envelope.recipient)) return null;
    const text = finalText(this.#core, turn);
    if (!text || quietText(text)) return null;
    return this.#post(team, {
      id: answerPostId(turn.id), author: this.#key(bot.id), text: text.slice(0, TEAM_POST_MAX), audience: envelope.audience,
      ...(envelope.recipient === null ? {} : { to: [envelope.recipient] }), inReplyTo: envelope.in_reply_to, turnId: turn.id,
    });
  }
}
