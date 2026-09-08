/**
 * The focus guard against a real window, end to end.
 *
 * Opt in with `BOITE_E2E_GUARD=1`: the fixture takes the keyboard focus for a
 * few milliseconds, which is why nothing runs it on its own.
 *
 *   $env:BOITE_E2E_GUARD='1'; bun test test/guard.e2e.test.ts   # in packages/core
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

const enabled = process.env.BOITE_E2E_GUARD === '1' && process.platform === 'win32';
const describeGuard = enabled ? describe : describe.skip;
const FIXTURE = join(import.meta.dir, 'fixtures', 'guard-window.ts');

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describeGuard('the focus guard against a real window', () => {
  test('a window a thread opened is pushed back and never keeps the foreground', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const pushed = client.next('process.focusPushed', (event) => event.threadId === threadId, 30000);
    const fixtureExited = client.next(
      'process.exited',
      (record) => record.threadId === threadId && record.commandLine?.includes('guard-window') === true,
      30000,
    );
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 40000);

    await client.call('turns.start', { threadId, prompt: `[spawn:bun ${FIXTURE}]` });

    const event = await pushed;
    expect(event.pid).toBeGreaterThan(0);
    expect(event.title).toContain('Boite focus guard fixture');

    // The fixture exits 0 only when GetForegroundWindow is no longer its own
    // window: the guard put it back behind everything.
    const exit = await fixtureExited;
    expect(exit.exitCode).toBe(0);
    await finished;
  }, 60000);
});
