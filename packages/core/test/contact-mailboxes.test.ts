import { afterEach, expect, spyOn, test } from 'bun:test';
import { echoThread, holdAccountTurns, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';
import { ContactMailboxes } from '../src/contacts/mailboxes.ts';
import { Concierge, type ConciergeVerdict } from '../src/contacts/concierge.ts';

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

test('gateway discovery retains direct admissions when its local summaries also contain a relay', async () => {
  const {a, b, ai, ci, source} = await routed();
  const relay = {coreId: 'e'.repeat(64), name: 'Another gateway relay', projects: [], link: 'connected' as const};
  const local = [...b.core.contacts.available(), relay];
  const available = spyOn(b.core.contacts, 'available').mockReturnValue(local);
  try {
    const peer = b.core.group.peers().find(peer => peer.coreId === ai)!;
    const answer = await b.core.coordination.mailboxes.handle(peer, {action: 'contacts', from: a.core.coordination.describe(source)}) as {coreId: string; admission: number}[];
    expect(answer.find(entry => entry.coreId === ci)?.admission).toBe(b.core.contacts.find(ci)!.addedAt);
    expect(answer.some(entry => entry.coreId === relay.coreId)).toBe(false);
    expect(b.core.contacts.available()).toContain(relay);
    expect((await a.core.coordination.mailboxes.contacts(source)).some(entry => entry.coreId === ci)).toBe(true);
  } finally {available.mockRestore();}
}, 30000);

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

test('forwarding a mailbox backlog bounds deserialization and retries older failures while new replies wait', async () => {
  const { a, b, c, ai, ci, source, recipient } = await routed();
  const sent = await a.core.coordination.send({ threadId: source, to: { coreId: ci, threadId: recipient }, text: 'Create a return route.', requestId: 'batch-question' });
  await waitFor(() => c.core.coordination.get(recipient).messages.some(letter => letter.id === sent.id));
  const incoming = c.core.coordination.get(recipient).messages.find(letter => letter.id === sent.id)!;
  await b.core.coordination.mailboxes.close();
  const response = await c.core.coordination.send({ threadId: recipient, to: incoming.from, replyTo: incoming.id, text: 'A pending reply.', requestId: 'batch-answer' });
  await waitFor(() => b.core.coordination.mailboxes.received(response.id) !== null);
  const row = b.core.journal.db.query('SELECT mailbox, data FROM contact_route_letters WHERE id = ? AND direction = ?').get(response.id, 'in') as { mailbox: string; data: string };
  const template = JSON.parse(row.data);
  const payloads = new Set<string>([row.data]);
  b.core.journal.db.transaction(() => {
    for (let i = 1; i < 128; i++) {
      const id = `backlog-${i}`;
      const data = JSON.stringify({ ...template, wire: { ...template.wire, id, status: 'uncertain' }, canonical: { ...template.canonical, id } });
      b.core.journal.db.query('INSERT INTO contact_route_letters VALUES (?, ?, ?, ?)').run(id, row.mailbox, 'in', data);
      payloads.add(data);
    }
  })();
  const attempted: string[] = [];
  const retrying = Promise.withResolvers<void>();
  let held: string | null = null;
  const request = b.core.coordination.request.bind(b.core.coordination);
  b.core.coordination.request = async (peer, operation, payload) => {
    const p = payload as { action?: string; letter?: { id: string } };
    if (peer.coreId === ai && operation === 'contact.route' && p.action === 'return') {
      attempted.push(p.letter!.id);
      if (p.letter!.id === held) await retrying.promise;
      throw new Error('The initiating core is temporarily unreachable');
    }
    return request(peer, operation, payload);
  };
  const mailboxes = new ContactMailboxes(b.core);
  (b.core.coordination as unknown as { mailboxes: ContactMailboxes }).mailboxes = mailboxes;
  let parsed = 0;
  const parse = JSON.parse;
  const queries = spyOn(b.core.journal.db, 'query');
  let selections: string[] = [];
  const parsing = spyOn(JSON, 'parse').mockImplementation((data, reviver) => {
    if (payloads.has(data)) parsed++;
    return parse(data, reviver);
  });
  try {
    mailboxes.tick();
    selections = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('SELECT') && sql.includes('contact_route_letters'));
    expect(attempted).toHaveLength(4);
    expect(parsed).toBe(4);
    expect(selections).toHaveLength(2);
    for (const [i, sql] of selections.entries()) {
      const plan = b.core.journal.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(i === 0 ? ['[]'] : ['[]', 4])) as { detail: string }[];
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
    }
    const first = [...attempted];
    await new Promise(resolve => setImmediate(resolve));
    held = first[0]!;
    attempted.length = 0;
    parsed = 0;
    mailboxes.tick();
    expect(attempted).toHaveLength(4);
    expect(parsed).toBe(4);
    expect(attempted).toContain(first[0]!);
    expect(attempted.filter(id => !first.includes(id))).toHaveLength(3);
    // A retry still in flight cannot occupy the reserved slot on the next tick.
    await new Promise(resolve => setImmediate(resolve));
    attempted.length = 0;
    parsed = 0;
    mailboxes.tick();
    expect(attempted).toHaveLength(4);
    expect(parsed).toBe(4);
    expect(attempted).toContain(first[1]!);
    expect(attempted).not.toContain(first[0]!);
    expect(attempted.filter(id => !first.includes(id))).toHaveLength(3);
  } finally {
    parsing.mockRestore(); queries.mockRestore();
    retrying.resolve();
    await mailboxes.close();
  }
}, 30000);

test('a routed ask returns its decision to the initiating thread, including after an automatic pause', async () => {
  const { a, b, c, bi, ci, ac, source, recipient } = await routed();
  const asked = await ac.call('collaboration.ask', { threadId: source, contact: ci, text: 'An agent on the opened project' });
  expect(asked.from).toMatchObject({ coreId: a.core.coordination.card().coreId, threadId: source });
  a.core.coordination.pause(source, 'restart');
  const incoming = () => (c.core.journal.getSetting('contacts:requests') as { id: string; remoteId: string }[] ?? []).find(request => request.remoteId === asked.id);
  await waitFor(() => incoming() !== undefined, 10000);
  c.core.contacts.decide({ id: incoming()!.id, accept: false, reason: 'No matching project.' });
  await waitFor(() => a.core.coordination.get(source).messages.some(letter => letter.origin === 'contact' && letter.status === 'delivered'), 12000);
  expect(a.core.coordination.get(source).config.paused).toBe(false);
  expect(a.core.coordination.get(source).messages.find(letter => letter.origin === 'contact')?.text).toContain('No matching project.');
  const name = b.core.contacts.find(ci)!.name;
  expect(a.core.coordination.get(source).messages.find(letter => letter.origin === 'contact')?.text).toStartWith(`${name} refused your request:`);
  // The gateway forwards the same automatic attribution without inventing an owner reply.
  c.core.contacts.update({ coreId: bi, trusted: true });
  const decide = spyOn(Concierge.prototype, 'decide');
  try {
    for (const accept of [true, false]) {
      const verdict = Promise.withResolvers<ConciergeVerdict>();
      decide.mockReturnValueOnce(verdict.promise);
      const request = await ac.call('collaboration.ask', { threadId: source, contact: ci, text: `Project access: ${accept}` });
      a.core.coordination.pause(source, 'restart');
      verdict.resolve(accept ? { accept: true, projectId: c.core.threads.require(recipient).projectId! } : { accept: false, reason: 'No matching project.' });
      // Older cores can still send concierge refusals; current cores leave them to the owner.
      if (!accept) b.core.contacts.answered(ci, { id: request.id, status: 'refused', reason: 'No matching project.', decidedBy: 'concierge', decidedAt: Date.now() }, []);
      await waitFor(() => a.core.coordination.get(source).messages.some(letter => letter.from.threadId === request.id && letter.status === 'delivered'), 12000);
      const answer = a.core.coordination.get(source).messages.find(letter => letter.from.threadId === request.id)!;
      expect(answer.text).toStartWith(`${name}'s Boite automatically ${accept ? 'opened its project' : 'refused your request:'}`);
      if (accept) expect(answer.text).toContain(recipient);
      expect(a.core.coordination.get(source).config.paused).toBe(false);
    }
  } finally { decide.mockRestore(); }
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

test('routed lookups name a silent gateway or a contact missing machines, never an empty answer', async () => {
  const { a, b, c, bi, ci, source, recipient } = await routed();
  const gateway = a.core.group.peers().find(peer => peer.coreId === bi)!.name;
  const listed = (agents: { coreId: string; threadId: string }[]) => agents.some(agent => agent.coreId === ci && agent.threadId === recipient);
  const handle = spyOn(b.core.coordination.mailboxes, 'handle').mockRejectedValue(new Error('gateway busy'));
  try {
    // Never heard from is not "no route": the send names the member that did not answer.
    expect(await thrown(a.core.coordination.send({ threadId: source, to: { coreId: ci, threadId: recipient }, text: 'Hello', requestId: crypto.randomUUID() }))).toThrow(`${gateway} did not answer`);
    const directory = await a.core.coordination.directory(source);
    expect(listed(directory.agents)).toBe(false);
    expect(directory.unavailable).toEqual([gateway]);
    expect((await a.core.coordination.search(source, 'External contact worker')).unavailable).toEqual([gateway]);
    // The whole member is down: its own directory fails too, and it is still named once.
    const down = spyOn(b.core.coordination as unknown as { localDirectory(): unknown }, 'localDirectory').mockImplementation(() => { throw new Error('offline'); });
    try {
      expect((await a.core.coordination.directory(source)).unavailable).toEqual([gateway]);
      expect((await a.core.coordination.search(source, 'External contact worker')).unavailable).toEqual([gateway]);
    } finally { down.mockRestore(); }
  } finally { handle.mockRestore(); }
  const whole = await a.core.coordination.directory(source);
  expect(listed(whole.agents)).toBe(true);
  expect(whole.unavailable).toEqual([]);
  // The contact answers, but two machines of its own group did not: its threads stay listed beside that notice.
  const name = (await a.core.coordination.mailboxes.contacts(source)).find(entry => entry.coreId === ci)!.name;
  const members = c.core.contacts.members;
  const held = [spyOn(members, 'directory').mockResolvedValue({ entries: [], unavailable: 2 }), spyOn(members, 'search').mockResolvedValue({ entries: [], unavailable: 2 })];
  try {
    const partial = await a.core.coordination.directory(source);
    expect(listed(partial.agents)).toBe(true);
    expect(partial.unavailable).toEqual([`${name} (2 of its machines did not answer)`]);
    const search = await a.core.coordination.search(source, 'External contact worker');
    expect(listed(search.matches)).toBe(true);
    expect(search.unavailable).toEqual([`${name} (2 of its machines did not answer)`]);
  } finally { for (const spy of held) spy.mockRestore(); }
}, 30000);
