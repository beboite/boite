/**
 * What a persistent agent's thread is told about the agent on top of the
 * conversation: its persona, its brain, its memory, its skills, its routines,
 * its desk and how it works. `turn-context.ts` sends it in full on a fresh
 * native session and whenever its hash moved since the last turn that
 * carried it; otherwise nothing, since the session already holds it. The desk
 * is shown but not hashed: event turns say what changed there.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MEMORY_MAX } from '@boite/contracts';
import type { AgentProfile, AgentWatchPullRequest, LinkedPullRequest, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { scheduleText } from './routines.ts';

const AGENTS_MD_MAX = 32_000;
const SKILLS_MAX = 50;
/** Where `linked-pull-requests.ts` keeps a thread's links. */
const LINKED = 'linked-pull-requests:';
/** The file older scoped memories were archived to on upgrade (`migration.ts`). */
export const MEMORY_ARCHIVE = 'memories-archive.md';

/**
 * How an agent asks for a change to its own settings. No word here may wake
 * the delegation guide (delegation.ts).
 */
export const OWN_SETTINGS = 'Your settings are the user\'s. To change one (a project to entrust to you, your model, a daily budget), propose it with '
  + '`boite settings agent request <key> <value> --why <reason>`; the user applies the card and the outcome comes back as a message.';

/** The terse guide every agent thread carries in its context block. */
export const HOW_YOU_WORK = [
  'How you work:',
  '- You are a colleague the user talks to, in their language. Short plain answers, result first. Show proof as files you attach (`boite attach <file>`) and links, never pasted logs, diffs or tool output.',
  '- Hand code work to project threads (`boite thread new <project> <brief>`), steer them (`boite thread send <id> <text>`) and answer what they ask within your rules (`boite answer`). Never repeat a thread\'s ask to the user: your desk already shows it to them.',
  '- You wake on `routine` and `event` turns: a routine came due, or something happened on your desk or in your projects. End a wake that needs nothing from the user with a line `[quiet] <what you checked, a few words>`.',
  '- Keep your routines matching your instructions: `boite agent routines`, `boite agent schedule <json>` (name, prompt, schedule), `boite agent unschedule <routine-id>`.',
  '- Note a durable fact with `boite agent remember <fact>`; MEMORY.md is also kept up to date after each answer.',
  '- Put a thread on or off your desk with `boite agent watch|unwatch <thread-id>`.',
  '- Ask the user with `boite ask`; `--open <url>` for a login opens the page beside your conversation.',
].join('\n');

/** The skill files of a brain: `skills/<name>/SKILL.md` or `skills/<name>.md`. */
function skillsOf(brainPath: string): { name: string; path: string }[] {
  const dir = join(brainPath, 'skills');
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return []; }
  const found: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (found.length >= SKILLS_MAX) break;
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) { if (existsSync(join(path, 'SKILL.md'))) found.push({ name: entry, path: join(path, 'SKILL.md') }); }
      else if (entry.toLowerCase().endsWith('.md')) found.push({ name: entry.slice(0, -3), path });
    } catch { /* A file that went away between the listing and the stat is no skill. */ }
  }
  return found;
}

function capped(text: string, max: number, path: string): string {
  return text.length > max ? `${text.slice(0, max)}\n[Cut at ${max} characters; the whole file is ${path}.]` : text;
}

/** The state a desk line shows, read from the thread itself. */
export function deskState(core: Core, thread: ThreadSummary): string {
  if (thread.archived) return thread.doneAt != null ? 'done' : 'archived';
  if (core.threads.listQuestions(thread.id).length || core.threads.listPermissions(thread.id).length) return 'needs the user';
  if (thread.status === 'running' || thread.status === 'waiting') return 'working';
  if (thread.status === 'queued') return 'queued';
  if (thread.status === 'error') return 'failed';
  return 'idle';
}

/**
 * The pull request a desk line shows: the one Boite watches for the thread,
 * else its newest open link, else its newest link, with the checks the watch
 * last read. Null when the thread linked none.
 */
export function deskPullRequest(core: Core, thread: ThreadSummary): AgentWatchPullRequest | null {
  const stored = core.journal.getSetting(`${LINKED}${thread.id}`);
  const linked = Array.isArray(stored) ? (stored as LinkedPullRequest[]).filter(p => typeof p?.url === 'string') : [];
  const watches = core.pullRequestWatches?.of(thread.id) ?? [];
  const pr = linked.find(p => watches.some(w => w.url.toLowerCase() === p.url.toLowerCase()))
    ?? [...linked].reverse().find(p => p.state === 'OPEN') ?? linked.at(-1);
  if (!pr) {
    const known = thread.pullRequest;
    return known ? { number: known.number, url: known.url, state: known.state === 'MERGED' ? 'merged' : known.state === 'CLOSED' ? 'closed' : 'open', checks: null } : null;
  }
  const seen = watches.find(w => w.url.toLowerCase() === pr.url.toLowerCase())?.seen ?? null;
  const checks: AgentWatchPullRequest['checks'] = seen === null || seen.checks.total === 0 ? null
    : seen.checks.failed > 0 ? 'failing' : seen.checks.running > 0 ? 'pending' : 'passing';
  const state: AgentWatchPullRequest['state'] = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : 'open';
  return { number: pr.number, url: pr.url, state, checks: state === 'merged' || state === 'closed' ? null : checks };
}

/** A desk line's pull request, in a few words: `PR #12 open, checks failing`. */
export function pullRequestText(pr: AgentWatchPullRequest | null): string {
  return pr ? `PR #${pr.number} ${pr.state}${pr.checks ? `, checks ${pr.checks}` : ''}` : '';
}

/** The agent's context block, with the hash that says when it must be sent again. */
export function agentContext(core: Core, agent: AgentProfile): { text: string; hash: string } {
  const store = core.workforce;
  const brain = store.resident.brain(agent.id);
  const memoryPath = join(brain.path, 'MEMORY.md');
  const memory = capped(brain.memory.trim(), AGENT_MEMORY_MAX, memoryPath);
  const archive = join(brain.path, MEMORY_ARCHIVE);
  const skills = skillsOf(brain.path);
  const routines = store.records.list('routine').filter(r => r.agentId === agent.id);
  const projects = store.projects.instructions(agent);
  const persona = [`You are ${agent.name}${agent.domain.trim() ? `, ${agent.domain.trim()}` : ''}.`, agent.instructions.trim()].filter(Boolean).join('\n');
  const routineLines = routines.map(r => `- ${r.name} (${r.id}): ${scheduleText(r.schedule)}${r.enabled ? r.nextAt !== null ? `, next ${new Date(r.nextAt).toISOString()}` : ', done' : ', off'}`);
  const desk = store.projects.watchesOf(agent.id).slice(0, 30).flatMap(({ threadId }) => {
    const thread = core.journal.getThread(threadId);
    if (!thread) return [];
    const project = thread.projectId === null ? null : core.journal.getProject(thread.projectId)?.name ?? null;
    const pr = pullRequestText(deskPullRequest(core, thread));
    const stalled = store.projects.stalledSince(thread.id);
    return [`- "${thread.title}" (${thread.id})${project ? ` in ${project}` : ''}: ${deskState(core, thread)}${stalled === null ? '' : ', silent since ' + new Date(stalled).toISOString()}${pr ? `, ${pr}` : ''}`];
  });
  const text = [
    'Boite: who you are, as a persistent agent. This block comes again only when it changes; your conversation so far is in this session.',
    persona,
    `Your brain is ${brain.path}. Its AGENTS.md:\n${capped(brain.instructions.trim(), AGENTS_MD_MAX, join(brain.path, 'AGENTS.md')) || '(empty)'}`,
    `Your memory, ${memoryPath}:\n${memory || '(empty)'}`,
    ...(existsSync(archive) ? [`Older notes you may read when they matter: ${archive}`] : []),
    skills.length ? `Your skills (read the file before using one):\n${skills.map(s => `- ${s.name}: ${s.path}`).join('\n')}` : `Your skills go in ${join(brain.path, 'skills')}, one folder with a SKILL.md each.`,
    routineLines.length ? `Your routines:\n${routineLines.join('\n')}` : 'You have no routine yet.',
    desk.length ? `Your desk:\n${desk.join('\n')}` : 'Your desk is empty.',
    projects,
    OWN_SETTINGS,
    HOW_YOU_WORK,
  ].filter(Boolean).join('\n\n');
  const hash = createHash('sha256').update(JSON.stringify([
    persona, brain.instructions, memory, existsSync(archive), skills, routines.map(r => [r.id, r.name, r.schedule, r.enabled]), projects, OWN_SETTINGS, HOW_YOU_WORK,
  ])).digest('hex');
  return { text: `${text}\n\n`, hash };
}
