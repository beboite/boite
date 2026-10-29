import { afterEach, expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { holdTurn, openCard, SpyVault } from './secret-fixture.ts';
import { thrown } from './settle.ts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });

test('pending secret metadata is thread-filtered, owner/paired only, and closes without a history read', async () => {
  h = await startTestCore({ secretVault: () => Promise.resolve(new SpyVault()) });
  const owner = await h.connect();
  const { threadId, accountId } = await echoThread(h, owner);
  const sibling = await owner.call('threads.create', { projectId: h.core.threads.get(threadId).projectId!, providerId: 'echo', accountId, title: 'sibling' });
  await holdTurn(h, owner, threadId);
  const { requestId, asked } = await openCard(h, owner, threadId, 'API_KEY');
  const { grant } = await owner.call('pairing.grant', {});
  const paired = await connect(h.url, '', { grant, client: { name: 'test', version: 'test' } });
  const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const rows = await paired.call('secrets.pending', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: requestId, threadId, name: 'API_KEY', status: 'pending', ref: null });
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name', 'placeholder', 'reason', 'ref', 'status', 'threadId', 'turnId']);
    expect(await owner.call('secrets.pending', { threadId })).toEqual(rows);
    expect(await owner.call('secrets.pending', { threadId: sibling.id })).toEqual([]);
    expect(await thrown(agent.call('secrets.pending', { threadId }))).toThrow();
    expect(await thrown(owner.call('secrets.pending', { threadId: 42 } as never))).toThrow('threadId');
    expect(await thrown(owner.call('secrets.pending', { threadId: 'missing' }))).toThrow();
    const closed: string[] = [];
    paired.on('secret.resolved', event => closed.push(event.requestId));
    await owner.call('threads.archive', { threadId, archived: true });
    expect(await asked).toMatchObject({ outcome: 'cancelled' });
    await waitFor(() => closed.includes(requestId));
    expect(await paired.call('secrets.pending', {})).toEqual([]);
  } finally { agent.close(); paired.close(); }
});

test('pending reads expire overdue secret metadata before the timer gets a turn', async () => {
  h = await startTestCore({ secretVault: () => Promise.resolve(new SpyVault()) });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await holdTurn(h, owner, threadId);
  const { asked } = await openCard(h, owner, threadId, 'API_KEY');
  h.core.secrets.now = () => Date.now() + 61 * 60_000;
  expect(await owner.call('secrets.pending', { threadId })).toEqual([]);
  expect(await asked).toMatchObject({ outcome: 'timed_out' });
});
