/** Coordination between threads, on this core and on the other fake cores it trusts. */
import { defaultCoordinationConfig, RpcErrorCode, type AgentContact, type AgentLetter, type AgentMatch, type CoordinationConfig, type CoordinationView, type Thread, type ThreadId } from '@boite/contracts';
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

export function coordinationConfig(ctx: FakeContext, threadId: ThreadId): CoordinationConfig {
  if (ctx.thread(threadId).agentSessionId) return { ...defaultCoordinationConfig(), mode: 'off', remote: false };
  return ctx.coordination.get(threadId) ?? defaultCoordinationConfig();
}

function coordinationView(ctx: FakeContext, threadId: ThreadId): CoordinationView {
  const config = coordinationConfig(ctx, threadId);
  const letters = ctx.letters.get(threadId) ?? [];
  return {
    self: { coreId: ctx.identity.coreId, threadId },
    config: structuredClone(config),
    messages: structuredClone(letters),
    sent: letters.filter(letter => letter.from.coreId === ctx.identity.coreId && letter.from.threadId === threadId && letter.createdAt > ctx.now() - 3_600_000).length,
    sendLimit: null,
    wakes: 0,
    wakeLimit: null
  };
}

/** A thread as other agents see it, with the fields the real core describes it by. */
function contactOf(ctx: FakeContext, thread: Thread, coreId: string, machine: string): AgentContact {
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
    .map(thread => ({ contact: contactOf(ctx, thread, ctx.identity.coreId, ctx.identity.name), core: ctx }));
  if (sourceConfig.remote) for (const peer of ctx.peers.values()) {
    const target = cores.get(peer.coreId);
    if (!target || !target.peers.has(ctx.identity.coreId)) continue;
    for (const thread of target.threads.values()) {
      const config = coordinationConfig(target, thread.id);
      if (!thread.archived && config.mode !== 'off' && config.remote) found.push({ contact: contactOf(target, thread, peer.coreId, peer.name), core: target });
    }
  }
  return found;
}

/** Fake delivery is immediate, but it still respects pauses and restores the owning project. */
function deliverPending(ctx: FakeContext, threadId: ThreadId): void {
  const thread = ctx.thread(threadId);
  const config = coordinationConfig(ctx, threadId);
  if (thread.archived || config.mode === 'off' || config.paused || ['error', 'waiting', 'queued'].includes(thread.status)) return;
  for (const letter of ctx.letters.get(threadId) ?? []) {
    if (letter.status !== 'received' || letter.to.coreId !== ctx.identity.coreId || letter.to.threadId !== threadId) continue;
    if (letter.expiresAt <= ctx.now()) { letter.status = 'expired'; continue; }
    const sender = cores.get(letter.from.coreId);
    const source = sender?.threads.get(letter.from.threadId);
    if (!sender || !source) continue;
    const sourceConfig = coordinationConfig(sender, source.id);
    if (sourceConfig.mode === 'off') continue;
    const sameProject = sender === ctx && source.projectId === thread.projectId;
    if (!sameProject && !(config.remote && sourceConfig.remote)) continue;
    if (sender !== ctx && !(ctx.peers.has(sender.identity.coreId) && sender.peers.has(ctx.identity.coreId))) continue;
    if (thread.projectId !== null && ctx.projects.find(project => project.id === thread.projectId)?.archived) archiveProject(ctx, thread.projectId, false);
    letter.status = 'delivered';
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
      if (thread.agentSessionId || thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coordination requires an unarchived ordinary thread' });
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
        .map(thread => contactOf(ctx, thread, ctx.identity.coreId, ctx.identity.name))
        .filter(agent => agent.mode !== 'off')
        .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
      const unavailable: string[] = [];
      if (sourceConfig.remote) for (const peer of ctx.peers.values()) {
        const target = cores.get(peer.coreId);
        if (!target || !target.peers.has(ctx.identity.coreId)) { unavailable.push(peer.name); continue; }
        for (const thread of target.threads.values()) {
          const config = coordinationConfig(target, thread.id);
          if (thread.archived || config.mode === 'off' || !config.remote) continue;
          agents.push(contactOf(target, thread, peer.coreId, peer.name));
        }
      }
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
      const destination = params.to.coreId === ctx.identity.coreId ? ctx : cores.get(params.to.coreId);
      const target = destination ? destination.threads.get(params.to.threadId) : undefined;
      if (!target || target.archived || coordinationConfig(destination!, target.id).mode === 'off') {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'recipient is unavailable for coordination' });
      }
      if (destination === ctx && target.projectId !== source.projectId && !(config.remote && coordinationConfig(ctx, target.id).remote)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'both threads must allow coordination across projects' });
      }
      if (destination !== ctx && (!config.remote || !ctx.peers.has(params.to.coreId) || !destination || !destination.peers.has(ctx.identity.coreId) || !coordinationConfig(destination, target.id).remote)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'remote core is not trusted' });
      }
      const letter: AgentLetter = {
        id: params.requestId,
        from: contactOf(ctx, source, ctx.identity.coreId, ctx.identity.name),
        to: params.to,
        toTitle: target?.title ?? ctx.peers.get(params.to.coreId)?.name ?? params.to.threadId,
        toProject: destination!.projects.find(project => project.id === target.projectId)?.name,
        toMachine: destination === ctx ? ctx.identity.name : ctx.peers.get(params.to.coreId)?.name,
        text: params.text.trim(),
        replyTo: params.replyTo ?? null,
        createdAt: ctx.now(),
        expiresAt: ctx.now() + 15 * 60_000,
        status: 'received',
        error: null
      };
      ctx.letters.set(source.id, [...(ctx.letters.get(source.id) ?? []), letter]);
      ctx.emit('collaboration.changed', { threadId: source.id });
      destination!.letters.set(target.id, [...(destination!.letters.get(target.id) ?? []), letter]);
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
        const canRead = core === ctx || core.peers.get(ctx.identity.coreId)?.readThreads === true;
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
      if (!found) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `target: ${params.target.threadId} is not a contact this thread may reach; see boite agents list` });
      if (found.core !== ctx && found.core.peers.get(ctx.identity.coreId)?.readThreads !== true) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'agents on this machine are not allowed to read conversations; enable their access in Machines on the destination' });
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
      const peer = ctx.peers.get(coreId);
      const target = cores.get(coreId);
      if (!peer || !target || !target.peers.has(ctx.identity.coreId) || !peer.viaClient && target.identity.url !== peer.url) {
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
      return structuredClone(saved);
    },
    'collaboration.untrust': async (params) => {
      const { coreId } = params;
      ctx.peers.delete(coreId);
      return { ok: true };
    },
    'collaboration.bridge.register': async (params) => {
      if (!ctx.peers.has(params.coreId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coreId: expected a machine trusted for coordination' });
      if (typeof params.enabled !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'enabled: expected a boolean' });
      // Fake cores already exchange messages directly in memory; no socket route is needed.
      return { ok: true };
    },
    'collaboration.bridge.forward': async (params) => {
      if (typeof params.body !== 'string' || new TextEncoder().encode(params.body).byteLength > 262144) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'body: expected at most 262144 bytes' });
      // Fake public identities have no signing keys. Only the simulated in-memory transport can authenticate them.
      return { status: 403, body: ctx.peers.has(params.coreId) ? 'invalid signed message' : 'unknown peer', signature: '' };
    },
    'collaboration.bridge.reply': async (_params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId: expected a request sent to this owner connection' });
    },
  } satisfies Partial<FakeMethods>;
}
