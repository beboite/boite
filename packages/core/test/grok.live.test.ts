import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 180_000;

/**
 * Opt-in like the OpenCode one: it runs on the user's own Grok login and spends
 * tokens. It only ever touches the default account, which reads `~/.grok`, and
 * it never sets `GROK_HOME`: a Grok started on an empty home opens a browser.
 */
const live = process.env['BOITE_E2E_GROK'] === '1' ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('grok acp driver, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-grok-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'a real turn answers over acp on a named model and effort, and a second one resumes the session',
    async () => {
      const client = await harness.connect();
      // Cold on purpose: the second turn must start a new process and reach the
      // same session through session/load, which is what resume means here.
      await client.call('settings.set', { warmProcessMinutes: 0 });

      const project = await client.call('projects.add', { path: projectDir, name: 'grok live' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'grok' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default grok account on this machine');
      // The user's own `~/.grok/auth.json`, never a home of Boite's making.
      expect(account.isolationDir).toBeNull();
      expect(account.status).toBe('ok');

      // The descriptor carries one model; the agent lists the rest itself, each
      // with its own reasoning effort scale.
      const probe = await client.call('providers.probe', { providerId: 'grok', accountId: account.id });
      expect(probe.models.length).toBeGreaterThan(1);
      expect(probe.models[0]?.id).toBe('default');
      const named = probe.models[1];
      expect(named).toBeDefined();
      const effort = named?.effort?.default ?? null;
      expect(effort).not.toBeNull();

      const probeThread = `probe:grok:${account.id}`;
      await waitFor(() => harness.core.procs.liveCount(probeThread) === 0, 30_000);
      const probeTrace = await client.call('trace.get', { threadId: probeThread });
      expect(probeTrace.length).toBeGreaterThan(0);
      expect(probeTrace.filter((record) => record.exitedAt === null)).toEqual([]);

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'grok',
        accountId: account.id,
        cwd: projectDir,
        title: 'live grok',
        model: named?.id ?? 'default',
        ...(effort === null ? {} : { effort }),
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

      // The mode is what rides on the command line here; the model and the
      // effort went out as a `session/set_model`, which leaves no trace on argv.
      const agentProcess = started[0];
      expect(agentProcess).toBeDefined();
      const commandLine = agentProcess?.commandLine ?? '';
      if (commandLine.length > 0) {
        expect(commandLine).toContain('stdio');
        expect(commandLine).toContain('--permission-mode');
        expect(commandLine).not.toContain('--reasoning-effort');
      }

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
