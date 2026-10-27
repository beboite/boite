import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_TRANSIT_TTL_MS } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { echoThread, removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';
import { cardPart, holdTurn, leaks, openCard, saveSecret, secretValue, SpyVault, stopTurn } from './secret-fixture.ts';
import { thrown } from './settle.ts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });

/** A command `run` can start on every OS, that prints nothing. */
const quiet = { action: 'run' as const, as: 'API_KEY', command: process.execPath, args: ['-e', ''] };

test('a saved copy stays outside the legacy vault; the agent gets a ref and the value is nowhere on disk, in the logs or the export', async () => {
  const vault = new SpyVault();
  h = await startTestCore({ secretVault: () => Promise.resolve(vault) });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await holdTurn(h, owner, threadId);
  const value = secretValue();

  // The same request id opens one card and gets the same receipt.
  const firstId = `sreq_${crypto.randomUUID().replaceAll('-', '')}`;
  const early = owner.call('secrets.ask', { threadId, name: 'OPENAI_API_KEY', reason: 'retried', requestId: firstId });
  const { requestId, asked } = await openCard(h, owner, threadId, 'OPENAI_API_KEY', { requestId: firstId });
  expect(h.core.threads.get(threadId).status).toBe('waiting');
  const again = owner.call('secrets.ask', { threadId, name: 'OPENAI_API_KEY', reason: 'retried', requestId });
  const saved: string[] = [];
  h.core.bus.onAny((name, payload) => {
    const { part } = payload as { part?: { type: string; status?: string } };
    if (name === 'message.part' && part?.type === 'secret_request' && part.status === 'saved') saved.push(`${vault.given.length}`);
  });
  await owner.call('secrets.answer', { threadId, requestId, value, keep: false });
  const result = await asked;
  expect(result).toMatchObject({ requestId, outcome: 'saved', storage: 'memory' });
  expect(result.ref).toMatch(/^secret:sec_[0-9a-z]{20}$/);
  expect(await again).toEqual(result);
  expect(await early).toEqual(result);
  expect(h.core.journal.listMessages(threadId).filter(message => message.parts.some(part => part.type === 'secret_request'))).toHaveLength(1);
  // And once it closed: the answer it got, not a second card.
  expect(await owner.call('secrets.ask', { threadId, name: 'OPENAI_API_KEY', reason: 'retried', requestId })).toEqual(result);
  expect(cardPart(h, threadId, requestId)).toMatchObject({ status: 'saved', ref: result.ref });
  await waitFor(() => saved.length > 0);
  expect(saved[0]).toBe('0');
  expect(h.core.threads.get(threadId).status).toBe('running');

  // Answerable once.
  expect(await thrown(owner.call('secrets.answer', { threadId, requestId, value, keep: false }))).toThrow('already answered or closed');
  // A successful use never touches the legacy vault.
  await owner.call('secrets.use', { threadId, ref: result.ref!, use: { ...quiet, cwd: h.dataDir } });
  expect(vault.given).toHaveLength(0);
  expect(vault.taken).toHaveLength(0);
  for (const bytes of [...vault.given, ...vault.taken]) expect(bytes.every(byte => byte === 0)).toBe(true);

  // A tool's failure logged with the value in its data, as a provider's stderr can carry it.
  h.core.logs.warn(`tool failed: ${value}`, { threadId, data: { stderr: `401 for key ${value}` } });
  const exported = JSON.stringify(await owner.call('diagnostics.export', {}));
  expect(exported).toContain('OPENAI_API_KEY');
  expect(exported).not.toContain(value);
  expect(await leaks(h, value)).toEqual([]);
  expect(JSON.parse(readFileSync(join(h.dataDir, 'secrets', 'index.json'), 'utf8'))).toMatchObject({ version: 2, transit: [], kept: [], cards: [] });
});

test('a decline stores nothing, and a card closes as cancelled when its turn stops and takes no answer after', async () => {
  const vault = new SpyVault();
  h = await startTestCore({ secretVault: () => Promise.resolve(vault) });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  expect(await thrown(owner.call('secrets.ask', { threadId, name: 'API_KEY', reason: 'no turn' }))).toThrow('only while a turn runs');
  await holdTurn(h, owner, threadId);

  const declined = await openCard(h, owner, threadId, 'API_KEY');
  await owner.call('secrets.answer', { threadId, requestId: declined.requestId, declined: true });
  expect(await declined.asked).toMatchObject({ outcome: 'declined', ref: null });
  expect(vault.given).toHaveLength(0);
  expect(await vault.ids()).toEqual([]);

  // The agent's command went away: nobody would get the ref, so the card closes.
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  const orphaned = await openCard(h, agent, threadId, 'API_KEY');
  orphaned.asked.catch(() => undefined);
  agent.close();
  await waitFor(() => cardPart(h, threadId, orphaned.requestId)?.status === 'cancelled');

  const stopped = await openCard(h, owner, threadId, 'API_KEY');
  await stopTurn(h, owner, threadId);
  expect(await stopped.asked).toMatchObject({ outcome: 'cancelled', ref: null });
  expect(cardPart(h, threadId, stopped.requestId)?.status).toBe('cancelled');
  expect(await thrown(owner.call('secrets.answer', { threadId, requestId: stopped.requestId, value: secretValue(), keep: false }))).toThrow('already answered or closed');
  expect(vault.given).toHaveLength(0);
  expect(h.core.threads.get(threadId).status).not.toBe('waiting');

});

test('a copy is refused from another conversation or project without being used up, then erased at expiry and on archive', async () => {
  const vault = new SpyVault();
  h = await startTestCore({ secretVault: () => Promise.resolve(vault) });
  const owner = await h.connect();
  const { threadId, accountId } = await echoThread(h, owner);
  const projectId = h.core.threads.get(threadId).projectId!;
  const sibling = (await owner.call('threads.create', { projectId, providerId: 'echo', accountId, title: 'sibling' })).id;
  mkdirSync(join(h.dataDir, 'other'));
  const other = await owner.call('projects.add', { path: join(h.dataDir, 'other'), name: 'other' });
  const stranger = (await owner.call('threads.create', { projectId: other.id, providerId: 'echo', accountId, title: 'stranger' })).id;
  await holdTurn(h, owner, threadId);
  const value = secretValue();
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', value);

  for (const [from, cwd] of [[sibling, h.dataDir], [stranger, join(h.dataDir, 'other')]] as const) {
    expect(await thrown(owner.call('secrets.use', { threadId: from, ref, use: { ...quiet, cwd } }))).toThrow('belongs to another conversation');
  }
  // Still whole for its own conversation.
  await owner.call('secrets.use', { threadId, ref, use: { ...quiet, cwd: h.dataDir } });

  // An unused ref expires by the store's clock.
  const expiring = await saveSecret(h, owner, threadId, 'API_KEY', value);
  h.core.secrets.now = () => Date.now() + SECRET_TRANSIT_TTL_MS + 1;
  await h.core.secrets.sweep(false);
  expect(await vault.ids()).toEqual([]);
  expect(await thrown(owner.call('secrets.use', { threadId, ref: expiring, use: { ...quiet, cwd: h.dataDir } }))).toThrow('erased or never existed');
  h.core.secrets.now = () => Date.now();

  // Put away: erased at once, and still gone once the conversation comes back.
  const second = await saveSecret(h, owner, threadId, 'API_KEY', value);
  expect(await vault.ids()).toHaveLength(0);
  // Deliver the notification before archiving can also finish the turn.
  h.core.bus.emit('thread.updated', { ...h.core.threads.get(threadId), archived: true });
  expect(h.core.journal.runningTurn(threadId)).not.toBeNull();
  expect(await thrown(owner.call('secrets.use', { threadId, ref: second, use: { ...quiet, cwd: h.dataDir } }))).toThrow('erased or never existed');
  await owner.call('threads.archive', { threadId, archived: true });
  expect(await vault.ids()).toEqual([]);
  expect(await thrown(owner.call('secrets.use', { threadId, ref: second, use: { ...quiet, cwd: h.dataDir } }))).toThrow('archived conversation');
  await owner.call('threads.archive', { threadId, archived: false });
  expect(await thrown(owner.call('secrets.use', { threadId, ref: second, use: { ...quiet, cwd: h.dataDir } }))).toThrow('erased or never existed');
  expect(await leaks(h, value)).toEqual([]);
});

test('deleting the conversation or its project erases what it held', async () => {
  const vault = new SpyVault();
  h = await startTestCore({ secretVault: () => Promise.resolve(vault) });
  const owner = await h.connect();
  const { threadId, accountId } = await echoThread(h, owner);
  const projectId = h.core.threads.get(threadId).projectId!;
  const value = secretValue();
  await holdTurn(h, owner, threadId);
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', value);
  // Exercise each removal notification while its turn and ref are still live.
  h.core.bus.emit('thread.removed', { threadId });
  expect(h.core.journal.runningTurn(threadId)).not.toBeNull();
  expect(await thrown(owner.call('secrets.use', { threadId, ref, use: { ...quiet, cwd: h.dataDir } }))).toThrow('erased or never existed');
  await owner.call('threads.remove', { threadId });
  expect(await vault.ids()).toEqual([]);

  const next = (await owner.call('threads.create', { projectId, providerId: 'echo', accountId, title: 'next' })).id;
  await holdTurn(h, owner, next);
  const refs = [await saveSecret(h, owner, next, 'API_KEY', value), await saveSecret(h, owner, next, 'DEPLOY_TOKEN', `${value}-second`)];
  expect(await vault.ids()).toHaveLength(0);
  h.core.bus.emit('project.removed', { projectId });
  expect(h.core.journal.runningTurn(next)).not.toBeNull();
  for (const ref of refs) {
    expect(await thrown(owner.call('secrets.use', { threadId: next, ref, use: { ...quiet, cwd: h.dataDir } }))).toThrow('erased or never existed');
  }
  await owner.call('projects.remove', { projectId });
  expect(await vault.ids()).toEqual([]);
  expect(await leaks(h, value)).toEqual([]);
});

test('project keys and replacement are unavailable, and an agent only reads compatibility metadata for its own thread', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const projectId = h.core.threads.get(threadId).projectId!;
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    expect(await agent.call('secrets.list', { threadId })).toMatchObject({ secrets: [], storage: 'memory', encrypted: true });
    expect(await thrown(agent.call('secrets.delete', { projectId, name: 'API_KEY' }))).toThrow();
    expect(await thrown(agent.call('secrets.list', { projectId }))).toThrow();
    expect(await thrown(agent.call('secrets.answer', { threadId, requestId: 'sreq_whatever', declined: true }))).toThrow();
    expect(await thrown(agent.call('secrets.ask', { threadId, name: 'API_KEY', reason: 'again', replace: true } as never))).toThrow('replace');
    expect(await thrown(agent.call('secrets.use', { threadId, ref: 'secret:project/API_KEY', use: { ...quiet, cwd: h.dataDir } }))).toThrow('temporary');
  } finally { agent.close(); }
});

test('a restart loses memory copies and closes cards left open, without opening a system vault', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-core-'));
  try {
    let opened = 0;
    const legacy = new SpyVault(true);
    const secretVault = async () => { opened += 1; return legacy; };
    h = await startTestCore({ dataDir, secretVault });
    const owner = await h.connect();
    const { threadId } = await echoThread(h, owner);
    await holdTurn(h, owner, threadId);
    const value = secretValue();
    const ref = await saveSecret(h, owner, threadId, 'API_KEY', value);
    const turnId = h.core.journal.runningTurn(threadId)!.id;
    const left = { id: 'msg_leftovercard000000000', threadId, turnId, role: 'assistant' as const, state: 'complete' as const, createdAt: Date.now(),
      parts: [{ type: 'secret_request' as const, requestId: 'sreq_leftover1', name: 'LEFT_OPEN', reason: 'crash', placeholder: null, status: 'pending' as const, ref: null }] };
    h.core.journal.append({ type: 'message.started', threadId, version: 1, payload: left }, () => h.core.journal.putMessage(left));
    h.core.secrets.index.update(data => { data.cards.push({ requestId: 'sreq_leftover1', threadId, messageId: left.id, partIndex: 0 }); });
    await h.stop();
    expect(JSON.parse(readFileSync(join(dataDir, 'secrets', 'index.json'), 'utf8')).cards).toHaveLength(1);
    h = await startTestCore({ dataDir, secretVault });
    await waitFor(() => cardPart(h, threadId, 'sreq_leftover1')?.status === 'cancelled');
    const again = await h.connect();
    expect(await thrown(again.call('secrets.use', { threadId, ref, use: { ...quiet, cwd: dataDir } }))).toThrow('erased or never existed');
    expect(opened).toBe(0);
    expect(await leaks(h, value)).toEqual([]);
  } finally {
    await h.stop();
    await removeDir(dataDir);
  }
});

test('a phone answers over an encrypted link only, and declines over any', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const projectId = h.core.threads.get(threadId).projectId!;
  await holdTurn(h, owner, threadId);
  const pair = async (headers?: Record<string, string>) => {
    const { grant } = await owner.call('pairing.grant', {});
    return connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' }, ...(headers ? { headers } : {}) });
  };

  // Through a tunnel on this machine, plain HTTP: the socket says loopback, the Host does not.
  const plain = await pair({ host: 'phone.example' });
  try {
    expect(await plain.call('secrets.list', { projectId })).toMatchObject({ encrypted: false, secrets: [] });
    const card = await openCard(h, owner, threadId, 'API_KEY');
    expect(await thrown(plain.call('secrets.answer', { threadId, requestId: card.requestId, value: secretValue(), keep: false }))).toThrow('encrypted link');
    expect(cardPart(h, threadId, card.requestId)?.status).toBe('pending');
    await plain.call('secrets.answer', { threadId, requestId: card.requestId, declined: true });
    expect(await card.asked).toMatchObject({ outcome: 'declined' });
    expect(await thrown(plain.call('secrets.delete', { projectId, name: 'DEPLOY_TOKEN' }))).toThrow('encrypted link');
  } finally { plain.close(); }

  // On this machine, loopback both ways.
  const local = await pair();
  try {
    expect((await local.call('secrets.list', { projectId })).encrypted).toBe(true);
    const card = await openCard(h, owner, threadId, 'API_KEY');
    await local.call('secrets.answer', { threadId, requestId: card.requestId, value: secretValue(), keep: false });
    expect(await card.asked).toMatchObject({ outcome: 'saved' });
    expect(await thrown(local.call('secrets.delete', { projectId, name: 'DEPLOY_TOKEN' }))).toThrow('Secret Drop is temporary');
  } finally { local.close(); }
  expect(h.core.secrets.index.data.kept).toEqual([]);
});
