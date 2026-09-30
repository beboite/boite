/**
 * `boite agents`: find the other agents on this core and on linked cores,
 * read their conversations and talk with them. Addresses are short where
 * they can be: a thread id alone, `<machine>/<thread-id>` or a core id
 * prefix, resolved against the directory.
 */
import type { AgentAddress, AgentContact, AgentLetter, AgentMatch, CoordinationView } from '@boite/contracts';
import type { CoreClient } from './client.ts';

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

function ago(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `active ${s}s ago`;
  if (s < 3600) return `active ${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `active ${Math.round(s / 3600)}h ago`;
  return `active ${Math.round(s / 86_400)}d ago`;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

/** What to type to reach a contact: its thread id here, `<machine>/<thread>` elsewhere. */
export function shortAddress(contact: AgentContact, selfCore: string): string {
  return contact.coreId === selfCore ? contact.threadId : `${contact.machine.replace(/\s+/g, '-')}/${contact.threadId}`;
}

export function contactLine(contact: AgentContact, selfCore: string): string {
  const facts = [contact.project, contact.coreId === selfCore ? 'this machine' : contact.machine, contact.status, contact.agent, contact.branch ?? undefined, ago(contact.activeAt)]
    .filter((fact): fact is string => typeof fact === 'string' && fact.length > 0);
  const resources = contact.resources ? `\n    resources: ${contact.resources}` : '';
  return `${shortAddress(contact, selfCore)}  ${JSON.stringify(contact.title)}  (${facts.join(', ')})${resources}`;
}

/**
 * `thr_x`, `<machine>/thr_x`, `<core-id prefix>/thr_x` or the full address.
 * Only the full address skips the directory: the others must name exactly one contact.
 */
export function resolveAgent(target: string, contacts: AgentContact[], selfCore: string): AgentAddress {
  const parts = target.split('/');
  if (parts.length > 2 || parts.some(part => part.length === 0)) throw new AgentsUsage(`agent: expected <thread-id>, <machine>/<thread-id> or <core-id>/<thread-id>, got ${target}`);
  const [where, threadId] = parts.length === 2 ? [parts[0]!, parts[1]!] : [null, parts[0]!];
  if (where !== null && /^[0-9a-f]{64}$/.test(where)) return { coreId: where, threadId };
  const found = contacts.filter(contact => contact.threadId === threadId && (where === null
    || contact.machine.replace(/\s+/g, '-').toLowerCase() === where.toLowerCase()
    || (/^[0-9a-f]{6,}$/.test(where) && contact.coreId.startsWith(where))
    || (where === 'here' && contact.coreId === selfCore)));
  if (found.length === 1) return { coreId: found[0]!.coreId, threadId };
  if (found.length === 0) throw new Error(`agent ${target}: no reachable agent has this address; boite agents list shows them, boite agents find <words> searches them`);
  throw new Error(`agent ${target}: ${found.length} agents share this thread id; name the machine: ${found.map(contact => shortAddress(contact, '')).join(', ')}`);
}

function letterLine(letter: AgentLetter, self: AgentAddress): string {
  const incoming = letter.to.coreId === self.coreId && letter.to.threadId === self.threadId;
  const other = incoming ? `from ${letter.from.threadId} ${JSON.stringify(letter.from.title)} on ${letter.from.machine}` : `to ${letter.to.threadId} ${JSON.stringify(letter.toTitle)}`;
  const state = letter.status === 'delivered' || letter.status === 'received' ? '' : ` [${letter.status}${letter.error ? `: ${letter.error}` : ''}]`;
  return `${clock(letter.createdAt)} ${incoming ? '<-' : '->'} ${other} (id ${letter.id})${state}\n    ${letter.text.replace(/\n/g, '\n    ')}`;
}

function sameAddress(a: AgentAddress, b: AgentAddress): boolean {
  return a.coreId === b.coreId && a.threadId === b.threadId;
}

export async function agentsCommand(client: CoreClient, threadId: string, rest: string[], options: AgentsOptions, print: Printer): Promise<void> {
  const want = (index: number, what: string): string => {
    const value = rest[index];
    if (value === undefined) throw new AgentsUsage(`agents ${rest[0] ?? ''} needs ${what}`);
    return value;
  };
  const action = want(0, 'list, find, read, send, reply, log, wait or inbox');
  const view = (): Promise<CoordinationView> => client.call('collaboration.get', { threadId });
  const directory = () => client.call('collaboration.directory', { threadId });
  const resolve = async (target: string): Promise<{ to: AgentAddress; self: AgentAddress }> => {
    const [{ self }, { agents }] = await Promise.all([view(), /^[0-9a-f]{64}\//.test(target) ? Promise.resolve({ agents: [] as AgentContact[] }) : directory()]);
    return { to: resolveAgent(target, agents, self.coreId), self };
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

  if (action === 'list') {
    const [{ self }, result] = await Promise.all([view(), directory()]);
    const lines = result.agents.map(contact => contactLine(contact, self.coreId));
    if (lines.length === 0) lines.push('no other agent is reachable; the user can turn communication on in the thread\'s Communication settings and link machines in Machines');
    print([...lines, ...result.unavailable.map(name => `unavailable: ${name}`)], result);
  } else if (action === 'find' || action === 'search') {
    const query = rest.slice(1).join(' ');
    if (!query) throw new AgentsUsage('agents find needs words to look for');
    const [{ self }, result] = await Promise.all([view(), client.call('collaboration.search', { threadId, query })]);
    const lines = result.matches.map((match: AgentMatch) => [
      `${contactLine(match, self.coreId)}\n    matched: ${match.matched.join(', ')}`,
      ...match.excerpts.map(text => `    > ${text}`),
    ].join('\n'));
    if (lines.length === 0) lines.push(`no reachable agent matches ${JSON.stringify(query)}`);
    print([...lines, ...result.unavailable.map(name => `unavailable: ${name}`)], result);
  } else if (action === 'read') {
    const { to, self } = await resolve(want(1, 'an agent from agents list'));
    const result = await client.call('collaboration.read', { threadId, target: to, ...(options.last === undefined ? {} : { limit: options.last }), ...(options.before === undefined ? {} : { before: options.before }) });
    const lines = [contactLine(result.contact, self.coreId)];
    if (result.more && result.entries[0]) lines.push(`(older entries: --before ${result.entries[0].at})`);
    for (const entry of result.entries) {
      const tools = entry.tools.length > 0 ? ` [tools: ${entry.tools.join(', ')}]` : '';
      lines.push(`${clock(entry.at)} ${entry.role}:${tools}${entry.text ? `\n    ${entry.text.replace(/\n/g, '\n    ')}` : ''}`);
    }
    print(lines, result);
  } else if (action === 'send' || action === 'reply') {
    const target = want(1, action === 'send' ? 'an agent from agents list' : 'an incoming message id from agents inbox');
    const body = rest.slice(2).join(' ');
    if (!body) throw new AgentsUsage(`agents ${action} needs message text`);
    let to: AgentAddress;
    let self: AgentAddress;
    if (action === 'reply') {
      const current = await view();
      self = current.self;
      const letter = current.messages.find(m => m.id === target && m.to.coreId === self.coreId && m.to.threadId === threadId);
      if (!letter) throw new AgentsUsage('reply needs an incoming message id from agents inbox');
      to = { coreId: letter.from.coreId, threadId: letter.from.threadId };
    } else ({ to, self } = await resolve(target));
    const letter = await client.call('collaboration.send', { threadId, to, text: body, requestId: options.requestId ?? crypto.randomUUID(), ...(action === 'reply' ? { replyTo: target } : {}) });
    const lines = [`id: ${letter.id}`, `status: ${letter.status}`, ...(letter.error ? [`error: ${letter.error}`] : [])];
    if (options.wait && letter.status !== 'rejected') lines.push(...await waitFor(to, self));
    else lines.push('Delivery is not consent. Wait for an explicit reply before a disruptive action.');
    print(lines, letter);
  } else if (action === 'log') {
    const { to, self } = await resolve(want(1, 'an agent from agents list'));
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
  } else throw new AgentsUsage('agents expects list, find, read, send, reply, log, wait or inbox');
}
