import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 120_000;

/** Opt-in like the Claude and OpenCode ones: it runs on the user's own Google login. */
const live = process.env['BOITE_E2E_GEMINI'] === '1' ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('gemini cli acp driver, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-gemini-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'a real turn answers over acp, and the thread mode reaches the agent',
    async () => {
      const client = await harness.connect();
      const logs: string[] = [];
      client.on('core.log', (entry) => {
        logs.push(`${entry.level} ${entry.message}`);
      });

      const project = await client.call('projects.add', { path: projectDir, name: 'gemini live' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'gemini' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default gemini account on this machine');
      // The default account is the user's own `~/.gemini`, logged in outside Boite.
      expect(account.isolationDir).toBeNull();
      expect(account.status).toBe('ok');

      // The descriptor carries one model; whatever else Gemini offers it lists itself.
      const probe = await client.call('providers.probe', { providerId: 'gemini', accountId: account.id });
      expect(probe.models[0]?.id).toBe('default');
      expect(probe.probedAt).toBeGreaterThan(0);
      const probeThread = `probe:gemini:${account.id}`;
      await waitFor(() => harness.core.procs.liveCount(probeThread) === 0, 30_000);
      const probeTrace = await client.call('trace.get', { threadId: probeThread });
      expect(probeTrace.length).toBeGreaterThan(0);
      expect(probeTrace.filter((record) => record.exitedAt === null)).toEqual([]);

      // Gemini spells this mode `autoEdit`; a thread on `acceptEdits` has to
      // find it, and the driver only logs when it cannot.
      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'gemini',
        accountId: account.id,
        cwd: projectDir,
        title: 'live gemini',
        permissionMode: 'acceptEdits',
      });
      const threadId = thread.id;
      expect(thread.permissionMode).toBe('acceptEdits');
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

      expect(started.length).toBeGreaterThan(0);
      const answer = await client.call('threads.get', { threadId });
      expect(answer.sessionId).not.toBeNull();
      expect(assistantText(answer.messages).toLowerCase()).toContain('pong');

      // The mapping went out and the agent took it: either failure is a warning.
      expect(logs.filter((line) => line.includes('no session mode matches'))).toEqual([]);
      expect(logs.filter((line) => line.includes('refused the session mode'))).toEqual([]);
    },
    TURN_TIMEOUT_MS * 2,
  );
});
