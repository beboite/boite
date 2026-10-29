/** Contacts: another owner's Boite, linked for agent work on the projects each side opens. Seeded with Chris. */
import { RpcErrorCode, type Contact, type ContactInvite, type ContactRequest, type ContactsState, type ContactTailscale, type ModelTier, type Thread } from '@boite/contracts';
import { RpcFailure } from '../client';
import { encodeInvite, INVITE_PREFIX, inviteShare, readInvite } from '../contact-link';
import type { FakeContext, FakeMethods } from './context';
import { checkContactTier, contactSender, coordinationConfig, decideFakeMail, deliverContactAnswer, fakeContactRoutes, fakeCore, fakeHeldMail, registerContactState, releaseFakeMail, trusts } from './coordination';

const DAY = 24 * 60 * 60_000;
const WORDS = ['amber', 'orbit', 'lantern', 'meadow', 'falcon', 'cobalt', 'harbor', 'velvet', 'thistle', 'glacier', 'ember', 'quartz'];
/** The core's fix (`contacts/tailscale.ts`): an `acls` rule naming this machine's address and Boite's port. */
const POLICY_FIX = [
  '// Add to "acls": shared users reach Boite on this machine only.',
  JSON.stringify({ action: 'accept', src: ['autogroup:shared'], dst: ['100.101.102.103:8777'] }),
  '// Then remove "*" and "autogroup:shared" from the "src" of every other rule that reaches this machine.'
].join('\n');
const MAX_PENDING = 32;
/** The core's `INVITE_TTL_MS`: an invitation lasts a day. */
const INVITE_TTL = DAY;
const DECLINED = 'The owner declined this request.';
const SMALL = new Set(['haiku', 'lite', 'oss', 'mini', 'nano']);
const FRONTIER = new Set(['opus', 'fable', 'sol', 'luna']);

/** An invitation from another owner's Boite, with its Tailscale share: what tests join, since a core refuses its own links. */
export const FAKE_CONTACT_INVITE = encodeInvite({
  v: 1, c: 'core-dana', k: 'fake-public-key-core-dana', x: 'fake-box-core-dana', m: 'dana-laptop', u: 'http://dana-laptop.tail9c1e.ts.net:8777',
  t: '0123456789abcdef'.repeat(4), e: 4_102_444_800_000, s: 'https://login.tailscale.com/admin/invite/fake-dana-share'
});

const refuse = (message: string, field?: string) =>
  new RpcFailure({ code: RpcErrorCode.Refused, message, ...(field === undefined ? {} : { data: { field } }) });
const invalid = (message: string, field?: string) =>
  new RpcFailure({ code: RpcErrorCode.InvalidParams, message, ...(field === undefined ? {} : { data: { field } }) });

/** Like the core's `text()`: 1 to `max` characters, not blank, kept as written; the error names no field. */
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${field}: expected 1 to ${max} characters`);
  return value;
}

/** The core's `modelTier` (`contacts/tier.ts`): 1 frontier, 2 mid or unknown, 3 small. */
export function modelTier(providerId: string, model: string | null | undefined): ModelTier {
  const name = `${providerId} ${model ?? ''}`.toLowerCase();
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => SMALL.has(word))) return 3;
  if (words.some(word => FRONTIER.has(word)) || /(^|[^a-z0-9])gpt-?6(?![0-9])/.test(name)) return 1;
  if (words.includes('gemini') && words.includes('pro')) return 1;
  return 2;
}

const states = new WeakMap<FakeContext, ContactsState>();
const replies = new WeakMap<FakeContext, Map<string, number>>();
export function fakeNoteSent(ctx: FakeContext, threadId: string, coreId: string): void {
  let recent = replies.get(ctx);
  if (!recent) { recent = new Map(); replies.set(ctx, recent); }
  recent.set(JSON.stringify([threadId, coreId]), Date.now());
}
function forgetReplies(ctx: FakeContext, coreId: string, projectId?: string): void {
  for (const key of replies.get(ctx)?.keys() ?? []) {
    const [thread, peer] = JSON.parse(key) as [string, string];
    if (peer === coreId && (projectId === undefined || ctx.threads.get(thread)?.projectId === projectId)) replies.get(ctx)!.delete(key);
  }
}
export function fakeMayReach(ctx: FakeContext, coreId: string, threadId: string): boolean {
  const contact = contactFor(ctx, coreId), thread = ctx.threads.get(threadId);
  if (!contact || !thread || thread.archived) return false;
  return contact.grants.some(g => g.projectId === thread.projectId) || Date.now() - (replies.get(ctx)?.get(JSON.stringify([threadId, coreId])) ?? 0) <= 7 * DAY;
}
/** Shares an invitee without a key was sent to: the next join with the link goes through, as once the owner accepted it. */
const opened = new WeakMap<FakeContext, Set<string>>();
/** Each core's open invitation tokens: a join spends one, cancelling spends them all. */
const tokens = new WeakMap<FakeContext, Set<string>>();
const requests = new WeakMap<ContactRequest, { source: FakeContext; request: ContactRequest; valid: () => boolean }>();

function tokensOf(ctx: FakeContext): Set<string> {
  let live = tokens.get(ctx);
  if (!live) {
    live = new Set();
    tokens.set(ctx, live);
  }
  return live;
}

function tailscale(apiKey: boolean): ContactTailscale {
  return apiKey
    ? { fqdn: 'boite-pc.tail4f2a.ts.net', apiKey: true, policy: 'open', policyFix: POLICY_FIX }
    : { fqdn: 'boite-pc.tail4f2a.ts.net', apiKey: false, policy: 'unknown' };
}

/** Chris, connected, with one project each way, one request waiting and one this core made earlier. */
function seed(ctx: FakeContext): ContactsState {
  const at = ctx.now();
  const mine = ctx.projects.find(project => !project.archived) ?? ctx.projects[0];
  const chris: Contact = {
    coreId: 'core-chris',
    name: 'Chris',
    machine: 'chris-desktop',
    fingerprint: 'amber orbit lantern meadow falcon cobalt harbor velvet',
    role: 'host',
    trusted: false,
    grants: mine ? [{ projectId: mine.id, readThreads: false, grantedAt: at - 3 * DAY }] : [],
    offers: [{ projectId: 'chris-website', name: 'website' }],
    link: 'connected',
    lastSeenAt: at,
    addedAt: at - 5 * DAY
  };
  const from = { coreId: chris.coreId, machine: chris.machine, resources: '', status: 'running' as const, mode: 'team' as const };
  const requests: ContactRequest[] = [
    {
      id: 'creq-pending',
      direction: 'in',
      coreId: chris.coreId,
      contact: chris.name,
      from: { ...from, threadId: 'chris-thread-login', title: 'Fix the login redirect', project: 'website', agent: 'claude claude-opus-5-5', branch: 'fix/login-redirect' },
      text: 'An agent on a project like the Boite pairing flow: our site embeds it and the redirect loops after login.',
      gitRemote: 'https://github.com/chris/website.git',
      createdAt: at - 12 * 60_000,
      status: 'pending'
    },
    {
      id: 'creq-done',
      direction: 'out',
      coreId: chris.coreId,
      contact: chris.name,
      from: { ...from, coreId: ctx.identity.coreId, machine: ctx.identity.name, threadId: 'thread-docs', title: 'Document the website embed', project: mine?.name ?? 'boite', agent: 'claude claude-opus-5-5' },
      text: 'An agent on the website that embeds Boite, to check the docs against its code.',
      createdAt: at - 2 * DAY,
      status: 'accepted',
      project: { id: 'chris-website', name: 'website' },
      decidedBy: 'match',
      decidedAt: at - 2 * DAY + 4_000
    }
  ];
  return {
    self: { coreId: ctx.identity.coreId, machine: ctx.identity.name },
    contacts: [chris],
    requests,
    settings: { minTier: 1 },
    tailscale: tailscale(true),
    invitations: 0,
    internet: true,
    funnel: null
  };
}

export function contactState(ctx: FakeContext): ContactsState {
  let state = states.get(ctx);
  if (!state) {
    state = seed(ctx);
    states.set(ctx, state);
  }
  return state;
}

/** A group mirror exposes only this member's grants, under the exact gateway's admission. */
export function contactFor(ctx: FakeContext, id: string, via?: string): (Contact & {via?: string}) | undefined {
  if (!via || via === ctx.identity.coreId) {
    const direct = contactState(ctx).contacts.find(c => c.coreId === id);
    if (direct) return direct;
    if (via) return undefined;
  }
  const roster = ctx.roster;
  if (!roster?.cores.some(c => c.coreId === ctx.identity.coreId)) return undefined;
  for (const peer of roster.cores) {
    if (peer.coreId === ctx.identity.coreId || via && peer.coreId !== via) continue;
    const gateway = fakeCore(peer.coreId);
    if (gateway?.roster?.id !== roster.id || !gateway.roster.cores.some(c => c.coreId === ctx.identity.coreId && c.epoch === roster.cores.find(c => c.coreId === ctx.identity.coreId)?.epoch)) continue;
    const contact = contactState(gateway).contacts.find(c => c.coreId === id);
    const grants = contact?.grants.filter(g => g.machine === ctx.identity.coreId).map(({machine: _machine, ...g}) => g);
    if (contact && grants?.length) return {...contact, via: peer.coreId, grants};
  }
  return undefined;
}

function contactOf(state: ContactsState, coreId: unknown): Contact {
  const contact = state.contacts.find(entry => entry.coreId === coreId);
  if (!contact) throw invalid(`coreId: ${String(coreId)} is not a contact of this machine`, 'coreId');
  return contact;
}

/** A contact by name (any case, spaces as hyphens) or core id, as the core's `named` finds it. */
function named(state: ContactsState, value: unknown): Contact {
  if (typeof value !== 'string' || !value.trim()) throw invalid('contact: expected the name or core id of a contact; see boite threads contacts', 'contact');
  const wanted = value.trim().toLowerCase();
  const found = state.contacts.find(contact => contact.coreId === wanted)
    ?? state.contacts.find(contact => contact.name.toLowerCase() === wanted || contact.name.replace(/\s+/g, '-').toLowerCase() === wanted);
  if (!found) throw invalid(`contact: ${value} is not one of this core's contacts; see boite threads contacts`, 'contact');
  return found;
}

function words(seed: number): string {
  return [0, 1, 2, 3, 4, 5, 6, 7].map(step => WORDS[(seed * 7 + step * 5) % WORDS.length]).join(' ');
}

export function contactMethods(ctx: FakeContext) {
  const changed = () => {
    ctx.emit('contacts.updated', {});
    for (const peer of ctx.roster?.cores ?? []) if (peer.coreId !== ctx.identity.coreId) fakeCore(peer.coreId)?.emit('contacts.updated', {});
  };
  const checkTier = (thread: Thread) => {
    const tier = modelTier(thread.providerId, thread.model);
    const { minTier } = contactState(ctx).settings;
    if (tier > minTier) throw new RpcFailure({
      code: RpcErrorCode.Refused,
      message: `threadId: this thread runs ${thread.providerId} ${thread.model ?? '(default model)'}, tier ${tier}; contacts take tier ${minTier} or better, set in Contacts`,
      data: { field: 'threadId', expected: `a thread on a model of tier ${minTier} or better` }
    });
  };
  registerContactState(ctx, () => contactState(ctx), checkTier);
  const offers = (contact: Contact) => {
    const remote = fakeCore(contact.coreId);
    const reciprocal = remote && contactState(remote).contacts.find(entry => entry.coreId === ctx.identity.coreId);
    if (!reciprocal) return;
    reciprocal.offers = contact.grants.flatMap(grant => {
      const host = grant.machine ? fakeCore(grant.machine) : ctx;
      const project = host?.projects.find(entry => entry.id === grant.projectId && !entry.archived);
      return project ? [{ projectId: project.id, name: project.name, sharedProject: {ownerCoreId: ctx.identity.coreId, coreId: host!.identity.coreId, projectId: project.id} }] : [];
    });
    remote!.emit('contacts.updated', {});
  };
  const project = (projectId: unknown) => {
    const found = ctx.projects.find(entry => entry.id === projectId);
    if (!found || found.archived) throw invalid('projectId: expected an unarchived project of this core', 'projectId');
    return found;
  };
  /** Like the core's `members.member`: another machine of this core's group, or undefined for this core. */
  const memberOf = (value: unknown): string | undefined => {
    if (value === undefined || value === null || value === '' || value === ctx.identity.coreId) return undefined;
    const coreId = text(value, 'machine', 100);
    if (!ctx.roster?.cores.some(core => core.coreId === coreId)) throw invalid('machine: expected the core id of a machine of this core\'s group', 'machine');
    return coreId;
  };
  /** The member answers for its own project, as the core asks it over the group. */
  const memberProject = (coreId: string, projectId: unknown): { id: string; name: string } => {
    const found = fakeCore(coreId)?.projects.find(entry => entry.id === projectId);
    const name = ctx.roster?.cores.find(core => core.coreId === coreId)?.name ?? coreId;
    if (!found || found.archived || found.kind === 'drafts') throw invalid(`projectId: ${name} says no unarchived project ${String(projectId)}`, 'projectId');
    return { id: found.id, name: found.name };
  };
  return {
    'contacts.get': async () => structuredClone({ ...contactState(ctx), mail: fakeHeldMail(ctx) }),
    'contacts.invite': async (params) => {
      if (params?.share !== undefined && typeof params.share !== 'boolean') throw invalid('share: expected true or false', 'share');
      if (params?.internet !== undefined && typeof params.internet !== 'boolean') throw invalid('internet: expected true or false', 'internet');
      const state = contactState(ctx);
      const fqdn = state.tailscale.fqdn ?? 'boite-pc';
      // Like the core: only a tailscale.com tailnet shares a machine or opens Funnel.
      if ((params?.share !== false || params?.internet === true) && !fqdn.endsWith('.ts.net')) {
        throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `contacts.invite: ${fqdn} is on a tailnet that cannot share a machine with another one (Headscale); for someone on another network, ask them to invite you, or add them to your tailnet and invite them as already on it` });
      }
      const token = `fake-contact-${++ctx.seq}`;
      const internet = params?.internet === true;
      // Like the core: an invitee already on Tailscale, or reached through Funnel, gets the link alone.
      const share: ContactInvite['share'] = params?.share === false || internet ? { status: 'none' }
        : state.tailscale.apiKey ? { status: 'created', url: `https://login.tailscale.com/admin/invite/${token}` }
        : { status: 'manual', reason: 'No Tailscale API key is stored: share this machine from the admin console.' };
      const url = internet ? `https://${fqdn}:8443` : `http://${fqdn}:8777`;
      tokensOf(ctx).add(token);
      state.invitations = tokensOf(ctx).size;
      // Like the core once its check went through: the internet reaches the routes.
      if (internet) state.funnel = { url, status: 'ready', checkedAt: ctx.now(), repaired: false };
      changed();
      return {
        link: encodeInvite({ v: 1, c: state.self.coreId, m: state.self.machine, u: url, t: token, e: ctx.now() + INVITE_TTL, s: share.status === 'created' ? share.url : null }),
        expiresAt: ctx.now() + DAY,
        share,
        via: internet ? 'internet' : 'tailnet'
      };
    },
    'contacts.cancelInvites': async () => {
      const state = contactState(ctx);
      const cancelled = tokensOf(ctx).size;
      tokensOf(ctx).clear();
      state.invitations = 0;
      // Like the core: Funnel comes down once no invitation or contact needs it.
      if (state.contacts.length === 0) state.funnel = null;
      changed();
      return { cancelled };
    },
    'contacts.join': async (params) => {
      const link = typeof params?.link === 'string' ? params.link.trim() : '';
      if (!link.startsWith(INVITE_PREFIX)) throw invalid(`link: expected an invitation starting with ${INVITE_PREFIX}`, 'link');
      const card = readInvite(link);
      if (!card || typeof card.c !== 'string' || !card.c) throw invalid('link: the invitation is damaged; ask for a new one', 'link');
      if (!Number.isSafeInteger(card.e)) throw invalid('link.expiresAt: expected a timestamp', 'link.expiresAt');
      if ((card.e as number) <= ctx.now()) throw invalid('link: this invitation expired; ask for a new one', 'link');
      const machine = typeof card.m === 'string' && card.m ? card.m : 'new-contact';
      const state = contactState(ctx);
      const coreId = card.c;
      if (coreId === state.self.coreId) throw invalid('link: this invitation is this core\'s own', 'link');
      if (state.contacts.some(entry => entry.coreId === coreId)) throw refuse('link: already a contact; remove it first to link again');
      if (trusts(ctx, coreId)) throw refuse('link: that core is already one of your machines');
      // Like the core: without a key nothing accepts the share, and the inviter stays out of reach until the owner does.
      const share = inviteShare(link);
      const seen = opened.get(ctx) ?? new Set<string>();
      opened.set(ctx, seen);
      if (share !== null && !state.tailscale.apiKey && !seen.has(share)) {
        seen.add(share);
        throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `could not reach ${machine} at ${String(card.u)}: accept its Tailscale share, or ask for an invitation for another network, then join again` });
      }
      // Like the core: an inviter on this page spends the token, or refuses one used, cancelled or expired.
      const inviter = fakeCore(coreId);
      if (inviter) {
        if (!tokensOf(inviter).delete(String(card.t))) throw refuse('token: this invitation was already used, cancelled or expired; ask for a new one');
        contactState(inviter).invitations = tokensOf(inviter).size;
        inviter.emit('contacts.updated', {});
      }
      const seq = ++ctx.seq;
      // Like the core: a name another contact has gets a number.
      const taken = new Set(state.contacts.map(entry => entry.name.toLowerCase()));
      let name = machine;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${machine} ${n}`;
      const contact: Contact = {
        coreId, name, machine, fingerprint: words(seq), role: 'guest',
        url: typeof card.u === 'string' ? card.u : `http://${machine}.tail4f2a.ts.net:8777`, trusted: false, grants: [], offers: [],
        capabilities: {sharedProjects:1,humanLetters:1}, link: 'connected', lastSeenAt: ctx.now(), addedAt: ctx.now()
      };
      state.contacts.push(contact);
      if (inviter) {
        const hostState = contactState(inviter);
        hostState.contacts = [...hostState.contacts.filter(entry => entry.coreId !== ctx.identity.coreId), { ...contact, coreId: ctx.identity.coreId, name: ctx.identity.name, machine: ctx.identity.name, role: 'host', url: ctx.identity.url, grants: [], offers: [] }];
        inviter.emit('contacts.updated', {});
      }
      changed();
      return structuredClone(contact);
    },
    'contacts.update': async (params) => {
      const state = contactState(ctx);
      if (params?.trusted !== undefined && typeof params.trusted !== 'boolean') throw invalid('trusted: expected a boolean', 'trusted');
      const name = params?.name === undefined ? undefined : text(params.name, 'name', 100).trim();
      if (name !== undefined && state.contacts.some(entry => entry.coreId !== params.coreId && entry.name.toLowerCase() === name.toLowerCase())) {
        throw invalid('name: expected a name no other contact has', 'name');
      }
      const contact = contactOf(state, params?.coreId);
      if (name !== undefined) {
        contact.name = name;
        for (const request of state.requests) if (request.coreId === contact.coreId) request.contact = name;
      }
      if (params.trusted !== undefined) contact.trusted = params.trusted;
      offers(contact);
      // As the core: trusted now, its mail goes to its threads.
      if (contact.trusted) releaseFakeMail(ctx, contact.coreId);
      changed();
      return structuredClone(contact);
    },
    'contacts.grant': async (params) => {
      if (params?.readThreads !== undefined && typeof params.readThreads !== 'boolean') throw invalid('readThreads: expected true or false', 'readThreads');
      const machine = memberOf(params?.machine);
      const contact = contactOf(contactState(ctx), params?.coreId);
      const opened = machine === undefined ? project(params.projectId) : memberProject(machine, params.projectId);
      const grant = contact.grants.find(entry => entry.projectId === opened.id && entry.machine === machine);
      if (grant) Object.assign(grant, { readThreads: params.readThreads ?? grant.readThreads, ...(machine === undefined ? {} : { name: opened.name }) });
      else contact.grants.push({ projectId: opened.id, readThreads: params.readThreads ?? false, grantedAt: ctx.now(), ...(machine === undefined ? {} : { machine, name: opened.name }) });
      offers(contact);
      changed();
      return structuredClone(contact);
    },
    'contacts.revoke': async (params) => {
      if (typeof params?.projectId !== 'string') throw invalid('projectId: expected a project id', 'projectId');
      // Like the core: closing a project that was not open answers the contact as it is, and a machine that left may still be named.
      const machine = params.machine === undefined || params.machine === '' || params.machine === ctx.identity.coreId ? undefined : text(params.machine, 'machine', 100);
      const contact = contactOf(contactState(ctx), params.coreId);
      contact.grants = contact.grants.filter(entry => entry.projectId !== params.projectId || entry.machine !== machine);
      if (!machine) forgetReplies(ctx, params.coreId, params.projectId);
      offers(contact);
      changed();
      return structuredClone(contact);
    },
    'contacts.remove': async (params) => {
      const state = contactState(ctx);
      const contact = contactOf(state, params?.coreId);
      state.contacts = state.contacts.filter(entry => entry !== contact);
      forgetReplies(ctx, params.coreId);
      // Like the core: its requests, both ways, go with it.
      state.requests = state.requests.filter(request => request.coreId !== contact.coreId);
      const remote = fakeCore(contact.coreId);
      if (remote) {
        const other = contactState(remote);
        const reciprocal = other.contacts.find(entry => entry.coreId === ctx.identity.coreId);
        if (reciprocal) { reciprocal.link = 'offline'; reciprocal.offers = []; }
        remote.emit('contacts.updated', {});
      }
      changed();
      return { ok: true as const };
    },
    'contacts.decideMail': async (params) => decideFakeMail(ctx, params?.id, params?.accept),
    'contacts.decide': async (params) => {
      if (typeof params?.accept !== 'boolean') throw invalid('accept: expected a boolean', 'accept');
      const state = contactState(ctx);
      const request = state.requests.find(entry => entry.id === params.id && entry.direction === 'in');
      if (!request || request.status !== 'pending') throw invalid('id: expected a pending request from a contact', 'id');
      if (params.accept) {
        const opened = project(params.projectId);
        const contact = state.contacts.find(entry => entry.coreId === request.coreId);
        if (contact && !contact.grants.some(entry => entry.projectId === opened.id && !entry.machine)) contact.grants.push({ projectId: opened.id, readThreads: false, grantedAt: ctx.now() });
        if (contact) offers(contact);
        request.status = 'accepted';
        request.project = { id: opened.id, name: opened.name };
      } else {
        // Like the core: no reason reads as the owner's plain no, a blank one is refused.
        const reason: unknown = params.reason;
        const why = reason === undefined || reason === null || reason === '' ? DECLINED : text(reason, 'reason', 500);
        request.status = 'refused';
        request.reason = why;
      }
      request.decidedBy = 'owner';
      request.decidedAt = ctx.now();
      const origin = requests.get(request);
      if (origin?.valid()) {
        Object.assign(origin.request, { status: request.status, project: request.project, reason: request.reason, decidedBy: request.decidedBy, decidedAt: request.decidedAt });
        origin.source.emit('contacts.updated', {});
        deliverContactAnswer(origin.source, origin.request);
      }
      changed();
      return structuredClone(request);
    },
    'contacts.settings': async (params) => {
      const tier = params?.settings?.minTier;
      if (tier !== 1 && tier !== 2 && tier !== 3) throw invalid('settings.minTier: expected 1, 2 or 3', 'settings.minTier');
      const state = contactState(ctx);
      state.settings = { minTier: tier };
      changed();
      return structuredClone(state.settings);
    },
    'contacts.tailscaleKey': async (params) => {
      const key = params?.key;
      if (key !== null && (typeof key !== 'string' || !/^tskey-[A-Za-z0-9_-]{10,200}$/.test(key.trim()))) throw invalid('key: expected a Tailscale API key starting with tskey-, or null to clear it', 'key');
      const state = contactState(ctx);
      state.tailscale = tailscale(key !== null);
      changed();
      return structuredClone(state.tailscale);
    },
    'collaboration.contacts': async (params) => {
      ctx.thread(params?.threadId);
      // A thread that keeps to this machine sees no contact.
      const config = coordinationConfig(ctx, params.threadId);
      if (config.mode === 'off' || !config.remote) return [];
      return fakeContactRoutes(ctx).map(({ contact }) => ({ name: contact.name, coreId: contact.coreId, projects: contact.offers.map(offer => offer.name), link: contact.link }));
    },
    'collaboration.ask': async (params) => {
      const state = contactState(ctx);
      const thread = ctx.thread(params?.threadId);
      const config = coordinationConfig(ctx, params.threadId);
      if (!config.remote || config.mode === 'off' || thread.archived) throw refuse('threadId: cross-machine coordination is disabled for this thread', 'threadId');
      if (config.paused) throw refuse('coordination paused by the owner');
      const routes = fakeContactRoutes(ctx);
      const contact = named({ ...state, contacts: routes.map(row => row.contact) }, params.contact);
      const gateway = routes.find(row => row.contact === contact)!.gateway;
      // The asking thread's model is at least the tier the owner set for contacts.
      checkTier(thread);
      checkContactTier(gateway, thread);
      const body = text(params.text, 'text', 4000);
      const destination = fakeCore(contact.coreId);
      const reciprocal = destination && contactState(destination).contacts.find(entry => entry.coreId === gateway.identity.coreId);
      if (destination && reciprocal) checkContactTier(destination, thread);
      if (state.requests.filter(request => request.coreId === contact.coreId && request.direction === 'out' && request.status === 'pending').length >= MAX_PENDING) {
        throw refuse(`at most ${MAX_PENDING} requests may wait at ${contact.name}; wait for an answer`);
      }
      const request: ContactRequest = {
        id: `creq-${gateway.identity.coreId}-${++gateway.seq}`, direction: 'out', coreId: contact.coreId, contact: contact.name,
        from: { coreId: ctx.identity.coreId, threadId: params.threadId, title: thread.title, machine: ctx.identity.name, resources: config.resources, status: thread.status, mode: config.mode, agent: `${thread.providerId} ${thread.model ?? ''}`.trim() },
        text: body, createdAt: ctx.now(), status: 'pending'
      };
      state.requests.unshift(request);
      if (destination && reciprocal) {
        const incoming: ContactRequest = { ...request, from: contactSender(ctx, gateway, thread.id, contact.coreId), direction: 'in', coreId: gateway.identity.coreId, contact: reciprocal.name };
        const roster = ctx.roster;
        const sourceEpoch = roster?.cores.find(entry => entry.coreId === ctx.identity.coreId)?.epoch;
        const viaEpoch = roster?.cores.find(entry => entry.coreId === gateway.identity.coreId)?.epoch;
        const contactAt = contact.addedAt;
        requests.set(incoming, { source: ctx, request, valid: () =>
          (gateway === ctx || !!roster && ctx.roster === roster && gateway.roster === roster && roster.cores.some(entry => entry.coreId === ctx.identity.coreId && entry.epoch === sourceEpoch) && roster.cores.some(entry => entry.coreId === gateway.identity.coreId && entry.epoch === viaEpoch))
          && contactState(gateway).contacts.some(entry => entry.coreId === contact.coreId && entry.addedAt === contactAt)
        });
        contactState(destination).requests.unshift(incoming);
        destination.emit('contacts.updated', {});
      }
      changed();
      return structuredClone(request);
    }
  } satisfies Partial<FakeMethods>;
}
