/** Contacts: another owner's Boite, linked for agent work on the projects each side opens. Seeded with Chris. */
import { RpcErrorCode, type Contact, type ContactRequest, type ContactsState, type ContactTailscale } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

const DAY = 24 * 60 * 60_000;
const INVITE_PREFIX = 'boite://contact#';
const WORDS = ['amber', 'orbit', 'lantern', 'meadow', 'falcon', 'cobalt', 'harbor', 'velvet', 'thistle', 'glacier', 'ember', 'quartz'];
const POLICY_FIX = `"grants": [
  { "src": ["autogroup:shared"], "dst": ["autogroup:self:8777"], "ip": ["tcp:8777"] }
]`;

const refuse = (message: string, field?: string) =>
  new RpcFailure({ code: RpcErrorCode.Refused, message, ...(field === undefined ? {} : { data: { field } }) });
const invalid = (message: string, field: string) => new RpcFailure({ code: RpcErrorCode.InvalidParams, message, data: { field } });

const states = new WeakMap<FakeContext, ContactsState>();

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
    fingerprint: 'amber orbit lantern meadow',
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
    tailscale: tailscale(true)
  };
}

function stateOf(ctx: FakeContext): ContactsState {
  let state = states.get(ctx);
  if (!state) {
    state = seed(ctx);
    states.set(ctx, state);
  }
  return state;
}

function contactOf(state: ContactsState, coreId: unknown): Contact {
  const contact = state.contacts.find(entry => entry.coreId === coreId);
  if (!contact) throw invalid(`coreId: ${String(coreId)} is not a contact of this machine`, 'coreId');
  return contact;
}

function words(seed: number): string {
  return [0, 1, 2, 3].map(step => WORDS[(seed * 7 + step * 5) % WORDS.length]).join(' ');
}

export function contactMethods(ctx: FakeContext) {
  const changed = () => ctx.emit('contacts.updated', {});
  const project = (projectId: unknown) => {
    const found = ctx.projects.find(entry => entry.id === projectId);
    if (!found) throw invalid(`projectId: ${String(projectId)} is not a project of this machine`, 'projectId');
    return found;
  };
  return {
    'contacts.get': async () => structuredClone(stateOf(ctx)),
    'contacts.invite': async () => {
      const state = stateOf(ctx);
      const token = `fake-contact-${++ctx.seq}`;
      const card = { c: state.self.coreId, m: state.self.machine, u: `http://${state.tailscale.fqdn ?? 'boite-pc'}:8777`, t: token };
      return {
        link: INVITE_PREFIX + btoa(JSON.stringify(card)),
        expiresAt: ctx.now() + DAY,
        share: state.tailscale.apiKey
          ? { status: 'created' as const, url: `https://login.tailscale.com/admin/invite/${token}` }
          : { status: 'manual' as const, reason: 'No Tailscale API key is stored: share this machine from the admin console.' }
      };
    },
    'contacts.join': async (params) => {
      const link = typeof params?.link === 'string' ? params.link.trim() : '';
      if (!link.startsWith(INVITE_PREFIX)) throw invalid(`link: expected an invitation starting with ${INVITE_PREFIX}`, 'link');
      let machine = 'new-contact';
      try {
        const card = JSON.parse(atob(link.slice(INVITE_PREFIX.length))) as { m?: unknown };
        if (typeof card.m === 'string' && card.m) machine = card.m;
      } catch {
        throw invalid('link: the invitation is damaged; ask for a new one', 'link');
      }
      const state = stateOf(ctx);
      const seq = ++ctx.seq;
      const contact: Contact = {
        coreId: `core-${machine}-${seq}`, name: machine, machine, fingerprint: words(seq), role: 'guest',
        url: `http://${machine}.tail4f2a.ts.net:8777`, trusted: false, grants: [], offers: [],
        link: 'connected', lastSeenAt: ctx.now(), addedAt: ctx.now()
      };
      state.contacts.push(contact);
      changed();
      return structuredClone(contact);
    },
    'contacts.update': async (params) => {
      const state = stateOf(ctx);
      const contact = contactOf(state, params?.coreId);
      if (params.name !== undefined) {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > 80) throw invalid('name: expected 1 to 80 characters', 'name');
        contact.name = name;
        for (const request of state.requests) if (request.coreId === contact.coreId) request.contact = name;
      }
      if (params.trusted !== undefined) {
        if (typeof params.trusted !== 'boolean') throw invalid('trusted: expected true or false', 'trusted');
        contact.trusted = params.trusted;
      }
      changed();
      return structuredClone(contact);
    },
    'contacts.grant': async (params) => {
      const contact = contactOf(stateOf(ctx), params?.coreId);
      const opened = project(params.projectId);
      if (params.readThreads !== undefined && typeof params.readThreads !== 'boolean') throw invalid('readThreads: expected true or false', 'readThreads');
      const grant = contact.grants.find(entry => entry.projectId === opened.id);
      if (grant) grant.readThreads = params.readThreads ?? grant.readThreads;
      else contact.grants.push({ projectId: opened.id, readThreads: params.readThreads ?? false, grantedAt: ctx.now() });
      changed();
      return structuredClone(contact);
    },
    'contacts.revoke': async (params) => {
      const contact = contactOf(stateOf(ctx), params?.coreId);
      if (!contact.grants.some(entry => entry.projectId === params.projectId)) throw invalid(`projectId: ${String(params.projectId)} is not open to ${contact.name}`, 'projectId');
      contact.grants = contact.grants.filter(entry => entry.projectId !== params.projectId);
      changed();
      return structuredClone(contact);
    },
    'contacts.remove': async (params) => {
      const state = stateOf(ctx);
      const contact = contactOf(state, params?.coreId);
      state.contacts = state.contacts.filter(entry => entry !== contact);
      changed();
      return { ok: true as const };
    },
    'contacts.decide': async (params) => {
      const state = stateOf(ctx);
      const request = state.requests.find(entry => entry.id === params?.id);
      if (!request) throw invalid(`id: ${String(params?.id)} is not a request of this machine`, 'id');
      if (request.direction !== 'in') throw refuse('only the contact that was asked decides this request', 'id');
      if (request.status !== 'pending') throw refuse(`this request was already ${request.status}`, 'id');
      if (params.accept) {
        const opened = project(params.projectId);
        const contact = state.contacts.find(entry => entry.coreId === request.coreId);
        if (contact && !contact.grants.some(entry => entry.projectId === opened.id)) contact.grants.push({ projectId: opened.id, readThreads: false, grantedAt: ctx.now() });
        request.status = 'accepted';
        request.project = { id: opened.id, name: opened.name };
      } else {
        const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
        if (!reason) throw invalid('reason: a refusal needs a reason the asking agent can read', 'reason');
        request.status = 'refused';
        request.reason = reason;
      }
      request.decidedBy = 'owner';
      request.decidedAt = ctx.now();
      changed();
      return structuredClone(request);
    },
    'contacts.settings': async (params) => {
      const tier = params?.settings?.minTier;
      if (tier !== 1 && tier !== 2 && tier !== 3) throw invalid('settings.minTier: expected 1, 2 or 3', 'settings.minTier');
      const state = stateOf(ctx);
      state.settings = { minTier: tier };
      changed();
      return structuredClone(state.settings);
    },
    'contacts.tailscaleKey': async (params) => {
      const key = params?.key;
      if (key !== null && (typeof key !== 'string' || !key.trim().startsWith('tskey-'))) throw invalid('key: expected a Tailscale API key starting with tskey-, or null to clear it', 'key');
      const state = stateOf(ctx);
      state.tailscale = tailscale(key !== null);
      changed();
      return structuredClone(state.tailscale);
    },
    'collaboration.contacts': async () => stateOf(ctx).contacts.map(contact => ({
      name: contact.name, coreId: contact.coreId, projects: contact.offers.map(offer => offer.name), link: contact.link
    })),
    'collaboration.ask': async (params) => {
      const state = stateOf(ctx);
      const contact = state.contacts.find(entry => entry.name === params?.contact || entry.coreId === params?.contact);
      if (!contact) throw invalid(`contact: ${String(params?.contact)} is not a contact of this machine`, 'contact');
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      if (!text) throw invalid('text: say what kind of project the agent should work on', 'text');
      const thread = ctx.threads.get(params.threadId);
      const request: ContactRequest = {
        id: `creq-${++ctx.seq}`, direction: 'out', coreId: contact.coreId, contact: contact.name,
        from: { coreId: ctx.identity.coreId, threadId: params.threadId, title: thread?.title ?? params.threadId, machine: ctx.identity.name, resources: '', status: 'running', mode: 'team' },
        text, createdAt: ctx.now(), status: 'pending'
      };
      state.requests.unshift(request);
      changed();
      return structuredClone(request);
    }
  } satisfies Partial<FakeMethods>;
}
