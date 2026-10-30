/**
 * Teams of bots, as `packages/core/src/teams/store.ts` keeps them: the same
 * checks, routing and visibility, posts in a team chat that runs no agent.
 * Nothing is delivered here: a post's bot recipients stay `waiting`.
 */
import {
  RpcErrorCode,
  routeTeamPost,
  teamMemberKey,
  teamPostVisible,
  TEAM_BRIEF_MAX,
  TEAM_MEMBERS_MAX,
  TEAM_NAME_MAX,
  TEAM_OWNER,
  TEAM_POST_MAX,
  type AgentProfile,
  type Team,
  type TeamAsk,
  type TeamAudience,
  type TeamDelivery,
  type TeamParty,
  type TeamPost,
  type TeamPostRef,
  type Thread,
  type Turn
} from '@boite/contracts';
import { RpcFailure } from '../client';
import { DATA_DIR } from './shared';
import { askTeam } from './requests';
import type { FakeContext, FakeMethods } from './context';

const LATER = 'members on other machines come in a later version';
const refused = (message: string, data: Record<string, unknown> = {}) => new RpcFailure({ code: RpcErrorCode.Refused, message, data });
const invalid = (message: string) => new RpcFailure({ code: RpcErrorCode.InvalidParams, message });

interface TeamState { teams: Map<string, Team>; posts: Map<string, TeamPost[]>; deliveries: TeamDelivery[] }
const states = new WeakMap<FakeContext, TeamState>();
function state(ctx: FakeContext): TeamState {
  let found = states.get(ctx);
  if (!found) states.set(ctx, found = { teams: new Map(), posts: new Map(), deliveries: [] });
  return found;
}

type TeamMethods = Pick<FakeMethods, `teams.${string}` & keyof FakeMethods>;

/** What would reach a provider on a thread: a team chat runs no agent, so each refuses there, as `requireAgent` (`packages/core/src/threads/agentless.ts`) does. */
const AGENT_METHODS = ['turns.start', 'turns.steer', 'turns.recover', 'threads.retitle', 'threads.compact', 'threads.rewind', 'threads.fork', 'threads.move',
  'threads.btw', 'threads.btw.fork', 'threads.update', 'threads.goal.track', 'threads.activity.set'] as const;

/** `methods` with each of `AGENT_METHODS` refusing a team chat first. */
export function refuseTeamChats(ctx: FakeContext, methods: FakeMethods): FakeMethods {
  for (const name of AGENT_METHODS) {
    const answer = methods[name] as (params: { threadId: string }, ...rest: unknown[]) => Promise<unknown>;
    // Not async: an extra tick before the method would let a running fake turn end first.
    (methods as Record<string, unknown>)[name] = (params: { threadId: string }, ...rest: unknown[]) => {
      if (ctx.threads.get(params.threadId)?.teamId) return Promise.reject(refused('a team chat runs no agent; post to it through teams.post', { threadId: params.threadId }));
      return answer(params, ...rest);
    };
  }
  return methods;
}

export function teamMethods(ctx: FakeContext): TeamMethods {
  const self = () => ctx.identity.coreId;
  const key = (botId: string) => teamMemberKey(self(), botId);
  const gate = () => {
    const experiments = ctx.desktopExperiments ?? ctx.clientPreferences?.experiments ?? [];
    if (!experiments.includes('teams')) throw refused('teams need the Teams experiment, which is off in the desktop app (Settings, Experiments)', { reason: 'experiment-off' });
  };
  const all = () => [...state(ctx).teams.values()];
  const changed = (team: Team) => ctx.emit('teams.changed', { teamId: team.id, version: team.version });
  const save = (team: Team, change: Partial<Team>): Team => {
    const next = { ...team, ...change, version: team.version + 1, updatedAt: ctx.now() };
    state(ctx).teams.set(team.id, next);
    changed(next);
    return structuredClone(next);
  };
  const require = (teamId: unknown): Team => {
    const team = typeof teamId === 'string' ? state(ctx).teams.get(teamId) : undefined;
    if (!team) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `teamId: no team ${JSON.stringify(teamId)}`, data: { field: 'teamId' } });
    return team;
  };
  const bot = (ref: unknown, field = 'members'): AgentProfile => {
    const wanted = typeof ref === 'string' ? ref.trim() : '';
    if (!wanted) throw invalid(`${field}: expected a bot name or id`);
    if (wanted.includes('/')) throw refused(LATER, { field });
    const live = ctx.agents.liveProfiles();
    const named = live.filter(agent => agent.name.toLowerCase() === wanted.toLowerCase());
    const found = live.find(agent => agent.id === wanted) ?? (named.length === 1 ? named[0] : undefined);
    if (!found) throw refused(`${field}: no bot ${JSON.stringify(wanted)}`, { field });
    return found;
  };
  const bots = (refs: unknown): AgentProfile[] => {
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > TEAM_MEMBERS_MAX) throw invalid(`members: expected 1 to ${TEAM_MEMBERS_MAX} bots`);
    const found = refs.map(ref => bot(ref));
    return found.filter((entry, index) => found.findIndex(other => other.id === entry.id) === index);
  };
  const checkName = (value: unknown, except?: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > TEAM_NAME_MAX) throw invalid(`name: expected 1 to ${TEAM_NAME_MAX} characters`);
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.startsWith('@')) throw invalid('name: a team name does not start with @');
    if (all().some(team => !team.archived && team.id !== except && team.name.toLowerCase() === name.toLowerCase())) throw refused(`name: a team is already named ${JSON.stringify(name)}`, { field: 'name' });
    return name;
  };
  const checkBrief = (value: unknown): string => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > TEAM_BRIEF_MAX) throw invalid(`brief: expected at most ${TEAM_BRIEF_MAX} characters`);
    return value.trim();
  };
  const caller = (threadId: unknown): AgentProfile => {
    const found = ctx.agents.liveProfiles().find(agent => typeof threadId === 'string' && ctx.agents.conversationOf(agent.id) === threadId);
    if (!found) throw refused('threadId: teams are for bots; this thread is no bot\'s conversation', { field: 'threadId' });
    return found;
  };
  const named = (ref: unknown, member: TeamParty): Team => {
    const wanted = typeof ref === 'string' ? ref.trim() : '';
    if (!wanted) throw invalid('team: expected a team name or id');
    const mine = all().filter(team => member === TEAM_OWNER || team.members.some(entry => entry.key === member));
    const found = mine.find(team => team.id === wanted) ?? mine.find(team => !team.archived && team.name.toLowerCase() === wanted.toLowerCase());
    if (!found) throw refused(`team: no team ${JSON.stringify(wanted)}`, { field: 'team' });
    return found;
  };
  const mine = (threadId: unknown, ref: unknown) => {
    const agent = caller(threadId);
    return { agent, member: key(agent.id), team: named(ref, key(agent.id)) };
  };
  const card = (id: unknown, kind: TeamAsk['kind']): TeamAsk => {
    const ask = typeof id === 'string' ? ctx.pendingQuestions.get(id)?.request.team : undefined;
    if (ask === undefined || ask.kind !== kind) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `card: ${String(id)} is no open team ${kind} card`, data: { field: 'card' } });
    return ask;
  };
  const settle = (id: string | undefined, text: string) => {
    if (id === undefined) return;
    const pending = ctx.pendingQuestions.get(id);
    ctx.pendingQuestions.delete(id);
    pending?.resolve({ optionIds: [], text });
  };
  const draw = (threadId: string, text: string, team: TeamAsk) => {
    const thread = ctx.thread(threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId });
    const turn = thread.turns.find(entry => entry.status === 'running') ?? thread.turns.at(-1);
    if (!turn) throw refused('the thread has no turn to ask in yet', { threadId });
    if ([...ctx.pendingQuestions.values()].some(pending => pending.request.threadId === threadId && JSON.stringify(pending.request.team) === JSON.stringify(team))) {
      throw refused('the same card is already open in this thread; the owner has not answered it yet', { field: 'card' });
    }
    return { questionId: askTeam(ctx, thread, turn, text, team) };
  };

  /** One post: kept once by its id, routed, and shown in the team chat as a turn of its own. */
  const post = (team: Team, input: { id: unknown; author: TeamParty; text: unknown; audience: TeamAudience; to?: TeamParty[]; inReplyTo?: unknown }): TeamPost => {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id || id.length > 100) throw invalid('id: expected 1 to 100 characters');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > TEAM_POST_MAX) throw invalid(`text: expected 1 to ${TEAM_POST_MAX} characters`);
    const inReplyTo = input.inReplyTo === undefined || input.inReplyTo === null ? null : String(input.inReplyTo);
    const to = input.audience === 'private' ? [...new Set(input.to ?? [])] : [...new Set(input.to ?? [])].sort();
    const fingerprint = JSON.stringify([input.author, input.audience, to, text, inReplyTo]);
    const posts = [...state(ctx).posts.values()].flat();
    const known = posts.find(entry => entry.id === id);
    if (known) {
      if (known.teamId !== team.id || known.fingerprint !== fingerprint) throw refused('id: already used for a different post', { field: 'id' });
      return structuredClone(known);
    }
    if (team.archived) throw refused(`${team.name} is archived`, { field: 'team' });
    const replied = inReplyTo === null ? null : posts.find(entry => entry.id === inReplyTo) ?? null;
    if (inReplyTo !== null && (!replied || replied.teamId !== team.id || !teamPostVisible(replied, input.author))) throw refused('inReplyTo: no post of this team you may read', { field: 'inReplyTo' });
    if (input.audience === 'private') {
      const recipient = to[0];
      if (to.length !== 1 || recipient === undefined) throw invalid('to: a private post has exactly one recipient');
      if (recipient === input.author) throw refused('to: a private post goes to someone else', { field: 'to' });
      if (recipient !== TEAM_OWNER && !team.members.some(member => member.key === recipient)) throw refused('to: the recipient is no member of the team', { field: 'to' });
    }
    const routing = routeTeamPost(team, { author: input.author, text, audience: input.audience, to, inReplyTo }, replied?.author ?? null);
    const now = ctx.now();
    const seq = team.lastSeq + 1;
    const saved: TeamPost = {
      id, teamId: team.id, seq, author: input.author, text, audience: input.audience, to: input.audience === 'private' ? to : routing.to, routedBy: routing.routedBy,
      why: null, inReplyTo, turnId: null, fingerprint, createdAt: now, ...(routing.notice ? { notice: routing.notice } : {})
    };
    state(ctx).posts.set(team.id, [...(state(ctx).posts.get(team.id) ?? []), saved]);
    state(ctx).teams.set(team.id, { ...team, lastSeq: seq });
    for (const recipient of saved.to) if (recipient !== TEAM_OWNER) state(ctx).deliveries.push({ postId: id, member: recipient, state: 'waiting', reason: null, at: now });
    const thread = ctx.thread(team.threadId);
    const turn: Turn = { id: `turn-team-${++ctx.seq}`, threadId: thread.id, status: 'done', queuedAt: now, startedAt: now, finishedAt: now, usage: null, error: null };
    const ref: TeamPostRef = { id, teamId: team.id, seq, author: saved.author, audience: saved.audience, to: saved.to, routedBy: saved.routedBy, inReplyTo, ...(saved.notice ? { notice: saved.notice } : {}) };
    const message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: input.author === TEAM_OWNER ? 'user' as const : 'assistant' as const, parts: [{ type: 'text' as const, text, teamPost: ref }], state: 'complete' as const, createdAt: now };
    thread.turns.push(turn);
    thread.messages.push(message);
    ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
    ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    // A bot's post is news in the team chat, as the core marks it; the owner's own is not.
    if (input.author !== TEAM_OWNER) thread.unread ||= !ctx.bus.subscribed.has(thread.id);
    ctx.touch(thread);
    changed(state(ctx).teams.get(team.id)!);
    return structuredClone(saved);
  };
  /** A member by bot id, or by a name no other member has. */
  const member = (team: Team, ref: unknown, field = 'to') => {
    const wanted = typeof ref === 'string' ? ref.trim() : '';
    if (wanted.includes('/')) throw refused(LATER, { field });
    const named = team.members.filter(entry => entry.name.toLowerCase() === wanted.toLowerCase());
    const found = team.members.find(entry => entry.botId === wanted) ?? (named.length === 1 ? named[0] : undefined);
    if (found) return found;
    throw refused(named.length > 1 ? `${field}: ${named.length} members are named ${JSON.stringify(wanted)}; name one by id: ${named.map(entry => entry.botId).join(', ')}`
      : `${field}: ${JSON.stringify(wanted)} is no member of ${team.name}`, { field });
  };

  return {
    'teams.list': async (params) => {
      gate();
      const reader = params?.threadId === undefined ? TEAM_OWNER : key(caller(params.threadId).id);
      return { teams: structuredClone(all().filter(team => (params?.archived === true || !team.archived) && (reader === TEAM_OWNER || team.members.some(entry => entry.key === reader)))) };
    },
    'teams.create': async (params) => {
      gate();
      const ask = params.card === undefined ? null : card(params.card, 'create');
      const name = checkName(params.name);
      const brief = checkBrief(params.brief);
      const members = bots(params.members);
      const id = `team-${++ctx.seq}`;
      const now = ctx.now();
      const first = members[0]!;
      const thread: Thread = { id: `t-${++ctx.seq}`, projectId: null, teamId: id, ...first.selection, title: name, titleSource: 'user', speed: null, cwd: `${DATA_DIR}/teams/${id}`, branch: null,
        status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null,
        createdAt: now, updatedAt: now, messages: [], messagesBefore: null, turns: [], commands: [] };
      ctx.threads.set(thread.id, thread);
      ctx.touch(thread);
      const team: Team = {
        id, host: self(), version: 1, name, brief, members: members.map(entry => ({ key: key(entry.id), coreId: self(), botId: entry.id, name: entry.name, joinedSeq: 0 })),
        dispatcher: null, paused: false, archived: false, createdBy: ask === null ? TEAM_OWNER : key(ask.by), threadId: thread.id, lastSeq: 0, createdAt: now, updatedAt: now
      };
      state(ctx).teams.set(id, team);
      changed(team);
      settle(params.card, `applied: the team ${JSON.stringify(name)} exists, with ${team.members.map(entry => entry.name).join(', ')}`);
      return structuredClone(team);
    },
    'teams.update': async (params) => {
      gate();
      const team = require(params.teamId);
      const change: Partial<Team> = {};
      if (params.name !== undefined) change.name = checkName(params.name, team.id);
      if (params.brief !== undefined) change.brief = checkBrief(params.brief);
      const saved = save(team, change);
      if (change.name !== undefined) { const thread = ctx.thread(team.threadId); thread.title = change.name; ctx.touch(thread); }
      return saved;
    },
    'teams.archive': async (params) => {
      gate();
      const team = require(params.teamId);
      if (typeof params.archived !== 'boolean') throw invalid('archived: expected a boolean');
      return team.archived === params.archived ? structuredClone(team) : save(team, { archived: params.archived });
    },
    'teams.pause': async (params) => {
      gate();
      const team = require(params.teamId);
      if (typeof params.paused !== 'boolean') throw invalid('paused: expected a boolean');
      return team.paused === params.paused ? structuredClone(team) : save(team, { paused: params.paused });
    },
    'teams.members.add': async (params) => {
      gate();
      const team = require(params.teamId);
      const ask = params.card === undefined ? null : card(params.card, 'invite');
      if (ask !== null && ask.kind === 'invite' && ask.teamId !== team.id) throw refused(`card: it asks about another team, ${ask.teamName}`, { field: 'card' });
      const agent = bot(params.botId, 'botId');
      if (team.archived) throw refused(`${team.name} is archived`, { field: 'teamId' });
      if (team.members.some(entry => entry.botId === agent.id)) throw refused(`${agent.name} is already a member of ${team.name}`, { field: 'botId' });
      if (team.members.length >= TEAM_MEMBERS_MAX) throw refused(`a team holds at most ${TEAM_MEMBERS_MAX} bots`, { field: 'botId' });
      const saved = save(team, { members: [...team.members, { key: key(agent.id), coreId: self(), botId: agent.id, name: agent.name, joinedSeq: team.lastSeq }] });
      settle(params.card, `applied: ${agent.name} joined ${team.name}`);
      return saved;
    },
    'teams.members.remove': async (params) => {
      gate();
      const team = require(params.teamId);
      const ask = params.card === undefined ? null : card(params.card, 'leave');
      if (ask !== null && ask.kind === 'leave' && ask.teamId !== team.id) throw refused(`card: it asks about another team, ${ask.teamName}`, { field: 'card' });
      const leaving = member(team, params.botId, 'botId');
      const saved = save(team, { members: team.members.filter(entry => entry.key !== leaving.key) });
      settle(params.card, `applied: ${leaving.name} left ${team.name}`);
      return saved;
    },
    'teams.post': async (params) => {
      gate();
      const team = require(params.teamId);
      const audience = params.audience ?? 'team';
      if (audience !== 'team' && audience !== 'private') throw invalid('audience: expected team or private');
      const to = (params.to ?? []).map(ref => member(team, ref).key);
      return post(team, { id: params.id, author: TEAM_OWNER, text: params.text, audience, to, inReplyTo: params.inReplyTo });
    },
    'teams.read': async (params) => {
      gate();
      const reader = params.threadId === undefined ? TEAM_OWNER : key(caller(params.threadId).id);
      const team = named(params.team, reader);
      const limit = params.limit ?? 30;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('limit: expected 1 to 100');
      const before = params.before ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(before) || before < 1) throw invalid('before: expected a post number');
      const visible = (state(ctx).posts.get(team.id) ?? []).filter(entry => entry.seq < before && teamPostVisible(entry, reader));
      const posts = visible.slice(-limit);
      const ids = new Set(posts.map(entry => entry.id));
      const deliveries = reader === TEAM_OWNER ? state(ctx).deliveries.filter(entry => ids.has(entry.postId)) : [];
      return structuredClone({ team, posts, deliveries, more: visible.length > posts.length });
    },
    'teams.say': async (params) => {
      gate();
      const { team, member: author } = mine(params.threadId, params.team);
      return post(team, { id: params.id ?? `post-${++ctx.seq}`, author, text: params.text, audience: 'team', inReplyTo: params.inReplyTo });
    },
    'teams.dm': async (params) => {
      gate();
      const { team, member: author } = mine(params.threadId, params.team);
      const wanted = typeof params.to === 'string' ? params.to.trim() : '';
      if (!wanted) throw invalid('to: expected a member or owner');
      const recipient = wanted.toLowerCase() === TEAM_OWNER ? TEAM_OWNER : member(team, wanted).key;
      return post(team, { id: params.id ?? `post-${++ctx.seq}`, author, text: params.text, audience: 'private', to: [recipient] });
    },
    'teams.propose': async (params) => {
      gate();
      const agent = caller(params.threadId);
      const name = checkName(params.name);
      const brief = checkBrief(params.brief);
      const others = bots(params.members).filter(other => other.id !== agent.id);
      if (others.length === 0) throw invalid('members: name at least one other bot');
      const members = [agent, ...others];
      return draw(params.threadId, `${agent.name} proposes the team ${JSON.stringify(name)}: ${members.map(entry => entry.name).join(', ')}.${brief ? ` ${brief}` : ''}`,
        { kind: 'create', by: agent.id, name, brief, members: members.map(entry => entry.id) });
    },
    'teams.invite': async (params) => {
      gate();
      const { team, agent } = mine(params.threadId, params.team);
      const guest = bot(params.bot, 'bot');
      if (team.members.some(entry => entry.botId === guest.id)) throw refused(`${guest.name} is already a member of ${team.name}`, { field: 'bot' });
      return draw(params.threadId, `${agent.name} asks to add ${guest.name} to the team ${JSON.stringify(team.name)}.`, { kind: 'invite', by: agent.id, teamId: team.id, teamName: team.name, botId: guest.id });
    },
    'teams.leave': async (params) => {
      gate();
      const { team, agent } = mine(params.threadId, params.team);
      return draw(params.threadId, `${agent.name} asks to leave the team ${JSON.stringify(team.name)}.`, { kind: 'leave', by: agent.id, teamId: team.id, teamName: team.name, botId: agent.id });
    }
  };
}
