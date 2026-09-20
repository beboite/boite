import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 180_000;

/**
 * Opt-in: it runs the installed agy on the user's own sign-in and spends
 * tokens. One turn on the cheapest Flash level, with a one-word prompt.
 */
const live = process.env['BOITE_E2E_AGY'] === '1' ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('agy driver, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-agy-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'a real turn answers over the stream-json print mode on the default account',
    async () => {
      const client = await harness.connect();
      // Cold, so the process must be gone once the turn is over.
      await client.call('settings.set', { warmProcessMinutes: 0 });

      const project = await client.call('projects.add', { path: projectDir, name: 'agy live' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'antigravity-cli' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default Antigravity CLI account on this machine');
      expect(account.isolationDir).toBeNull();

      // `agy models` gives the list; the Flash levels fold into one model.
      const probe = await client.call('providers.probe', { providerId: 'antigravity-cli', accountId: account.id });
      console.log(`probed: ${probe.models.map((model) => `${model.id}[${model.effort?.levels.map((level) => level.id).join('/') ?? ''}]`).join(' ')}`);
      expect(probe.models[0]?.id).toBe('default');
      const flash = probe.models.find((model) => model.id === 'gemini-3.8-flash');
      expect(flash?.effort?.levels.map((level) => level.id)).toContain('low');

      const probeThread = `probe:antigravity-cli:${account.id}`;
      await waitFor(() => harness.core.procs.liveCount(probeThread) === 0, 30_000);

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'antigravity-cli',
        accountId: account.id,
        cwd: projectDir,
        title: 'live agy',
        model: 'gemini-3.8-flash',
        effort: 'low',
      });
      const threadId = thread.id;
      await client.call('threads.subscribe', { threadId });

      const started: RpcEvents['process.started'][] = [];
      client.on('process.started', (record) => {
        if (record.threadId === threadId) started.push(record);
      });
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);

      await client.call('turns.start', { threadId, prompt: 'ping' });
      const done = await finished;
      const after = await client.call('threads.get', { threadId });
      console.log(`turn: status=${done.status} error=${done.error ?? 'none'} usage=${JSON.stringify(done.usage)}`);
      console.log(`thread: sessionId=${after.sessionId ?? 'none'} context=${JSON.stringify(after.context)}`);
      console.log(`text: ${JSON.stringify(assistantText(after.messages))}`);
      console.log(`processes: ${JSON.stringify(started.map((record) => record.commandLine ?? record.exe))}`);

      expect(done.error).toBeNull();
      expect(done.status).toBe('done');
      expect(done.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(after.sessionId).not.toBeNull();
      expect(assistantText(after.messages).trim().length).toBeGreaterThan(0);
      expect(started.length).toBeGreaterThan(0);

      await waitFor(() => harness.core.procs.liveCount(threadId) === 0, 30_000);
    },
    TURN_TIMEOUT_MS * 2,
  );
});
