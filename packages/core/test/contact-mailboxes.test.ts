import { afterEach, expect, test } from 'bun:test';
import { echoThread, holdAccountTurns, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';
import { ContactMailboxes } from '../src/contacts/mailboxes.ts';

const cores: TestCore[] = [];
afterEach(async () => {
  await Promise.all(cores.map(h => h.core.group.close()));
  for (const h of cores.splice(0)) await h.stop();
});

async function routed() {
  const a = await startTestCore(), b = await startTestCore(), c = await startTestCore();
  cores.push(a, b, c);
  const ai = a.core.coordination.card().coreId, bi = b.core.coordination.card().coreId, ci = c.core.coordination.card().coreId;
  await a.core.group.create('Test owner');
  await a.core.group.invite().then(({ invite }) => b.core.group.join(invite));
  c.core.contacts.selfUrl = async () => c.url;
  await b.core.contacts.join((await c.core.contacts.invite(false)).link);
  await waitFor(() => c.core.contacts.linked(bi));
  for (const h of cores) h.core.contacts.setSettings({ minTier: 2 });
  const ac = await a.connect(), cc = await c.connect();
  const source = (await echoThread(a, ac, 'Actual initiating thread')).threadId;
  const recipient = (await echoThread(c, cc, 'External contact worker')).threadId;
  c.core.contacts.grant({ coreId: bi, projectId: c.core.threads.require(recipient).projectId! });
  return { a, b, c, ai, bi, ci, ac, source, recipient };
}

test('a group contact route keeps letters and the wake on the initiating core without a gateway thread', async () => {
  const { a, b, c, ai, bi, ci, ac, source, recipient } = await routed();
  const contacts = await ac.call('collaboration.contacts', { threadId: source });
  expect(contacts.some(contact => contact.coreId === ci)).toBe(true);
  expect(a.core.coordination.instructions(source)).toContain('threads contacts');
  const directory = await a.core.coordination.directory(source);
  expect(directory.agents.some(agent => agent.coreId === ci && agent.threadId === recipient)).toBe(true);
  const params = { threadId: source, to: { coreId: ci, threadId: recipient }, text: 'Which port does the project use?', requestId: 'routed-question' };
  const sent = await a.core.coordination.send(params);
  expect((await a.core.coordination.send(params)).id).toBe(sent.id);
  expect(sent.from).toMatchObject({ coreId: ai, threadId: source });
  await waitFor(() => c.core.coordination.get(recipient).messages.some(letter => letter.id === sent.id), 10000);
  const incoming = c.core.coordination.get(recipient).messages.find(letter => letter.id === sent.id)!;
  expect(incoming.from).toMatchObject({ coreId: bi, title: 'Actual initiating thread', agent: sent.from.agent });
  expect(incoming.from.threadId).toMatch(/^cmb_/);
  const resume = holdAccountTurns(a);
  const response = await c.core.coordination.send({ threadId: recipient, to: incoming.from, replyTo: incoming.id, text: 'Port 8080.', requestId: 'routed-answer' });
  try {
    // The gateway polls before the initiating core can submit its queued wake.
    await waitFor(() => b.core.coordination.mailboxes.received(response.id)?.status === 'uncertain');
  } finally { resume(); }
  await waitFor(() => a.core.coordination.get(source).messages.some(letter => letter.id === response.id && letter.status === 'delivered'), 12000);
  const returned = a.core.coordination.get(source).messages.find(letter => letter.id === response.id)!;
  expect(returned).toMatchObject({ from: { coreId: ci, threadId: recipient }, to: { coreId: ai, threadId: source }, replyTo: sent.id, contact: { coreId: ci }, text: 'Port 8080.' });
  expect(a.core.coordination.get(source).wakes).toBe(1);
  expect(a.core.coordination.get(source).messages.filter(letter => letter.id === sent.id)).toHaveLength(1);
  await waitFor(() => c.core.coordination.get(recipient).messages.find(letter => letter.id === response.id)?.status === 'delivered', 10000);
  expect(b.core.journal.listThreads()).toHaveLength(0);
  expect(a.core.coordination.trusted().some(peer => peer.coreId === ci)).toBe(false);
}, 30000);

test('older uncertain mailbox receipts do not block a new routed reply', async () => {
  const { a, b, c, ci, ac, source, recipient } = await routed();
  const sources = [source];
  for (let i = 0; i < 4; i++) sources.push((await echoThread(a, ac, `Initiating thread ${i}`)).threadId);
  const resume = holdAccountTurns(a);
  const responses: { id: string }[] = [];
  try {
    for (const [i, threadId] of sources.entries()) {
      const sent = await a.core.coordination.send({ threadId, to: { coreId: ci, threadId: recipient }, text: `Question ${i}`, requestId: `fair-question-${i}` });
      await waitFor(() => c.core.coordination.get(recipient).messages.some(letter => letter.id === sent.id));
      const incoming = c.core.coordination.get(recipient).messages.find(letter => letter.id === sent.id)!;
      const response = await c.core.coordination.send({ threadId: recipient, to: incoming.from, replyTo: incoming.id, text: `Answer ${i}`, requestId: `fair-answer-${i}` });
      responses.push(response);
      if (i < 4) await waitFor(() => b.core.coordination.mailboxes.received(response.id)?.status === 'uncertain');
    }
    // All four earlier wakes remain held while the fifth reply crosses the gateway.
    await waitFor(() => a.core.coordination.get(sources[4]!).messages.some(letter => letter.id === responses[4]!.id));
    expect(responses.slice(0, 4).every(response => b.core.coordination.mailboxes.received(response.id)?.status === 'uncertain')).toBe(true);
  } finally { resume(); }
  await waitFor(() => responses.every(response => c.core.coordination.get(recipient).messages.find(letter => letter.id === response.id)?.status === 'delivered'), 12000);
  expect(sources.map(threadId => a.core.coordination.get(threadId).wakes)).toEqual([1, 1, 1, 1, 1]);
}, 30000);

test('a routed ask returns its decision to the initiating thread, including after an automatic pause', async () => {
  const { a, b, c, ci, ac, source } = await routed();
  const asked = await ac.call('collaboration.ask', { threadId: source, contact: ci, text: 'An agent on the opened project' });
  expect(asked.from).toMatchObject({ coreId: a.core.coordination.card().coreId, threadId: source });
  a.core.coordination.pause(source, 'restart');
  const incoming = () => (c.core.journal.getSetting('contacts:requests') as { id: string; remoteId: string }[] ?? []).find(request => request.remoteId === asked.id);
  await waitFor(() => incoming() !== undefined, 10000);
  c.core.contacts.decide({ id: incoming()!.id, accept: false, reason: 'No matching project.' });
  await waitFor(() => a.core.coordination.get(source).messages.some(letter => letter.origin === 'contact' && letter.status === 'delivered'), 12000);
  expect(a.core.coordination.get(source).config.paused).toBe(false);
  expect(a.core.coordination.get(source).messages.find(letter => letter.origin === 'contact')?.text).toContain('No matching project.');
  expect(b.core.journal.listThreads()).toHaveLength(0);
}, 30000);

test('ask refuses a differently-cased direct core id without treating it as a group route', async () => {
  const { a, c, ci, source } = await routed();
  await a.core.contacts.join((await c.core.contacts.invite(false)).link);
  const error = await thrown(a.core.coordination.mailboxes.ask({ threadId: source, contact: ci.toUpperCase(), text: 'An agent for this project' }));
  expect(error).toThrow('contact: expected one unambiguous contact');
});

test('ask refuses a group route removed while contacts are being discovered', async () => {
  const { a, bi, ci, source } = await routed();
  const contacts = a.core.coordination.mailboxes.contacts.bind(a.core.coordination.mailboxes);
  a.core.coordination.mailboxes.contacts = async threadId => {
    const result = await contacts(threadId);
    a.core.group.remove(bi);
    return result;
  };
  expect(await thrown(a.core.coordination.mailboxes.ask({ threadId: source, contact: ci, text: 'An agent for this project' }))).toThrow('route: the group contact route is no longer available');
});

test.each(['remote disabled', 'archived', 'group removed'] as const)('routed read withholds a deferred transcript when the source is %s', async change => {
  const { a, b, c, bi, ci, source, recipient } = await routed();
  c.core.contacts.grant({ coreId: bi, projectId: c.core.threads.require(recipient).projectId!, readThreads: true });
  const started = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const request = b.core.coordination.request.bind(b.core.coordination);
  b.core.coordination.request = async (peer, operation, payload) => {
    const answer = await request(peer, operation, payload);
    if (operation === 'read') { started.resolve(); await released.promise; }
    return answer;
  };
  const pending = thrown(a.core.coordination.read(source, { coreId: ci, threadId: recipient }));
  await started.promise;
  if (change === 'group removed') a.core.group.remove(bi);
  else if (change === 'archived') a.core.threads.archive(source, true);
  else a.core.coordination.configure(source, { ...a.core.coordination.config(source), remote: false });
  released.resolve();
  expect(await pending).toThrow(change === 'group removed' ? 'current member' : 'coordination permissions changed');
});

test('gateway model tiers, source communication and contact removal still reject routed work', async () => {
  const { a, b, c, bi, ci, source, recipient } = await routed();
  await a.core.coordination.directory(source);
  b.core.contacts.setSettings({ minTier: 1 });
  const send = (id: string) => a.core.coordination.send({ threadId: source, to: { coreId: ci, threadId: recipient }, text: id, requestId: id });
  const underTier = await send('under-tier');
  await waitFor(() => a.core.coordination.get(source).messages.find(letter => letter.id === underTier.id)?.status === 'rejected');
  expect(c.core.coordination.get(recipient).messages).toHaveLength(0);
  b.core.contacts.setSettings({ minTier: 2 });
  const sent = await send('before-source-off');
  await waitFor(() => c.core.coordination.get(recipient).messages.some(letter => letter.id === sent.id), 10000);
  const incoming = c.core.coordination.get(recipient).messages.find(letter => letter.id === sent.id)!;
  a.core.coordination.configure(source, { mode: 'off', remote: true, resources: '', paused: false });
  const response = await c.core.coordination.send({ threadId: recipient, to: incoming.from, replyTo: incoming.id, text: 'Should be refused at the source.', requestId: 'source-off-answer' });
  await waitFor(() => c.core.coordination.get(recipient).messages.find(letter => letter.id === response.id)?.status === 'rejected', 12000);
  expect(a.core.coordination.get(source).messages.some(letter => letter.id === response.id)).toBe(false);
  a.core.coordination.configure(source, { mode: 'brief', remote: true, resources: '', paused: false });
  b.core.contacts.remove(ci);
  const removed = await send('after-contact-removal');
  await waitFor(() => a.core.coordination.get(source).messages.find(letter => letter.id === removed.id)?.status === 'rejected');
  a.core.group.remove(bi);
  expect(await thrown(send('after-group-removal'))).toThrow('not trusted');
}, 30000);

test('a gateway mailbox survives store recreation and still correlates its contact reply', async () => {
  const { a, b, c, ai, ci, source, recipient } = await routed();
  const sent = await a.core.coordination.send({ threadId: source, to: { coreId: ci, threadId: recipient }, text: 'Persist this return route.', requestId: 'persist-route' });
  await waitFor(() => c.core.coordination.get(recipient).messages.some(letter => letter.id === sent.id), 10000);
  const incoming = c.core.coordination.get(recipient).messages.find(letter => letter.id === sent.id)!;
  const request = b.core.coordination.request.bind(b.core.coordination);
  let attempts = 0;
  b.core.coordination.request = async (peer, operation, payload) => {
    if (peer.coreId === ai && operation === 'contact.route' && (payload as { action?: string }).action === 'return') {
      attempts++;
      throw new Error('The initiating core is temporarily unreachable');
    }
    return request(peer, operation, payload);
  };
  const response = await c.core.coordination.send({ threadId: recipient, to: incoming.from, replyTo: incoming.id, text: 'The return route survived.', requestId: 'persist-answer' });
  await waitFor(() => attempts > 0 && b.core.coordination.mailboxes.received(response.id)?.status === 'received', 10000);
  expect(a.core.coordination.get(source).messages.some(letter => letter.id === response.id)).toBe(false);
  await b.core.coordination.mailboxes.close();
  (b.core.coordination as unknown as { mailboxes: ContactMailboxes }).mailboxes = new ContactMailboxes(b.core);
  await a.core.coordination.mailboxes.close();
  (a.core.coordination as unknown as { mailboxes: ContactMailboxes }).mailboxes = new ContactMailboxes(a.core);
  b.core.coordination.request = request;
  b.core.coordination.mailboxes.tick();
  await waitFor(() => a.core.coordination.get(source).messages.some(letter => letter.id === response.id && letter.status === 'delivered'), 12000);
  expect(a.core.coordination.get(source).messages.find(letter => letter.id === response.id)?.replyTo).toBe(sent.id);
  expect(a.core.coordination.get(source).messages.filter(letter => letter.id === response.id)).toHaveLength(1);
  expect(a.core.coordination.get(source).wakes).toBe(1);
}, 30000);

test('routed search and reads keep the external read grant, and direct discovery supersedes a remembered gateway', async () => {
  const { a, b, c, bi, ci, source, recipient } = await routed();
  expect((await a.core.coordination.search(source, 'External contact worker')).matches.filter(match => match.coreId === ci && match.threadId === recipient)).toHaveLength(1);
  expect(await thrown(a.core.coordination.read(source, { coreId: ci, threadId: recipient }))).toThrow('readThreads');
  c.core.contacts.grant({ coreId: bi, projectId: c.core.threads.require(recipient).projectId!, readThreads: true });
  expect((await a.core.coordination.read(source, { coreId: ci, threadId: recipient })).contact.threadId).toBe(recipient);
  const request = b.core.coordination.request.bind(b.core.coordination);
  b.core.coordination.request = async (peer, operation, payload) => {
    const answer = await request(peer, operation, payload);
    return operation === 'read' ? { ...(answer as object), contact: { ...c.core.coordination.describe(recipient), threadId: 'another-thread' } } : answer;
  };
  try {
    expect(await thrown(a.core.coordination.read(source, { coreId: ci, threadId: recipient }))).toThrow('transcript of another thread');
  } finally { b.core.coordination.request = request; }
  // A direct trusted link now owns this lookup instead of the remembered B route.
  a.core.coordination.trust(c.core.coordination.identity());
  c.core.coordination.trust(a.core.coordination.identity());
  expect((await a.core.coordination.search(source, 'External contact worker')).matches.filter(match => match.coreId === ci && match.threadId === recipient)).toHaveLength(1);
}, 30000);

test('a contact cannot use the group route, and removing it withdraws a reply already waiting on its source', async () => {
  const { a, b, c, bi, ci, source, recipient } = await routed();
  const peer = c.core.contacts.peers().find(entry => entry.coreId === bi)!;
  expect(await thrown(c.core.coordination.request(peer, 'contact.route', { action: 'contacts', from: c.core.coordination.describe(recipient) }))).toThrow('takes no part');
  const sent = await a.core.coordination.send({ threadId: source, to: { coreId: ci, threadId: recipient }, text: 'Ask before pausing.', requestId: 'pause-route' });
  await waitFor(() => c.core.coordination.get(recipient).messages.some(letter => letter.id === sent.id), 10000);
  const incoming = c.core.coordination.get(recipient).messages.find(letter => letter.id === sent.id)!;
  a.core.coordination.configure(source, { mode: 'brief', remote: true, resources: '', paused: true });
  const response = await c.core.coordination.send({ threadId: recipient, to: incoming.from, replyTo: incoming.id, text: 'Wait in the source inbox.', requestId: 'paused-answer' });
  await waitFor(() => a.core.coordination.get(source).messages.some(letter => letter.id === response.id && letter.status === 'received'), 10000);
  expect(a.core.coordination.get(source).wakes).toBe(0);
  b.core.contacts.remove(ci);
  await waitFor(() => a.core.coordination.get(source).messages.find(letter => letter.id === response.id)?.status === 'rejected', 10000);
  a.core.coordination.configure(source, { mode: 'brief', remote: true, resources: '', paused: false });
  expect(a.core.coordination.get(source).wakes).toBe(0);
}, 30000);

test('a remembered gateway gives way once it stops offering the contact and another member still does', async () => {
  const { a, b, c, ci, source } = await routed();
  const d = await startTestCore();
  cores.push(d);
  await a.core.group.invite().then(({ invite }) => d.core.group.join(invite));
  d.core.contacts.setSettings({ minTier: 2 });
  await d.core.contacts.join((await c.core.contacts.invite(false)).link);
  const di = d.core.coordination.card().coreId;
  await waitFor(() => c.core.contacts.linked(di));
  await waitFor(() => a.core.group.peers().some(peer => peer.coreId === di));
  expect((await a.core.coordination.mailboxes.contacts(source)).filter(entry => entry.coreId === ci)).toHaveLength(1);
  const first = a.core.coordination.mailboxes.route(source, ci)!.via;
  const gone = first === d.core.coordination.card().coreId ? d : b;
  const other = gone === d ? b : d;
  // The other gateway also opened one of this machine's projects, so the contact is already listed here.
  const entry = { coreId: ci, name: 'C', minTier: 2, link: 'connected', offers: [], grants: [{ projectId: a.core.threads.require(source).projectId!, readThreads: false }] };
  a.core.contacts.members.mirrored(other.core.coordination.card().coreId, { contacts: [entry] });
  gone.core.contacts.remove(ci);
  await a.core.coordination.mailboxes.contacts(source);
  expect(a.core.coordination.mailboxes.route(source, ci)?.via).toBe(other.core.coordination.card().coreId);
}, 30000);
