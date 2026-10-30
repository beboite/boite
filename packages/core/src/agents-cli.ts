/**
 * `boite threads`: find the other threads on this core and on linked cores,
 * read their conversations and talk with them (`boite agents` before; the
 * old word still answers). Addresses are short where
 * they can be: a thread id alone, `<machine>/<thread-id>` or a core id
 * prefix, resolved against the directory. `contacts` and `ask` reach other
 * owners' Boites linked as contacts.
 */
import type { AgentAddress, AgentContact, AgentLetter, AgentMatch, AgentRelation, CoordinationView } from '@boite/contracts';
import { threadActive, COORDINATION_RECENT_COMPLETION_MS } from '@boite/contracts';
import type { CoreClient } from './client.ts';

/** What `boite threads` says when nothing is reachable. */
export const NO_CONTACT = 'no other thread is reachable; the user can turn communication on in the thread\'s Communication settings and link machines in Machines';

/** The default wait stays under a two-minute tool timeout. */
export const WAIT_DEFAULT_S = 90;
export const WAIT_MAX_S = 300;

export interface AgentsOptions {
  requestId?: string;
  wait: boolean;
  timeout?: number;
  last?: number;
  before?: number;
}

type Printer = (lines: string[], value: unknown) => void;
class AgentsUsage extends Error {}
export { AgentsUsage };

export function ago(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

/** What to type to reach a contact: its thread id here, `<machine>/<thread>` elsewhere. */
export function shortAddress(contact: AgentContact, selfCore: string): string {
  return contact.coreId === selfCore ? contact.threadId : `${contact.machine.replace(/\s+/g, '-')}/${contact.threadId}`;
}

export function contactLine(contact: AgentContact, selfCore: string, now = Date.now()): string {
  const working = threadActive(contact.status);
  const completed = contact.lastCompletedAt;
  const recent = typeof completed === 'number' && completed <= now && now - completed <= COORDINATION_RECENT_COMPLETION_MS;
  const completion = typeof completed === 'number' ? `last completed ${ago(completed, now)}` : completed === null ? 'no completed turn' : 'last completion unknown';
  const facts = [contact.project, contact.coreId === selfCore ? 'this machine' : contact.machine, `${contact.status} (${working ? 'working' : 'not working'})`, contact.agent, contact.branch ?? undefined,
    contact.activeAt === undefined ? undefined : `active ${ago(contact.activeAt, now)}`, completion,
    contact.paused ? 'coordination paused' : undefined, contact.projectArchived ? 'project archived; delivery will restore it' : undefined]
    .filter((fact): fact is string => typeof fact === 'string' && fact.length > 0);
  const resources = contact.resources ? `\n    resources: ${contact.resources}` : '';
  // A failed thread left its work unfinished: a message wakes it to resume, unlike one that is merely done.
  const warning = working ? '' : contact.status === 'error' ? '\n    note: its last turn failed; a message wakes it to resume.'
    : !recent ? '\n    warning: contacting this inactive thread is allowed but discouraged unless it completed work in the last 15 minutes.' : '';
  return `${shortAddress(contact, selfCore)}  ${JSON.stringify(contact.title)}  (${facts.join(', ')})${resources}${warning}`;
}

/**
 * `thr_x`, `<machine>/thr_x`, `<core-id prefix>/thr_x` or the full address.
 * Only the full address skips the directory: the others must name exactly one contact.
 */
export function resolveAgent(target: string, contacts: AgentContact[], selfCore: string): AgentAddress {
  const parts = target.split('/');
  if (parts.length > 2 || parts.some(part => part.length === 0)) throw new AgentsUsage(`thread: expected <thread-id>, <machine>/<thread-id> or <core-id>/<thread-id>, got ${target}`);
  const [where, threadId] = parts.length === 2 ? [parts[0]!, parts[1]!] : [null, parts[0]!];
  if (where !== null && /^[0-9a-f]{64}$/.test(where)) return { coreId: where, threadId };
  const found = contacts.filter(contact => contact.threadId === threadId && (where === null
    || contact.machine.replace(/\s+/g, '-').toLowerCase() === where.toLowerCase()
    || (/^[0-9a-f]{6,}$/.test(where) && contact.coreId.startsWith(where))
    || (where === 'here' && contact.coreId === selfCore)));
  if (found.length === 1) return { coreId: found[0]!.coreId, threadId };
  if (found.length === 0) throw new Error(`thread ${target}: no reachable thread has this address; boite threads lists them, boite threads find <words> searches them`);
  throw new Error(`thread ${target}: ${found.length} threads share this id; name the machine: ${found.map(contact => shortAddress(contact, '')).join(', ')}`);
}

/** How the other end relates to this thread, in the words `boite threads` prints. */
const RELATION: Record<AgentRelation, string> = {
  starter: 'started this thread', started: 'you started it', parent: 'your parent', child: 'your subagent',
  resident: 'the bot your project is entrusted to', project: 'same project', 'other-project': 'other project', machine: 'other machine',
};
/** Past this, `send` and `reply` remind the agent that a message is read best short. */
export const COMPACT_CHARS = 600;

function letterLine(letter: AgentLetter, self: AgentAddress): string {
  const incoming = letter.to.coreId === self.coreId && letter.to.threadId === self.threadId;
  const where = [letter.from.project, letter.from.coreId === self.coreId ? undefined : `on ${letter.from.machine}`, letter.contact ? `contact ${letter.contact.name}, not your user` : undefined,
    letter.relation ? RELATION[letter.relation] : undefined].filter(Boolean).join(', ');
  const other = incoming ? `from ${letter.from.threadId} ${JSON.stringify(letter.from.title)}${where ? ` (${where})` : ''}` : `to ${letter.to.threadId} ${JSON.stringify(letter.toTitle)}${letter.relation ? ` (${RELATION[letter.relation]})` : ''}`;
  const state = letter.status === 'delivered' || letter.status === 'received' ? '' : ` [${letter.status}${letter.error ? `: ${letter.error}` : ''}]`;
  return `${clock(letter.createdAt)} ${incoming ? '<-' : '->'} ${other} (id ${letter.id})${state}\n    ${letter.text.replace(/\n/g, '\n    ')}`;
}

function sameAddress(a: AgentAddress, b: AgentAddress): boolean {
  return a.coreId === b.coreId && a.threadId === b.threadId;
}

export async function agentsCommand(client: CoreClient, threadId: string, rest: string[], options: AgentsOptions, print: Printer): Promise<void> {
  const want = (index: number, what: string): string => {
    const value = rest[index];
    if (value === undefined) throw new AgentsUsage(`threads ${rest[0] ?? ''} needs ${what}`);
    return value;
  };
  const action = want(0, 'find, read, send, reply, log, wait, inbox, contacts or ask');
  const view = (): Promise<CoordinationView> => client.call('collaboration.get', { threadId });
  const directory = () => client.call('collaboration.directory', { threadId });
  const resolve = async (target: string): Promise<{ to: AgentAddress; self: AgentAddress; contact?: AgentContact }> => {
    const [{ self }, { agents }] = await Promise.all([view(), /^[0-9a-f]{64}\//.test(target) ? Promise.resolve({ agents: [] as AgentContact[] }) : directory()]);
    const to = resolveAgent(target, agents, self.coreId);
    return { to, self, contact: agents.find(agent => sameAddress(agent, to)) };
  };
  const timeoutMs = (): number => {
    const seconds = options.timeout ?? WAIT_DEFAULT_S;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > WAIT_MAX_S) throw new AgentsUsage(`--timeout: expected 0 to ${WAIT_MAX_S} seconds`);
    return Math.round(seconds * 1000);
  };
  const waitFor = async (from: AgentAddress | undefined, self: AgentAddress): Promise<string[]> => {
    const { letters } = await client.call('collaboration.wait', { threadId, ...(from ? { from } : {}), timeoutMs: timeoutMs() });
    if (letters.length === 0) return [`no answer within ${Math.round(timeoutMs() / 1000)}s; it will arrive later as a message`];
    return letters.map(letter => letterLine(letter, self));
  };

  // `threads` and `threads list` are the listing, in control-cli.ts.
  if (action === 'find' || action === 'search') {
    const query = rest.slice(1).join(' ');
    if (!query) throw new AgentsUsage('threads find needs words to look for');
    const [{ self }, result] = await Promise.all([view(), client.call('collaboration.search', { threadId, query })]);
    const lines = result.matches.map((match: AgentMatch) => [
      `${contactLine(match, self.coreId)}\n    matched: ${match.matched.join(', ')}`,
      ...match.excerpts.map(text => `    > ${text}`),
    ].join('\n'));
    if (lines.length === 0) lines.push(`no reachable thread matches ${JSON.stringify(query)}`);
    print([...lines, ...result.unavailable.map(name => `unavailable: ${name}`)], result);
  } else if (action === 'read') {
    const { to, self } = await resolve(want(1, 'a thread from boite threads'));
    const result = await client.call('collaboration.read', { threadId, target: to, ...(options.last === undefined ? {} : { limit: options.last }), ...(options.before === undefined ? {} : { before: options.before }) });
    const lines = [contactLine(result.contact, self.coreId)];
    if (result.more && result.entries[0]) lines.push(`(older entries: --before ${result.entries[0].at})`);
    for (const entry of result.entries) {
      const tools = entry.tools.length > 0 ? ` [tools: ${entry.tools.join(', ')}]` : '';
      lines.push(`${clock(entry.at)} ${entry.role}:${tools}${entry.text ? `\n    ${entry.text.replace(/\n/g, '\n    ')}` : ''}`);
    }
    print(lines, result);
  } else if (action === 'send' || action === 'reply') {
    const target = want(1, action === 'send' ? 'a thread from boite threads' : 'an incoming message id from threads inbox');
    const body = rest.slice(2).join(' ');
    if (!body) throw new AgentsUsage(`threads ${action} needs message text`);
    let to: AgentAddress;
    let self: AgentAddress;
    let contact: AgentContact | undefined;
    if (action === 'reply') {
      const current = await view();
      self = current.self;
      const letter = current.messages.find(m => m.id === target && m.to.coreId === self.coreId && m.to.threadId === threadId);
      if (!letter) throw new AgentsUsage('reply needs an incoming message id from threads inbox');
      to = { coreId: letter.from.coreId, threadId: letter.from.threadId };
      contact = (await directory()).agents.find(agent => sameAddress(agent, to));
    } else ({ to, self, contact } = await resolve(target));
    const letter = await client.call('collaboration.send', { threadId, to, text: body, requestId: options.requestId ?? crypto.randomUUID(), ...(action === 'reply' ? { replyTo: target } : {}) });
    const recipient = contact ? contactLine(contact, self.coreId) : 'warning: recipient activity is unknown; sending or replying may wake an inactive thread and restore its archived project. Check boite threads or threads read before contacting it.';
    const lines = [recipient, `id: ${letter.id}`, `status: ${letter.status}`, ...(letter.error ? [`error: ${letter.error}`] : []),
      ...(body.length > COMPACT_CHARS ? [`note: ${body.length} characters. Keep messages to other threads to one to three short lines; the recipient already sees your thread, project and task.`] : [])];
    if (options.wait && letter.status !== 'rejected') lines.push(...await waitFor(to, self));
    else lines.push('Delivery is not consent. Wait for an explicit reply before a disruptive action.');
    print(lines, letter);
  } else if (action === 'log') {
    const { to, self } = await resolve(want(1, 'a thread from boite threads'));
    const current = await view();
    const letters = current.messages.filter(m => sameAddress(m.from, to) || sameAddress(m.to, to));
    print(letters.length === 0 ? [`no message exchanged with ${want(1, '')} yet`] : letters.map(letter => letterLine(letter, self)), letters);
  } else if (action === 'wait') {
    const current = await view();
    const from = rest[1] === undefined ? undefined : (await resolve(rest[1])).to;
    print(await waitFor(from, current.self), null);
  } else if (action === 'inbox') {
    const current = await view();
    print([
      `communication: ${current.config.mode === 'off' ? 'off' : current.config.paused ? 'paused' : 'on'}${current.config.remote ? ', other projects and machines' : ', this project only'}`,
      `sent this hour: ${current.sent}${current.sendLimit === null ? '' : ` of ${current.sendLimit}`}`,
      ...current.messages.map(letter => letterLine(letter, current.self)),
    ], current);
  } else if (action === 'contacts') {
    const contacts = await client.call('collaboration.contacts', { threadId });
    const lines = contacts.map(contact => `${contact.name}  (${contact.link}, opened to you: ${contact.projects.length ? contact.projects.join(', ') : 'no project yet'})`);
    if (lines.length === 0) lines.push("no contact; the user links other owners' Boites in Contacts");
    else lines.push('Their threads in opened projects are in boite threads as <contact>/<thread-id>. Request project access with threads ask <contact> <text>; the remote Boite can decide automatically. Message an agent conversation with threads send.');
    print(lines, contacts);
  } else if (action === 'ask') {
    const contact = want(1, 'a contact from threads contacts');
    const body = rest.slice(2).join(' ');
    if (!body) throw new AgentsUsage('threads ask needs the request text: the project or work you need a thread for');
    const request = await client.call('collaboration.ask', { threadId, contact, text: body });
    const lines = [`request ${request.id} to ${request.contact}: ${request.status}${request.gitRemote ? ` (sent with your git remote ${request.gitRemote})` : ''}`, 'This requests project access; the remote Boite can decide automatically. Use threads send to message an agent conversation.'];
    if (options.wait) lines.push(...await waitFor({ coreId: request.coreId, threadId: request.id }, { coreId: request.from.coreId, threadId }));
    else lines.push('The answer comes back to this thread as a message: the project opened and its threads, or the reason for a refusal.');
    print(lines, request);
  } else throw new AgentsUsage('threads expects list, find, read, send, reply, log, wait, inbox, contacts or ask');
}
