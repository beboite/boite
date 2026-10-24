/** Coordination between threads, on this core and on the other fake cores it trusts. */
import { defaultCoordinationConfig, RpcErrorCode, type AgentAddress, type AgentContact, type AgentLetter, type AgentMatch, type AgentRelation, type Contact, type ContactRequest, type ContactsState, type CoordinationConfig, type CoordinationPeer, type CoordinationView, type Thread, type ThreadId } from '@boite/contracts';
import { RpcFailure } from '../client';
import { archiveProject } from './project-archive';
import type { FakeContext, FakeMethods } from './context';

/** Every fake core of this page by id, what a remote letter or directory reaches. */
const cores = new Map<string, FakeContext>();

export function registerCore(ctx: FakeContext): void {
  cores.set(ctx.identity.coreId, ctx);
}

/** A fake core of this page by its id, which is how one reaches another without a network. */
export function fakeCore(coreId: string): FakeContext | undefined {
  return cores.get(coreId);
}

export function unregisterCore(ctx: FakeContext): void {
  if (cores.get(ctx.identity.coreId) === ctx) cores.delete(ctx.identity.coreId);
}

/** Manual links and live group admissions are the two sources of remote trust. */
function trusted(ctx: FakeContext): CoordinationPeer[] {
  const manual = [...ctx.peers.values()];
  const group = ctx.roster;
  const members = (group?.cores ?? []).filter(core => core.coreId !== ctx.identity.coreId && !ctx.peers.has(core.coreId));
  return [...manual, ...members.map(core => {
    const grant = ctx.groupReads.get(core.coreId);
    return { ...cores.get(core.coreId)?.identity, coreId: core.coreId, name: core.name, url: core.addresses[0] ?? '', publicKey: cores.get(core.coreId)?.identity.publicKey ?? '',
      readThreads: grant?.groupId === group?.id && grant?.epoch === core.epoch };
  })];
}
export const trusts = (ctx: FakeContext, coreId: string) => trusted(ctx).some(peer => peer.coreId === coreId);
const reads = (ctx: FakeContext, coreId: string) => trusted(ctx).some(peer => peer.coreId === coreId && peer.readThreads === true);

const contactStates = new WeakMap<FakeContext, { state: () => ContactsState; check: (thread: Thread) => void }>();
export function registerContactState(ctx: FakeContext, state: () => ContactsState, check: (thread: Thread) => void): void {
  contactStates.set(ctx, { state, check });
}
export const fakeContacts = (ctx: FakeContext) => contactStates.get(ctx)?.state();
export const checkContactTier = (ctx: FakeContext, thread: Thread) => contactStates.get(ctx)?.check(thread);
const rejected = (message: string) => new RpcFailure({ code: RpcErrorCode.Refused, message });

function groupStamp(source: FakeContext, gateway: FakeContext): string | null {
  const roster = source.roster;
  if (!roster || roster !== gateway.roster) return null;
  const from = roster.cores.find(core => core.coreId === source.identity.coreId);
  const via = roster.cores.find(core => core.coreId === gateway.identity.coreId);
  return from && via ? JSON.stringify([roster.id, from.epoch, via.epoch]) : null;
}

export function fakeContactRoutes(ctx: FakeContext): { gateway: FakeContext; contact: Contact }[] {
  const result = (fakeContacts(ctx)?.contacts ?? []).map(contact => ({ gateway: ctx, contact }));
  for (const member of ctx.roster?.cores ?? []) {
    const gateway = cores.get(member.coreId);
    if (!gateway || gateway === ctx || !groupStamp(ctx, gateway)) continue;
    for (const contact of fakeContacts(gateway)?.contacts ?? []) {
      if (contact.coreId === ctx.identity.coreId || trusts(ctx, contact.coreId) || result.some(row => row.contact.coreId === contact.coreId)) continue;
      result.push({ gateway, contact });
    }
  }
  return result;
}

const routeTo = (source: FakeContext, coreId: string) => trusts(source, coreId) ? undefined : fakeContactRoutes(source).find(row => row.contact.coreId === coreId);
function openedTo(destination: FakeContext, gateway: FakeContext, thread: Thread, read = false): boolean {
  const grant = fakeContacts(destination)?.contacts.find(contact => contact.coreId === gateway.identity.coreId)?.grants.find(grant => grant.projectId === thread.projectId);
  return grant !== undefined && (!read || grant.readThreads);
}
interface Mailbox { id: string; gateway: FakeContext; source: FakeContext; threadId: string; contactId: string; contactAt: number; stamp: string }
const mailboxes = new WeakMap<FakeContext, Mailbox[]>();
const deliveredFrom = new WeakMap<AgentLetter, { source: FakeContext; thread: Thread; canonical: AgentLetter; allowed: () => boolean }>();

function mailbox(source: FakeContext, gateway: FakeContext, threadId: string, contactId: string): Mailbox {
  const stamp = groupStamp(source, gateway);
  if (!stamp) throw rejected('route: expected a current member of the same group');
  const records = mailboxes.get(gateway) ?? [];
  const contactAt = fakeContacts(gateway)!.contacts.find(contact => contact.coreId === contactId)!.addedAt;
  const existing = records.find(row => row.source === source && row.threadId === threadId && row.contactId === contactId && row.contactAt === contactAt && row.stamp === stamp);
  if (existing) return existing;
  const created = { id: `cmb_${++gateway.seq}`, gateway, source, threadId, contactId, contactAt, stamp };
  mailboxes.set(gateway, [...records, created]);
  return created;
}

export function contactSender(source: FakeContext, gateway: FakeContext, threadId: string, contactId: string): AgentContact {
  const from = fakeAgentContact(source, source.thread(threadId), source.identity.coreId, source.identity.name);
  return gateway === source ? from : { ...from, coreId: gateway.identity.coreId, threadId: mailbox(source, gateway, threadId, contactId).id };
}

/** Separate fake clocks must not put a reply before the letter it answers. */
function nextMailTime(ctx: FakeContext, threadId: string): number {
  return (ctx.letters.get(threadId) ?? []).reduce((at, letter) => Math.max(at, letter.createdAt + 1), ctx.now());
}

export function deliverContactAnswer(ctx: FakeContext, request: ContactRequest): void {
  const thread = ctx.threads.get(request.from.threadId);
  if (!thread || thread.archived) return;
  const text = request.status === 'accepted'
    ? `${request.contact} opened its project ${JSON.stringify(request.project?.name ?? '')} to you.`
    : `${request.contact} refused your request: ${request.reason ?? 'no reason given'}`;
  const at = nextMailTime(ctx, thread.id);
  const letter: AgentLetter = {
    id: `contact-answer-${request.id}`, origin: 'contact', contact: { coreId: request.coreId, name: request.contact },
    from: { coreId: request.coreId, threadId: request.id, title: `Answer to your request to ${request.contact}`, machine: request.contact, resources: '', status: 'idle', mode: 'brief' },
    to: { coreId: ctx.identity.coreId, threadId: thread.id }, toTitle: thread.title,
    text, replyTo: null, createdAt: at, expiresAt: at + 86_400_000, status: 'received', error: null
  };
  ctx.letters.set(thread.id, [...(ctx.letters.get(thread.id) ?? []), letter]);
  deliverPending(ctx, thread.id);
  ctx.emit('collaboration.changed', { threadId: thread.id });
}

export function migratePeer(ctx: FakeContext, coreId: string): void {
  const member = ctx.roster?.cores.find(core => core.coreId === coreId);
  const peer = ctx.peers.get(coreId);
  if (!ctx.roster || !member || !peer) return;
  if (peer.readThreads) ctx.groupReads.set(coreId, { groupId: ctx.roster.id, epoch: member.epoch });
  else ctx.groupReads.delete(coreId);
  ctx.peers.delete(coreId);
}

/** A bot's thread starts on like any other, as on the real core (`coordination.ts`). */
export function coordinationConfig(ctx: FakeContext, threadId: ThreadId): CoordinationConfig {
  ctx.thread(threadId);
  return ctx.coordination.get(threadId) ?? defaultCoordinationConfig();
}

/** The thread whose agent started this one, from the mark on its first prompt. */
function starterOf(thread: Thread): ThreadId | undefined {
  for (const part of thread.messages.find(message => message.role === 'user')?.parts ?? []) if (part.type === 'text' && part.startedBy) return part.startedBy.threadId;
  return undefined;
}

/** Whether `peer` is the session of an active bot the owner entrusted `self`'s project to. */
function residentOver(ctx: FakeContext, peer: Thread, self: Thread): boolean {
  if (!peer.agentSessionId || self.agentSessionId || self.projectId === null) return false;
  const snapshot = ctx.agents.snapshot();
  const agentId = snapshot.sessions.find(session => session.id === peer.agentSessionId)?.agentId;
  const agent = snapshot.profiles.find(profile => profile.id === agentId);
  return agent?.status === 'active' && (agent.projectIds ?? []).includes(self.projectId);
}

/** How `other` relates to `threadId`, worked out the way the real core's `Coordination.relation` does. */
function relationOf(ctx: FakeContext, threadId: ThreadId, other: AgentAddress): AgentRelation {
  if (other.coreId !== 'local' && other.coreId !== ctx.identity.coreId) return 'machine';
  const self = ctx.threads.get(threadId);
  const peer = ctx.threads.get(other.threadId);
  if (!self || !peer) return 'other-project';
  if (starterOf(self) === peer.id) return 'starter';
  if (starterOf(peer) === self.id) return 'started';
  if (self.parentThreadId === peer.id) return 'parent';
  if (peer.parentThreadId === self.id) return 'child';
  if (residentOver(ctx, peer, self)) return 'resident';
  return self.projectId === peer.projectId ? 'project' : 'other-project';
}

function coordinationView(ctx: FakeContext, threadId: ThreadId): CoordinationView {
  const config = coordinationConfig(ctx, threadId);
  const letters = ctx.letters.get(threadId) ?? [];
  const mine = (letter: AgentLetter) => letter.from.coreId === ctx.identity.coreId && letter.from.threadId === threadId;
  return {
    self: { coreId: ctx.identity.coreId, threadId },
    config: structuredClone(config),
    messages: structuredClone(letters).map(letter => ({ ...letter, relation: relationOf(ctx, threadId, mine(letter) ? letter.to : letter.from) })),
    sent: letters.filter(letter => letter.from.coreId === ctx.identity.coreId && letter.from.threadId === threadId && letter.createdAt > ctx.now() - 3_600_000).length,
    sendLimit: null,
    wakes: 0,
    wakeLimit: null
  };
}

/** A thread as other agents see it, with the fields the real core describes it by. */
export function fakeAgentContact(ctx: FakeContext, thread: Thread, coreId: string, machine: string): AgentContact {
  const config = coordinationConfig(ctx, thread.id);
  const project = ctx.projects.find(entry => entry.id === thread.projectId);
  return {
    coreId, threadId: thread.id, title: thread.title, machine, resources: config.resources, status: thread.status, mode: config.mode,
    ...(project ? { project: project.name } : {}), agent: `${thread.providerId}${thread.model ? ` ${thread.model}` : ''}`, branch: thread.branch, activeAt: thread.updatedAt,
    lastCompletedAt: thread.turns.findLast(turn => turn.status === 'done' && turn.finishedAt !== null)?.finishedAt ?? null,
    projectArchived: project?.archived === true, paused: config.paused
  };
}

function chatOf(thread: Thread): { id: string; role: Thread['messages'][number]['role']; at: number; text: string; tools: string[] }[] {
  return thread.messages.map(message => ({
    id: message.id, role: message.role, at: message.createdAt,
    text: message.parts.flatMap(part => part.type === 'text' && message.role !== 'system' ? [part.text] : []).join('\n'),
    tools: message.parts.flatMap(part => part.type === 'tool' ? [part.name] : [])
  }));
}

/** Every contact the thread may reach here and on trusted fake cores, with the core each lives on. */
function reachable(ctx: FakeContext, threadId: ThreadId): { contact: AgentContact; core: FakeContext }[] {
  const source = ctx.thread(threadId);
  const sourceConfig = coordinationConfig(ctx, threadId);
  if (source.archived || sourceConfig.mode === 'off') return [];
  const found = [...ctx.threads.values()]
    .filter(thread => thread.id !== threadId && !thread.archived && coordinationConfig(ctx, thread.id).mode !== 'off' && (thread.projectId === source.projectId || sourceConfig.remote && coordinationConfig(ctx, thread.id).remote))
    .map(thread => ({ contact: fakeAgentContact(ctx, thread, ctx.identity.coreId, ctx.identity.name), core: ctx }));
  if (sourceConfig.remote) for (const peer of trusted(ctx)) {
    const target = cores.get(peer.coreId);
    if (!target || !trusts(target, ctx.identity.coreId)) continue;
    for (const thread of target.threads.values()) {
      const config = coordinationConfig(target, thread.id);
      if (!thread.archived && config.mode !== 'off' && config.remote) found.push({ contact: fakeAgentContact(target, thread, peer.coreId, peer.name), core: target });
    }
  }
  if (sourceConfig.remote) for (const { gateway, contact } of fakeContactRoutes(ctx)) {
    if (trusts(ctx, contact.coreId)) continue;
    const target = cores.get(contact.coreId);
    if (!target) continue;
    for (const thread of target.threads.values()) {
      const config = coordinationConfig(target, thread.id);
      if (!thread.archived && config.mode !== 'off' && config.remote && openedTo(target, gateway, thread)) found.push({ contact: fakeAgentContact(target, thread, contact.coreId, contact.name), core: target });
    }
  }
  return found;
}

/** Fake delivery is immediate, but it still respects pauses and restores the owning project. A failed thread receives, as on the core. */
function deliverPending(ctx: FakeContext, threadId: ThreadId): void {
  const thread = ctx.thread(threadId);
  const config = coordinationConfig(ctx, threadId);
  if (thread.archived || config.mode === 'off' || config.paused || ['waiting', 'queued'].includes(thread.status)) return;
  for (const letter of ctx.letters.get(threadId) ?? []) {
    if (letter.status !== 'received' || letter.to.coreId !== ctx.identity.coreId || letter.to.threadId !== threadId) continue;
    const forwarding = deliveredFrom.get(letter);
    if (letter.expiresAt <= ctx.now()) {
      letter.status = 'expired';
      if (forwarding) {
        forwarding.canonical.status = 'expired';
        forwarding.source.emit('collaboration.changed', { threadId: forwarding.thread.id });
      }
      continue;
    }
    if (letter.origin === 'contact') { letter.status = 'delivered'; ctx.emit('collaboration.changed', { threadId }); continue; }
    const sender = forwarding?.source ?? cores.get(letter.from.coreId);
    const source = forwarding?.thread ?? sender?.threads.get(letter.from.threadId);
    if (!sender || !source) continue;
    const sourceConfig = coordinationConfig(sender, source.id);
    if (sourceConfig.mode === 'off') continue;
    const sameProject = sender === ctx && source.projectId === thread.projectId;
    if (!sameProject && !(config.remote && sourceConfig.remote)) continue;
    if (forwarding ? !forwarding.allowed() : sender !== ctx && !(trusts(ctx, sender.identity.coreId) && trusts(sender, ctx.identity.coreId))) continue;
    if (thread.projectId !== null && ctx.projects.find(project => project.id === thread.projectId)?.archived) archiveProject(ctx, thread.projectId, false);
    letter.status = 'delivered';
    if (forwarding) forwarding.canonical.status = 'delivered';
    sender.emit('collaboration.changed', { threadId: source.id });
    ctx.emit('collaboration.changed', { threadId });
  }
}

export function coordinationMethods(ctx: FakeContext) {
  return {
    'collaboration.get': async (params) => {
      const { threadId } = params;
      ctx.thread(threadId);
      return coordinationView(ctx, threadId);
    },
    'collaboration.configure': async (params) => {
      const { threadId, config } = params;
      const thread = ctx.thread(threadId);
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coordination requires an unarchived thread' });
      if (!['off', 'brief', 'team'].includes(config.mode) || typeof config.resources !== 'string' || config.resources.length > 500 || typeof config.remote !== 'boolean' || typeof config.paused !== 'boolean') {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'config: expected mode, resources, remote and paused' });
      }
      ctx.coordination.set(threadId, { ...config, resources: config.resources.trim() });
      deliverPending(ctx, threadId);
      ctx.emit('collaboration.changed', { threadId });
      return coordinationView(ctx, threadId);
    },
    'collaboration.directory': async (params) => {
      const { threadId } = params;
      const source = ctx.thread(threadId);
      const sourceConfig = coordinationConfig(ctx, threadId);
      if (source.archived || sourceConfig.mode === 'off') return { agents: [], unavailable: [] };
      const agents = [...ctx.threads.values()]
        .filter(thread => thread.id !== threadId && !thread.archived && (thread.projectId === source.projectId || sourceConfig.remote && coordinationConfig(ctx, thread.id).remote))
        .map(thread => fakeAgentContact(ctx, thread, ctx.identity.coreId, ctx.identity.name))
        .filter(agent => agent.mode !== 'off')
        .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
      const unavailable: string[] = [];
      if (sourceConfig.remote) for (const peer of trusted(ctx)) {
        const target = cores.get(peer.coreId);
        if (!target || !trusts(target, ctx.identity.coreId)) { unavailable.push(peer.name); continue; }
        for (const thread of target.threads.values()) {
          const config = coordinationConfig(target, thread.id);
          if (thread.archived || config.mode === 'off' || !config.remote) continue;
          agents.push(fakeAgentContact(target, thread, peer.coreId, peer.name));
        }
      }
      for (const row of reachable(ctx, threadId)) if (!agents.some(agent => agent.coreId === row.contact.coreId && agent.threadId === row.contact.threadId)) agents.push(row.contact);
      return { agents, unavailable };
    },
    'collaboration.send': async (params) => {
      const source = ctx.thread(params.threadId);
      const config = coordinationConfig(ctx, source.id);
      if (source.archived || config.mode === 'off' || config.paused) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coordination is off or paused for this thread' });
      }
      const existing = ctx.letters.get(source.id)?.find(letter => letter.id === params.requestId);
      if (existing) {
        if (existing.text !== params.text.trim() || existing.to.coreId !== params.to.coreId || existing.to.threadId !== params.to.threadId || existing.replyTo !== (params.replyTo ?? null)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
        return structuredClone(existing);
      }
      if (!params.text.trim() || params.text.length > 4000) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'text: expected 1 to 4000 characters' });
      let destination = params.to.coreId === ctx.identity.coreId ? ctx : cores.get(params.to.coreId);
      const box = destination ? mailboxes.get(destination)?.find(row => row.id === params.to.threadId && row.contactId === ctx.identity.coreId) : undefined;
      const route = routeTo(ctx, params.to.coreId);
      if (box) {
        if (groupStamp(box.source, box.gateway) !== box.stamp || !fakeContacts(box.gateway)?.contacts.some(contact => contact.coreId === ctx.identity.coreId && contact.addedAt === box.contactAt)) throw rejected('route: contact or group permission revoked');
        destination = box.source;
      }
      const target = destination ? destination.threads.get(box?.threadId ?? params.to.threadId) : undefined;
      if (!target || target.archived || coordinationConfig(destination!, target.id).mode === 'off') {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'recipient is unavailable for coordination' });
      }
      if (destination === ctx && target.projectId !== source.projectId && !(config.remote && coordinationConfig(ctx, target.id).remote)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'both threads must allow coordination across projects' });
      }
      if (destination !== ctx && (!config.remote || !coordinationConfig(destination!, target.id).remote || (!box && !route && (!trusts(ctx, params.to.coreId) || !trusts(destination!, ctx.identity.coreId))))) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'remote core is not trusted' });
      }
      if (route || box) {
        checkContactTier(ctx, source);
        contactStates.get(box?.gateway ?? route!.gateway)?.check(source);
        contactStates.get(destination!)?.check(source);
        if (!box && !openedTo(destination!, route!.gateway, target)) throw rejected('letter.to: not a thread of a project opened to you');
      }
      const at = Math.max(nextMailTime(ctx, source.id), nextMailTime(destination!, target.id));
      const letter: AgentLetter = {
        id: params.requestId,
        from: fakeAgentContact(ctx, source, ctx.identity.coreId, ctx.identity.name),
        to: params.to,
        toTitle: target?.title ?? ctx.peers.get(params.to.coreId)?.name ?? params.to.threadId,
        toProject: destination!.projects.find(project => project.id === target.projectId)?.name,
        toMachine: destination!.identity.name,
        text: params.text.trim(),
        replyTo: params.replyTo ?? null,
        createdAt: at,
        expiresAt: at + 15 * 60_000,
        status: 'received',
        error: null
      };
      if (route) letter.contact = { coreId: route.contact.coreId, name: route.contact.name };
      let incoming = letter;
      let allowed: (() => boolean) | undefined;
      if (box) {
        incoming = { ...letter, to: { coreId: box.source.identity.coreId, threadId: target.id }, contact: { coreId: ctx.identity.coreId, name: fakeContacts(box.gateway)!.contacts.find(contact => contact.coreId === ctx.identity.coreId)!.name } };
        allowed = () => groupStamp(box.source, box.gateway) === box.stamp && !!fakeContacts(box.gateway)?.contacts.some(contact => contact.coreId === ctx.identity.coreId && contact.addedAt === box.contactAt);
      } else if (route) {
        const { gateway, contact } = route;
        const stamp = gateway === ctx ? null : groupStamp(ctx, gateway);
        const address = gateway === ctx ? letter.from : { ...letter.from, coreId: gateway.identity.coreId, threadId: mailbox(ctx, gateway, source.id, contact.coreId).id };
        const name = fakeContacts(destination!)!.contacts.find(contact => contact.coreId === gateway.identity.coreId)!.name;
        incoming = { ...letter, from: address, contact: { coreId: gateway.identity.coreId, name } };
        allowed = () => (gateway === ctx || groupStamp(ctx, gateway) === stamp) && !!fakeContacts(gateway)?.contacts.some(entry => entry.coreId === contact.coreId && entry.addedAt === contact.addedAt) && openedTo(destination!, gateway, target);
      }
      if (allowed) deliveredFrom.set(incoming, { source: ctx, thread: source, canonical: letter, allowed });
      ctx.letters.set(source.id, [...(ctx.letters.get(source.id) ?? []), letter]);
      ctx.emit('collaboration.changed', { threadId: source.id });
      destination!.letters.set(target.id, [...(destination!.letters.get(target.id) ?? []), incoming]);
      destination!.emit('collaboration.changed', { threadId: target.id });
      deliverPending(destination!, target.id);
      return structuredClone(letter);
    },
    'collaboration.search': async (params) => {
      const words = [...new Set(params.query.toLowerCase().split(/\s+/).filter(word => word.length >= 2))];
      if (words.length === 0) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'query: expected at least one word of two characters or more' });
      const matches: AgentMatch[] = [];
      for (const { contact, core } of reachable(ctx, params.threadId)) {
        const fields = { title: contact.title, project: contact.project ?? '', branch: contact.branch ?? '', agent: contact.agent ?? '', resources: contact.resources } as const;
        const route = routeTo(ctx, core.identity.coreId);
        const canRead = core === ctx || (route ? openedTo(core, route.gateway, core.thread(contact.threadId), true) : reads(core, ctx.identity.coreId));
        const chat = canRead ? chatOf(core.thread(contact.threadId)).filter(entry => entry.role !== 'system').map(entry => entry.text) : [];
        const matched = new Set<AgentMatch['matched'][number]>();
        const chatWords: string[] = [];
        const all = words.every(word => {
          const hits = (Object.keys(fields) as (keyof typeof fields)[]).filter(field => fields[field].toLowerCase().includes(word));
          for (const hit of hits) matched.add(hit);
          const inChat = chat.some(text => text.toLowerCase().includes(word));
          if (inChat) chatWords.push(word);
          return hits.length > 0 || inChat;
        });
        if (!all) continue;
        if (chatWords.length > 0) matched.add('chat');
        const excerpts = chat.filter(text => text.toLowerCase().includes(chatWords[0] ?? '\u0000')).slice(-3).map(text => text.slice(0, 200));
        matches.push({ ...contact, matched: [...matched], excerpts });
      }
      return { matches, unavailable: [] };
    },
    'collaboration.read': async (params) => {
      const found = reachable(ctx, params.threadId).find(entry => entry.contact.coreId === params.target.coreId && entry.contact.threadId === params.target.threadId);
      if (!found) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `target: ${params.target.threadId} is not a contact this thread may reach; see boite threads` });
      const route = routeTo(ctx, found.core.identity.coreId);
      if (found.core !== ctx && !(route ? openedTo(found.core, route.gateway, found.core.thread(found.contact.threadId), true) : reads(found.core, ctx.identity.coreId))) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'agents on this machine are not allowed to read conversations; enable their access in Machines on the destination' });
      const limit = params.limit ?? 30;
      const entries = chatOf(found.core.thread(found.contact.threadId)).filter(entry => (params.before === undefined || entry.at < params.before) && (entry.text.length > 0 || entry.tools.length > 0));
      return { contact: found.contact, entries: entries.slice(-limit), more: entries.length > limit };
    },
    'collaboration.wait': async (params) => {
      ctx.thread(params.threadId);
      // Fake letters arrive delivered at once: nothing is ever left to wait for.
      return { letters: [] };
    },
    'collaboration.identity': async (params) => {
      return structuredClone(ctx.identity);
    },
    'collaboration.peers': async (params) => {
      return structuredClone([...ctx.peers.values()]);
    },
    'collaboration.check': async (params) => {
      const { coreId } = params;
      const peer = trusted(ctx).find(peer => peer.coreId === coreId);
      const target = cores.get(coreId);
      if (!peer || !target || !trusts(target, ctx.identity.coreId) || !peer.viaClient && target.identity.url !== peer.url) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'machine is unreachable or mutual trust is missing' });
      }
      return { ok: true };
    },
    'collaboration.trust': async (params) => {
      const { peer } = params;
      let url: URL;
      try { url = new URL(peer.url); } catch { throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer.url: expected an HTTPS or loopback URL' }); }
      const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !loopback)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'peer.url: expected HTTPS origin, or numeric loopback HTTP' });
      if (!peer.coreId || !peer.publicKey || peer.coreId === ctx.identity.coreId) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer: expected another core public identity' });
      for (const field of ['readThreads', 'viaClient'] as const) if (peer[field] !== undefined && typeof peer[field] !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `peer.${field}: expected a boolean` });
      const previous = ctx.peers.get(peer.coreId);
      const saved = { ...peer, readThreads: peer.readThreads ?? previous?.readThreads ?? false, viaClient: peer.viaClient ?? previous?.viaClient ?? false };
      ctx.peers.set(peer.coreId, structuredClone(saved));
      migratePeer(ctx, peer.coreId);
      return structuredClone(saved);
    },
    'collaboration.untrust': async (params) => {
      const { coreId } = params;
      ctx.peers.delete(coreId);
      ctx.groupReads.delete(coreId);
      return { ok: true };
    },
    'collaboration.bridge.register': async (params) => {
      if (!trusts(ctx, params.coreId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coreId: expected a machine trusted for coordination' });
      if (typeof params.enabled !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'enabled: expected a boolean' });
      // Fake cores already exchange messages directly in memory; no socket route is needed.
      return { ok: true };
    },
    'collaboration.bridge.forward': async (params) => {
      if (typeof params.body !== 'string' || new TextEncoder().encode(params.body).byteLength > 262144) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'body: expected at most 262144 bytes' });
      // Fake public identities have no signing keys. Only the simulated in-memory transport can authenticate them.
      return { status: 403, body: trusts(ctx, params.coreId) ? 'invalid signed message' : 'unknown peer', signature: '' };
    },
    'collaboration.bridge.reply': async (_params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId: expected a request sent to this owner connection' });
    },
  } satisfies Partial<FakeMethods>;
}
