import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { versionsSettled } from '../src/providers/versions.ts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 120_000;

/**
 * Opt-in: it runs OpenCode 2 on the login of the machine and spends what its
 * model costs. `BOITE_E2E_OPENCODE2_MODEL` names the model, for a free one;
 * without it the agent keeps its own.
 */
const live = process.env['BOITE_E2E_OPENCODE2'] === '1' ? describe : describe.skip;
const MODEL = process.env['BOITE_E2E_OPENCODE2_MODEL'];

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('opencode 2 acp driver, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-opencode2-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'turned on, a real turn answers over acp, a second one resumes the session, and plan mode reaches the agent',
    async () => {
      const client = await harness.connect();
      const logs: string[] = [];
      client.on('core.log', (entry) => { logs.push(`${entry.level} ${entry.message}`); });
      // Cold on purpose: each turn starts a new process and reaches the same
      // session through session/load, which is what resume means here.
      await client.call('settings.set', { warmProcessMinutes: 0 });

      // A program named `opencode` is asked its version, to tell the two majors apart. Each
      // answer lists the providers again, which a probe in flight would take for a change.
      harness.core.providers.list();
      await versionsSettled();
      await waitFor(() => harness.core.providers.summary('opencode-v2')?.available === true, 30_000);
      const before = harness.core.providers.summary('opencode-v2');
      expect(before).toMatchObject({ experimental: true, enabled: false });
      // Off, it has no account and starts nothing; turning it on adopts the login it finds.
      expect((await client.call('accounts.list', {})).some((entry) => entry.providerId === 'opencode-v2')).toBe(false);
      await client.call('providers.setEnabled', { providerId: 'opencode-v2', enabled: true });

      const project = await client.call('projects.add', { path: projectDir, name: 'opencode 2 live' });
      const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'opencode-v2' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default opencode-v2 account on this machine');
      expect(account.isolationDir).toBeNull();
      expect(account.status).toBe('ok');

      const probe = await client.call('providers.probe', { providerId: 'opencode-v2', accountId: account.id, ...(MODEL === undefined ? {} : { model: MODEL }) });
      expect(probe.models.length).toBeGreaterThan(1);
      expect(probe.models[0]?.id).toBe('default');
      if (MODEL !== undefined) expect(probe.models.some((model) => model.id === MODEL)).toBe(true);
      const probeThread = `probe:opencode-v2:${account.id}`;
      await waitFor(() => harness.core.procs.liveCount(probeThread) === 0, 20_000);

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'opencode-v2',
        accountId: account.id,
        cwd: projectDir,
        title: 'live opencode 2',
        ...(MODEL === undefined ? {} : { model: MODEL }),
      });
      const threadId = thread.id;
      await client.call('threads.subscribe', { threadId });

      const started: RpcEvents['process.started'][] = [];
      client.on('process.started', (record) => {
        if (record.threadId === threadId) started.push(record);
      });
      const turn = async (prompt: string): Promise<void> => {
        const finished = client.next('turn.finished', (done) => done.threadId === threadId, TURN_TIMEOUT_MS);
        await client.call('turns.start', { threadId, prompt });
        const done = await finished;
        expect(done.error).toBeNull();
        expect(done.status).toBe('done');
      };

      await turn('Reply with exactly the word: pong');
      expect(started.length).toBeGreaterThan(0);
      const first = await client.call('threads.get', { threadId });
      const sessionId = first.sessionId;
      expect(sessionId).not.toBeNull();
      expect(assistantText(first.messages).toLowerCase()).toContain('pong');

      await turn('Repeat the word you just said, nothing else.');
      const second = await client.call('threads.get', { threadId });
      expect(second.sessionId).toBe(sessionId);
      expect(assistantText(second.messages).toLowerCase()).toContain('pong');

      // OpenCode lists `build` and `plan` as a config option: the thread's mode has to land there.
      await client.call('threads.update', { threadId, permissionMode: 'plan' });
      await turn('Reply with exactly the word: planned');
      expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
      expect(logs.filter((line) => /no session mode matches|refused the session mode/.test(line))).toEqual([]);

      // Nothing of the agent is left once the turns are over, and no background service was started.
      await waitFor(() => harness.core.procs.liveCount(threadId) === 0, 20_000);
    },
    TURN_TIMEOUT_MS * 4,
  );
});
