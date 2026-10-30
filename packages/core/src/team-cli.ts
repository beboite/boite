/**
 * `boite team`: a bot posts in the teams it belongs to, reads them, and
 * proposes a team, an invitation or its leaving on a card (`docs/teams.md`).
 */
import type { Team, TeamPost } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import { Usage } from './cli-args.ts';

export const TEAM_HELP = `boite team: talk with the other bots of your teams. Group posts every member reads; private posts only you, the recipient and the owner.
  boite team list                                     your teams and their members
  boite team say <team> <text> [--reply <post-id>]    post in the group; @name or @tous picks who it wakes
  boite team dm <team> <member|owner> <text>          a private post to one member, or to the owner
  boite team read <team> [--before <seq>] [--limit <n>]
                                                      the posts you may read, oldest first
  boite team propose --name <name> --members <bot,bot> [--brief <text>]
                                                      a card asking the owner to create a team
  boite team invite <team> <bot>                      a card asking the owner to add a bot
  boite team leave <team>                             a card asking the owner to let you leave
Your final answer to a team letter is posted for you; answer [quiet] to post nothing.`;

export interface TeamCliResult { lines: string[]; value: unknown }

/** The command's own flags. */
function flags(args: string[], known: string[]): { positional: string[]; values: Map<string, string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--') || arg === '--') { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!known.includes(name)) throw new Usage(`boite team: unknown flag ${arg}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Usage(`boite team: ${arg} needs a value`);
    values.set(name, value);
    index += 1;
  }
  return { positional, values };
}

const count = (flag: string, raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Usage(`boite team: ${flag} needs a whole number from 1, got ${raw}`);
  return value;
};

const postLine = (post: TeamPost, team: Team): string => {
  const name = (party: string) => party === 'owner' ? 'owner' : team.members.find(member => member.key === party)?.name ?? party;
  const where = post.audience === 'private' ? `privately to ${post.to.map(name).join(', ')}` : 'in the group';
  return `#${post.seq} ${name(post.author)} ${where} (${post.id}): ${post.text}`;
};

const posted = (post: TeamPost, team: string): TeamCliResult => ({
  lines: [`posted: #${post.seq} in ${team} (${post.id})`, post.to.length ? `wakes: ${post.to.join(', ')}` : `wakes nobody${post.notice ? `: ${post.notice}` : ''}`],
  value: post,
});

const carded = (questionId: string, what: string): TeamCliResult => ({
  lines: [`requested: ${questionId}`, `card: ${what}`, 'Keep working. The owner\'s choice arrives as a message; without one, nothing changed.'],
  value: { questionId },
});

export async function teamCommand(args: string[], client: CoreClient, threadId: string, requestId?: string): Promise<TeamCliResult> {
  const [action, ...rest] = args;
  if (action === undefined || action === 'help' || action === '--help') return { lines: [TEAM_HELP], value: { help: TEAM_HELP } };
  const text = (words: string[], what: string): string => {
    const joined = words.join(' ').trim();
    if (joined === '') throw new Usage(`boite team ${action} needs ${what}`);
    return joined;
  };
  /** `--request-id`, before or after the action: a retry with it returns the same post. */
  const id = (values: Map<string, string>) => {
    const chosen = values.get('request-id') ?? requestId;
    return chosen === undefined ? {} : { id: chosen };
  };
  switch (action) {
    case 'list': {
      if (rest.length > 0) throw new Usage('boite team list takes no arguments');
      const { teams } = await client.call('teams.list', { threadId });
      const lines = teams.map(team => `${team.name}${team.paused ? ' (paused)' : ''}: ${team.members.map(member => member.name).join(', ')}${team.brief ? `; ${team.brief}` : ''}`);
      return { lines: lines.length ? lines : ['no team yet; boite team propose asks the owner for one'], value: { teams } };
    }
    case 'say': {
      const { positional, values } = flags(rest, ['reply', 'request-id']);
      const [team = '', ...words] = positional;
      if (team === '') throw new Usage('boite team say needs a team and the text');
      const reply = values.get('reply');
      const post = await client.call('teams.say', { threadId, team, text: text(words, 'the text'), ...id(values), ...(reply === undefined ? {} : { inReplyTo: reply }) });
      return posted(post, team);
    }
    case 'dm': {
      const { positional, values } = flags(rest, ['request-id']);
      const [team = '', to = '', ...words] = positional;
      if (team === '' || to === '') throw new Usage('boite team dm needs a team, a member or owner, and the text');
      return posted(await client.call('teams.dm', { threadId, team, to, text: text(words, 'the text'), ...id(values) }), team);
    }
    case 'read': {
      const { positional, values } = flags(rest, ['before', 'limit']);
      if (positional.length !== 1) throw new Usage('boite team read needs one team');
      const before = count('--before', values.get('before'));
      const limit = count('--limit', values.get('limit'));
      const reading = await client.call('teams.read', { threadId, team: positional[0]!, ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) });
      const first = reading.posts[0];
      return {
        lines: [...reading.posts.map(post => postLine(post, reading.team)),
          ...(reading.more && first ? [`older: boite team read "${reading.team.name}" --before ${first.seq}`] : []),
          ...(reading.posts.length ? [] : ['no post yet'])],
        value: reading,
      };
    }
    case 'propose': {
      const { positional, values } = flags(rest, ['name', 'members', 'brief']);
      if (positional.length > 0) throw new Usage('boite team propose takes --name, --members and an optional --brief');
      const name = values.get('name');
      const members = (values.get('members') ?? '').split(',').map(member => member.trim()).filter(Boolean);
      if (name === undefined || members.length === 0) throw new Usage('boite team propose needs --name <name> and --members <bot,bot>');
      const brief = values.get('brief');
      const asked = await client.call('teams.propose', { threadId, name, members, ...(brief === undefined ? {} : { brief }) });
      return carded(asked.questionId, `create ${name} with ${members.join(', ')}`);
    }
    case 'invite': {
      const [team = '', bot = '', ...extra] = flags(rest, []).positional;
      if (team === '' || bot === '' || extra.length > 0) throw new Usage('boite team invite needs a team and one bot');
      return carded((await client.call('teams.invite', { threadId, team, bot })).questionId, `add ${bot} to ${team}`);
    }
    case 'leave': {
      const [team = '', ...extra] = flags(rest, []).positional;
      if (team === '' || extra.length > 0) throw new Usage('boite team leave needs one team');
      return carded((await client.call('teams.leave', { threadId, team })).questionId, `leave ${team}`);
    }
    default:
      throw new Usage(`boite team: unknown action ${action}; expects list, say, dm, read, propose, invite or leave`);
  }
}
