import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 180_000;

/** Opt-in like the Codex one: it runs on the user's own pi login and spends tokens. */
const live = process.env['BOITE_E2E_PI'] === '1' ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('pi rpc driver, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-pi-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'a real turn answers over the rpc mode, and a second process reopens the session',
    async () => {
      const client = await harness.connect();
      // Cold on purpose: the second turn must start a new pi and reach the same
      // transcript through `--session-id`, which is what resume means here.
      await client.call('settings.set', { warmProcessMinutes: 0 });

      const project = await client.call('projects.add', { path: projectDir, name: 'pi live' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'pi' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default pi account on this machine');
      expect(account.isolationDir).toBeNull();
      expect(account.status).toBe('ok');

      // The descriptor carries one model; `get_available_models` gives the rest.
      const probe = await client.call('providers.probe', { providerId: 'pi', accountId: account.id });
      expect(probe.models.length).toBeGreaterThan(1);
      expect(probe.models[0]?.id).toBe('default');
      // Every probed id is what `--model` takes: `<provider>/<id>`.
      expect(probe.models[1]?.id).toContain('/');
      expect(probe.models.some((model) => (model.effort?.levels.length ?? 0) > 1)).toBe(true);
      expect(probe.probedAt).toBeGreaterThan(0);

      // The probe runs under its own synthetic thread, and nothing of it is left.
      const probeThread = `probe:pi:${account.id}`;
      await waitFor(() => harness.core.procs.liveCount(probeThread) === 0, 30_000);
      const probeTrace = await client.call('trace.get', { threadId: probeThread });
      expect(probeTrace.length).toBeGreaterThan(0);
      expect(probeTrace.filter((record) => record.exitedAt === null)).toEqual([]);

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'pi',
        accountId: account.id,
        cwd: projectDir,
        title: 'live pi',
      });
      const threadId = thread.id;
      expect(thread.model).toBe('default');
      await client.call('threads.subscribe', { threadId });

      const started: RpcEvents['process.started'][] = [];
      client.on('process.started', (record) => {
        if (record.threadId === threadId) started.push(record);
      });
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);

      await client.call('turns.start', { threadId, prompt: 'Reply with exactly the word: pong' });
      const done = await finished;
      expect(done.error).toBeNull();
      expect(done.status).toBe('done');
      // Unlike Codex and ACP, pi puts a real price on the wire, per message.
      expect(done.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(done.usage?.costUsdEquivalent ?? null).not.toBeNull();

      expect(started.length).toBeGreaterThan(0);

      const first = await client.call('threads.get', { threadId });
      const sessionId = first.sessionId;
      expect(sessionId).not.toBeNull();
      expect(assistantText(first.messages).toLowerCase()).toContain('pong');

      const resumed = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'Repeat the word you just said, nothing else.' });
      expect((await resumed).status).toBe('done');

      const second = await client.call('threads.get', { threadId });
      expect(second.sessionId).toBe(sessionId);
      expect(assistantText(second.messages).toLowerCase()).toContain('pong');
    },
    TURN_TIMEOUT_MS * 2,
  );
});
