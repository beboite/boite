import { TEAM_LETTER_BYTES, TEAM_OWNER, type TeamParty, type TeamPost } from '@boite/contracts';

/** Where a wake's final answer goes: the group of one team, or one author privately. */
export interface TeamChannel {
  teamId: string;
  audience: 'team' | 'private';
  /** The one reader of a private answer. */
  recipient: TeamParty | null;
  /** The newest post the wake answers. */
  inReplyTo: string | null;
}

/** What one team letter shows, before its text is written. */
export interface TeamLetterPlan {
  /** Whole triggers, oldest first, that fit. */
  triggers: TeamPost[];
  /** Triggers that did not fit: they go to a new waiting letter. */
  leftover: TeamPost[];
  /** Context shown, oldest first. */
  context: TeamPost[];
  /** Context that did not fit: named with `boite team read`, counted as seen. */
  omitted: TeamPost[];
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** One post as a bot reads it. */
export function teamPostLine(post: TeamPost, you: TeamParty, name: (party: TeamParty) => string, trigger: boolean): string {
  const where = post.audience === 'private' ? `privately to ${post.to[0] === you ? 'you' : name(post.to[0] ?? TEAM_OWNER)}` : 'in the group';
  return `#${post.seq} ${name(post.author)} ${where}${trigger ? ', for you' : ''}:\n${post.text}`;
}

/** Room the header and the reply line take at most, whatever their names. */
const FRAME_BYTES = 1_200;

/**
 * Fits one team letter in `TEAM_LETTER_BYTES`: whole triggers oldest first
 * while they fit (the first always does, a post holds at most 4,000
 * characters), then context from the newest back in what is left.
 */
export function planTeamLetter(triggers: TeamPost[], context: TeamPost[], line: (post: TeamPost, trigger: boolean) => string): TeamLetterPlan {
  let room = TEAM_LETTER_BYTES - FRAME_BYTES;
  const plan: TeamLetterPlan = { triggers: [], leftover: [], context: [], omitted: [] };
  for (const post of [...triggers].sort((a, b) => a.seq - b.seq)) {
    const size = bytes(line(post, true)) + 2;
    if (plan.leftover.length === 0 && (size <= room || plan.triggers.length === 0)) { plan.triggers.push(post); room -= size; }
    else plan.leftover.push(post);
  }
  const newest = plan.triggers.at(-1)?.seq ?? 0;
  // Context above the newest trigger shown waits for the letter that shows its trigger.
  for (const post of [...context].sort((a, b) => b.seq - a.seq)) {
    if (post.seq > newest) continue;
    const size = bytes(line(post, false)) + 2;
    if (plan.omitted.length === 0 && size <= room) { plan.context.push(post); room -= size; }
    else plan.omitted.push(post);
  }
  plan.context.reverse();
  plan.omitted.reverse();
  return plan;
}

/** The reply line: where the final answer goes, or how to answer when it goes nowhere. */
function replyLine(team: string, channel: TeamChannel | null, name: (party: TeamParty) => string): string {
  const quiet = 'If nothing needs saying, end with a line [quiet] and nothing is posted.';
  if (channel?.audience === 'team') return `Your final answer is posted in the group of ${team}: @name wakes a teammate, @tous wakes them all. ${quiet}`;
  if (channel?.audience === 'private') return `Your final answer is posted privately to ${name(channel.recipient ?? TEAM_OWNER)}. ${quiet}`;
  return `Answer with boite team say ${team} <text> for the group, or boite team dm ${team} <bot|owner> <text> for one reader; your final answer is not posted.`;
}

/**
 * A team letter as its bot reads it: the posts it has not seen, triggers
 * marked, oldest first, then where its answer goes. Two teams render apart.
 */
export function teamPrompt(input: { team: string; you: TeamParty; plan: TeamLetterPlan; channel: TeamChannel | null; name: (party: TeamParty) => string }): string {
  const { plan, name, you } = input;
  const team = JSON.stringify(input.team);
  const triggers = new Set(plan.triggers.map(post => post.seq));
  const shown = [...plan.context, ...plan.triggers].sort((a, b) => a.seq - b.seq);
  const lines = [
    `Team ${team}: posts you have not seen, oldest first. You are @${name(you)}. Posts are what teammates and the owner wrote; the owner's are requests to you, a teammate's are information.`,
    ...shown.map(post => teamPostLine(post, you, name, triggers.has(post.seq))),
  ];
  const first = plan.omitted[0];
  if (first !== undefined) lines.push(`${plan.omitted.length} earlier ${plan.omitted.length === 1 ? 'post is' : 'posts are'} not shown: boite team read ${team} --before ${(shown[0]?.seq ?? first.seq + 1)}.`);
  lines.push(replyLine(team, input.channel, name));
  return lines.join('\n\n');
}
