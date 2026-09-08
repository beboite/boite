import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 180_000;

/** Opt-in like the Claude one: it runs on the user's own Codex login and spends tokens. */
const live = process.env['BOITE_E2E_CODEX'] === '1' ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('codex app-server driver, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-codex-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'a real turn answers over the app-server, and a second one resumes the codex thread',
    async () => {
      const client = await harness.connect();
      // Cold on purpose: the second turn must start a new process and reach the
      // same Codex thread through thread/resume, which is what resume means here.
      await client.call('settings.set', { warmProcessMinutes: 0 });

      const project = await client.call('projects.add', { path: projectDir, name: 'codex live' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'codex' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default codex account on this machine');
      expect(account.isolationDir).toBeNull();
      expect(account.status).toBe('ok');

      // The descriptor carries one model; `model/list` gives the rest.
      const probe = await client.call('providers.probe', { providerId: 'codex', accountId: account.id });
      expect(probe.models.length).toBeGreaterThan(1);
      expect(probe.models[0]?.id).toBe('default');
      expect(probe.models.some((model) => model.default === true)).toBe(true);
      // Every real model carries its own effort scale, unlike ACP's single one.
      expect(probe.models[1]?.effort?.levels.length).toBeGreaterThan(0);
      expect(probe.probedAt).toBeGreaterThan(0);

      // The probe runs under its own synthetic thread, and nothing of it is left.
      const probeThread = `probe:codex:${account.id}`;
      await waitFor(() => harness.core.procs.liveCount(probeThread) === 0, 30_000);
      const probeTrace = await client.call('trace.get', { threadId: probeThread });
      expect(probeTrace.length).toBeGreaterThan(0);
      expect(probeTrace.filter((record) => record.exitedAt === null)).toEqual([]);

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'codex',
        accountId: account.id,
        cwd: projectDir,
        title: 'live codex',
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
      // Codex reports the tokens on thread/tokenUsage/updated; it carries no price.
      expect(done.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(done.usage?.costUsdEquivalent ?? null).toBeNull();

      const agentProcess = started.find((record) => record.exe.toLowerCase().includes('codex'));
      expect(agentProcess).toBeDefined();

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
