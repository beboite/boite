import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ClientContext, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { MessagePart } from '@boite/contracts';
import { SessionControls, type ControlTarget } from '../src/drivers/acp/controls.ts';
import { AcpSession } from '../src/drivers/acp/session.ts';
import { AcpTurn } from '../src/drivers/acp/turn.ts';
import type { SessionContext, TurnContext } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import { thrown } from './settle.ts';

test('ACP configuration fails when its target disappears during an injected-model retry', async () => {
  let requests = 0;
  const target: ControlTarget = {
    sessionId: 'session',
    agent: { request: async () => {
      requests++;
      target.agent = null;
      target.sessionId = null;
      throw new Error('model provider is still loading');
    } } as unknown as ClientContext,
  };
  const controls = new SessionControls(() => target);
  const option: SessionConfigOption = {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }],
  };
  controls.noteSession(null, [option], {});
  const ctx = {
    provider: { name: 'Fixture' }, thread: { model: 'gateway/model', effort: null },
    accountEnv: { BOITE_SUBSCRIPTION_PROXY_PREFIX: 'gateway/' }, log() {},
  } as unknown as SessionContext;

  expect(await thrown(controls.applyConfig(ctx))).toThrow('the acp session went away before the prompt');
  expect(requests).toBe(1);
});

for (const stopped of [false, true]) {
  test(`OpenCode 2 settles its ${stopped ? 'stopped' : 'running'} prompt before releasing the process and session`, async () => {
    const harness = await startTestCore();
    let session: AcpSession | undefined;
    try {
      const owner = await harness.connect();
      const { threadId } = await echoThread(harness, owner);
      const thread = harness.core.threads.require(threadId);
      const provider = structuredClone(harness.core.providers.require('opencode-v2'));
      const profile = {
        executable: [{ kind: 'file' as const, value: process.execPath }], detect: {}, isolation: {},
        launch: { args: [join(import.meta.dir, 'fixtures/opencode2-server.ts'), 'acp'] },
      };
      Object.assign(provider, { auth: { kind: 'none' }, env: {}, profiles: { linux: profile, windows: profile, macos: profile } });
      const parts: MessagePart[] = [];
      const order: string[] = [];
      let turn: AcpTurn;
      const ctx = {
        thread: { ...thread, providerId: provider.id, model: 'default' },
        account: harness.core.accounts.require(thread.accountId), provider,
        accountEnv: {}, sessionId: null, warmProcessMinutes: 5, prompt: '[slow]', attachments: [],
        log() {}, commands() {}, context() {},
        emit: {
          startMessage: () => 'message',
          part: (_id: string, _index: number, part: MessagePart) => parts.push(part),
          complete: () => order.push('message completed'),
        },
        spawnChild: (...args: Parameters<TurnContext['spawnChild']>) => harness.core.procs.spawnChild(threadId, ...args),
        killTree: () => {
          order.push(`process released: ${turn.settled}`);
          harness.core.procs.killTree(threadId);
        },
      } as unknown as TurnContext;
      session = new AcpSession('lifecycle', 300_000, { loadSdk: () => import('@agentclientprotocol/sdk') },
        { costPerProcess: new Set(), refusedLoads: new Set() }, () => order.push(`session ended: ${turn.settled}`));
      turn = new AcpTurn(ctx);
      session.attach(turn, 300_000);
      await waitFor(() => parts.some(part => part.type === 'tool'), 20_000);

      if (stopped) turn.markStopped();
      session.close(null);
      expect(turn.settled).toBe(true);
      expect(order).toEqual(['message completed', 'process released: true', 'session ended: true']);
      expect(await turn.done).toMatchObject({ status: stopped ? 'stopped' : 'error', error: stopped ? undefined : 'the acp session closed' });
      await waitFor(() => harness.core.procs.liveCount(threadId) === 0);
    } finally {
      session?.close(null);
      await harness.stop();
    }
  }, 30_000);
}
