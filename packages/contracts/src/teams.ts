import type { RequestId, ThreadId, Timestamp, TurnId } from './ids';

/**
 * Teams of bots (`docs/teams.md`): a few bots and the owner talk in one
 * group, each bot from its own thread. A member is keyed by the core it runs
 * on and its bot id, `<coreId>/<botId>`, so a key reads the same on every
 * machine of the group. The owner is `owner`.
 */
export type TeamMemberKey = string;
/** Who writes or receives a post: a member, or the owner. */
export type TeamParty = TeamMemberKey | 'owner';
export const TEAM_OWNER = 'owner';

export const TEAM_NAME_MAX = 60;
export const TEAM_BRIEF_MAX = 1000;
/** Bots in one team. */
export const TEAM_MEMBERS_MAX = 12;
/** A post holds what an agent letter holds. */
export const TEAM_POST_MAX = 4000;
/** What one team letter renders, in UTF-8 bytes, triggers and context together. */
export const TEAM_LETTER_BYTES = 16_384;
/** Team letters one hook, steer or wake hands over; the others wait for the next batch. */
export const TEAM_LETTERS_PER_BATCH = 2;

export function teamMemberKey(coreId: string, botId: string): TeamMemberKey { return `${coreId}/${botId}`; }

export interface TeamMember {
  key: TeamMemberKey;
  coreId: string;
  botId: string;
  /** The bot's current name; the last one known once it is gone or on another machine. Mentions match it. */
  name: string;
  /** The seq the bot joined at: it starts reading after it. */
  joinedSeq: number;
}

export interface Team {
  id: string;
  /** The core that orders the team's posts. */
  host: string;
  /** Bumped by every change of name, brief, members, dispatcher, pause or archive. */
  version: number;
  name: string;
  brief: string;
  members: TeamMember[];
  /** Who routes an owner post nobody was named in: null is Automatic, `off`, or a route. Unused until the dispatcher ships. */
  dispatcher: string | null;
  paused: boolean;
  archived: boolean;
  /** The owner, or the bot whose proposal the owner accepted. */
  createdBy: TeamParty;
  /** The team chat: a projectless thread that runs no agent and holds every post. */
  threadId: ThreadId;
  /** The last post's seq, 0 before the first. */
  lastSeq: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** `team`: every member reads it. `private`: one recipient, a bot or the owner, and the owner. */
export type TeamAudience = 'team' | 'private';
/** Which routing rule picked the recipients (`docs/teams.md`). */
export type TeamRoute = 'mention' | 'everyone' | 'reply' | 'single' | 'dispatcher' | 'private' | 'none';

export interface TeamPost {
  /** Picked by its writer before the first send: a retry with it returns the same post. A bot post sent without one gets a fresh id. */
  id: string;
  teamId: string;
  /** The host's order in the team, from 1. */
  seq: number;
  author: TeamParty;
  text: string;
  audience: TeamAudience;
  /** Who it wakes; the one recipient of a private post. Never its author. */
  to: TeamParty[];
  routedBy: TeamRoute;
  /** The dispatcher's reason, once there is one. */
  why: string | null;
  inReplyTo: string | null;
  /** The bot turn that wrote it. */
  turnId: TurnId | null;
  /** Of author, audience, to, text and inReplyTo: a reused id with other content is refused. */
  fingerprint: string;
  createdAt: Timestamp;
  /** Why the post woke nobody, for the owner. */
  notice?: string;
}

/** What a post's text part carries in the team chat. */
export type TeamPostRef = Pick<TeamPost, 'id' | 'seq' | 'author' | 'audience' | 'to' | 'routedBy' | 'inReplyTo'> & { teamId: string; notice?: string };

export type TeamDeliveryState = 'waiting' | 'delivered' | 'held' | 'expired' | 'rejected' | 'unreachable';
/** Where a post stands for one recipient: the chip under it. */
export interface TeamDelivery {
  postId: string;
  member: TeamMemberKey;
  state: TeamDeliveryState;
  reason: string | null;
  at: Timestamp;
}

/** A bot's proposal, drawn as a card in its thread; the owner's Apply is the matching owner method with `card`. */
export type TeamAsk =
  | { kind: 'create'; by: string; name: string; brief: string; members: string[] }
  | { kind: 'invite'; by: string; teamId: string; teamName: string; botId: string }
  | { kind: 'leave'; by: string; teamId: string; teamName: string; botId: string };

/** Who a post reached, and why: every rule leaves its author out. */
export interface TeamRouting { to: TeamParty[]; routedBy: TeamRoute; notice?: string }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The members a text names with `@name`, case-insensitive, a name ending at a non-word character. */
export function teamMentions(text: string, members: readonly Pick<TeamMember, 'key' | 'name'>[]): TeamMemberKey[] {
  return members.filter(member => member.name.trim() !== '' && new RegExp(`(^|[^\\p{L}\\p{N}_])@${escape(member.name.trim())}(?![\\p{L}\\p{N}_-])`, 'iu').test(text)).map(member => member.key);
}

/** `@tous` or `@everyone`. */
export function mentionsEveryone(text: string): boolean { return /(^|[^\p{L}\p{N}_])@(tous|everyone)(?![\p{L}\p{N}_-])/iu.test(text); }

/** An owner post nobody was named in, until the dispatcher replaces this one function: it wakes nobody and says so. */
export function ownerFallback(): TeamRouting {
  return { to: [], routedBy: 'none', notice: 'Nobody was pinged: name a bot with @name, or everyone with @tous.' };
}

/**
 * The first rule that applies (`docs/teams.md`, Routing): a private post to
 * its recipient; mentions, `@tous` or the recipients the composer picked; a
 * reply to its post's author; an owner post in a team of one bot to that bot;
 * otherwise an owner post to `ownerFallback` and a bot post to nobody.
 */
export function routeTeamPost(
  team: Pick<Team, 'members'>,
  post: { author: TeamParty; text: string; audience: TeamAudience; to?: readonly TeamParty[]; inReplyTo?: string | null },
  repliedAuthor: TeamParty | null,
): TeamRouting {
  const others = (keys: readonly TeamParty[]) => [...new Set(keys)].filter(key => key !== post.author);
  if (post.audience === 'private') return { to: others(post.to ?? []).slice(0, 1), routedBy: 'private' };
  const members = team.members.map(member => member.key);
  if (mentionsEveryone(post.text)) return { to: others(members), routedBy: 'everyone' };
  const named = [...teamMentions(post.text, team.members), ...(post.to ?? []).filter(key => members.includes(key))];
  if (named.length > 0) return { to: others(named), routedBy: 'mention' };
  if (post.inReplyTo && repliedAuthor !== null) return { to: others([repliedAuthor]), routedBy: 'reply' };
  if (post.author === TEAM_OWNER && members.length === 1) return { to: others(members), routedBy: 'single' };
  return post.author === TEAM_OWNER ? ownerFallback() : { to: [], routedBy: 'none' };
}

/** What a member may read: group posts, and private posts it wrote or received. The owner reads all. */
export function teamPostVisible(post: Pick<TeamPost, 'audience' | 'author' | 'to'>, reader: TeamParty): boolean {
  return reader === TEAM_OWNER || post.audience === 'team' || post.author === reader || post.to.includes(reader);
}

export interface TeamReading {
  team: Team;
  /** Oldest first. */
  posts: TeamPost[];
  /** The owner's view only: where each addressed post stands per recipient. */
  deliveries: TeamDelivery[];
  /** Older posts remain before the first one. */
  more: boolean;
}

export interface TeamsRpcMethods {
  /** The owner's teams, or the teams the calling bot's thread belongs to. Refused while the `teams` experiment is off. */
  'teams.list': { params: { threadId?: ThreadId; archived?: boolean }; result: { teams: Team[] } };
  /** `members` are bot ids of this machine. `card` applies a bot's proposal card and settles it. */
  'teams.create': { params: { name: string; brief?: string; members: string[]; card?: RequestId }; result: Team };
  'teams.update': { params: { teamId: string; name?: string; brief?: string }; result: Team };
  /** Archived, a team takes no post and its waiting letters are rejected. */
  'teams.archive': { params: { teamId: string; archived: boolean }; result: Team };
  'teams.members.add': { params: { teamId: string; botId: string; card?: RequestId }; result: Team };
  /** The bot's waiting letters of this team are rejected. */
  'teams.members.remove': { params: { teamId: string; botId: string; card?: RequestId }; result: Team };
  /** Paused, letters wait; resumed, they go. */
  'teams.pause': { params: { teamId: string; paused: boolean }; result: Team };
  /** The owner's post. `to` lists bot ids: the composer's recipients, or the one recipient of a private post. */
  'teams.post': { params: { teamId: string; id: string; text: string; audience?: TeamAudience; to?: string[]; inReplyTo?: string }; result: TeamPost };
  /** Posts before `before` (a seq), newest page first returned oldest first. A bot reads only what it may see. */
  'teams.read': { params: { threadId?: ThreadId; team: string; before?: number; limit?: number }; result: TeamReading };
  /** A bot's group post (`boite team say`). In every bot method, `team` is a team name or id. */
  'teams.say': { params: { threadId: ThreadId; team: string; text: string; id?: string; inReplyTo?: string }; result: TeamPost };
  /** A bot's private post (`boite team dm`): `to` is a member's bot name or id, or `owner`. */
  'teams.dm': { params: { threadId: ThreadId; team: string; to: string; text: string; id?: string }; result: TeamPost };
  /** A bot proposes a team: a card in its thread the owner applies or refuses. */
  'teams.propose': { params: { threadId: ThreadId; name: string; members: string[]; brief?: string }; result: { questionId: RequestId } };
  /** `bot` is a bot name or id of this machine. */
  'teams.invite': { params: { threadId: ThreadId; team: string; bot: string }; result: { questionId: RequestId } };
  'teams.leave': { params: { threadId: ThreadId; team: string }; result: { questionId: RequestId } };
}

export interface TeamsRpcEvents {
  /** Invalidation: a team, its members or its posts changed. */
  'teams.changed': { teamId: string; version: number };
}
