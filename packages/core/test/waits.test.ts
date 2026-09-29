import { afterEach, expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

// A wait a failed test leaves behind must not settle into a later test: bun
// fails whatever test runs when a stray rejection or throw lands, and that
// test's own leftover wait then fails the next one (coordination-lifecycle
// lost five tests in a row that way under a full-suite load).

const cores: TestCore[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.stop(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function settled(promise: Promise<unknown>): { value: string } {
  const state = { value: 'pending' };
  promise.then(() => { state.value = 'resolved'; }, () => { state.value = 'rejected'; });
  return state;
}

test('a wait whose core stopped stays quiet when its predicate then throws', async () => {
  const h = await startTestCore();
  const wait = settled(waitFor(() => h.core.journal.listThreads().length > 99, 60));
  await h.stop();
  // The predicate now reads a closed journal, and the timeout has passed.
  await pause(150);
  expect(wait.value).toBe('pending');
});

test('a predicate that throws on a live core rejects the wait', async () => {
  let caught: unknown = null;
  try { await waitFor(() => { throw new Error('broken predicate'); }); }
  catch (error) { caught = error; }
  expect((caught as Error).message).toBe('broken predicate');
});

test('closing a client drops its pending event waits instead of timing them out later', async () => {
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const wait = settled(client.next('turn.finished', undefined, 50));
  client.close();
  await pause(150);
  expect(wait.value).toBe('pending');
  let caught: unknown = null;
  try { await client.next('turn.finished', undefined, 50); } catch (error) { caught = error; }
  expect((caught as Error).message).toBe('the client is closed');
});

test('a core that goes away rejects a pending event wait at once', async () => {
  const h = await startTestCore(); cores.push(h);
  // Not through h.connect: the harness closes its own clients first, as their owner.
  const client = await connect(h.url, h.token);
  const started = Date.now();
  let caught: unknown = null;
  const wait = client.next('turn.finished', undefined, 5000).catch(error => { caught = error; });
  await h.stop();
  await wait;
  expect((caught as Error).message).toBe('the socket closed');
  expect(Date.now() - started).toBeLessThan(4000);
});
