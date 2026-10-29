import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 600_000;

/**
 * Opt-in: a real `hermes acp` on a model the user serves locally, so no turn
 * leaves the machine. `HERMES_E2E_BASE_URL` is the server's OpenAI-compatible
 * root on a loopback address (llama-server's `http://127.0.0.1:8080/v1`,
 * Ollama's `http://127.0.0.1:11434/v1`) and `HERMES_E2E_MODEL` the model name
 * it serves. The account is one of Boite's own: its `HERMES_HOME` holds only
 * the `config.yaml` written here, never the user's `~/.hermes`.
 */
const live = process.env['BOITE_E2E_HERMES'] === '1' ? describe : describe.skip;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The local server the run is pointed at, refused unless it is on this machine. */
function localServer(): { baseUrl: string; model: string } {
  const baseUrl = process.env['HERMES_E2E_BASE_URL'] ?? '';
  const model = process.env['HERMES_E2E_MODEL'] ?? '';
  if (baseUrl.length === 0 || model.length === 0) {
    throw new Error('HERMES_E2E_BASE_URL and HERMES_E2E_MODEL: expected the root and the model of a local OpenAI-compatible server');
  }
  if (!LOOPBACK.has(new URL(baseUrl).hostname)) {
    throw new Error(`HERMES_E2E_BASE_URL: expected a loopback address, received ${baseUrl}`);
  }
  return { baseUrl, model };
}

live('hermes acp driver, live on a local model', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-hermes-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'a real turn answers on the picked local model, and a cold second turn loads the same session',
    async () => {
      const { baseUrl, model } = localServer();
      const client = await harness.connect();
      // Cold on purpose: the second turn starts a new process and must reach
      // the same session through session/load.
      await client.call('settings.set', { warmProcessMinutes: 0 });

      const project = await client.call('projects.add', { path: projectDir, name: 'hermes live' });
      const account = await client.call('accounts.add', { providerId: 'hermes', label: 'Local model' });
      const home = account.isolationDir ?? '';
      expect(home.length).toBeGreaterThan(0);
      expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
      // What `hermes model` writes for a custom endpoint. Hermes refuses a
      // window under 64K, the size the server is started with.
      writeFileSync(
        join(home, 'config.yaml'),
        ['model:', '  provider: custom', `  default: ${model}`, `  base_url: ${baseUrl}`, '  context_length: 65536', ''].join('\n'),
        'utf8',
      );
      expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');

      // The machine's own agents are found at startup, and the descriptors that
      // finding reloads void a probe that started before: the picker's
      // "refresh models" is the answer, once.
      const read = () => client.call('providers.probe', { providerId: 'hermes', accountId: account.id, refresh: true });
      const probe = await read().catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('changed during discovery')) return read();
        throw error;
      });
      expect(probe.models[0]?.id).toBe('default');
      const named = probe.models.find((entry) => entry.id === `custom:${model}`);
      expect(named).toBeDefined();
      const probeThread = `probe:hermes:${account.id}`;
      await waitFor(() => harness.core.procs.liveCount(probeThread) === 0, 30_000);

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'hermes',
        accountId: account.id,
        cwd: projectDir,
        title: 'live hermes',
        model: named?.id ?? 'default',
      });
      const threadId = thread.id;
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
      expect(started[0]?.commandLine ?? 'acp').toContain('acp');

      const first = await client.call('threads.get', { threadId });
      const sessionId = first.sessionId;
      expect(sessionId).not.toBeNull();
      const firstText = assistantText(first.messages);
      expect(firstText.trim().length).toBeGreaterThan(0);

      await waitFor(() => harness.core.procs.liveCount(threadId) === 0, 30_000);
      const resumed = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'Repeat the word you just said, nothing else.' });
      const again = await resumed;
      expect(again.error).toBeNull();
      expect(again.status).toBe('done');

      const second = await client.call('threads.get', { threadId });
      // The same session, loaded rather than replaced.
      expect(second.sessionId).toBe(sessionId);
      expect(second.sessionGeneration).toBe(first.sessionGeneration);
      const secondText = assistantText(second.messages);
      expect(secondText.trim().length).toBeGreaterThan(0);
      console.log(`hermes live: ${model} answered ${JSON.stringify(firstText.trim())}, then ${JSON.stringify(secondText.trim())} on session ${sessionId}`);
    },
    TURN_TIMEOUT_MS * 2,
  );
});
