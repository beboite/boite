/**
 * The whole Antigravity path on the real agent: the release installed, the
 * account signed into Google through `authenticate`, then one turn. Opt-in
 * behind `BOITE_E2E_ANTIGRAVITY=1`, and only the user runs it, because it opens
 * a Google sign-in page in their browser and spends tokens on their account.
 *
 *   $env:BOITE_E2E_ANTIGRAVITY='1'; bun test test/antigravity.live.test.ts
 *
 * The sign-in is not automatic: the run prints the link the agent published,
 * the user opens it, and the redirect the browser lands on is what
 * `accounts.loginInput` takes. `BOITE_E2E_ANTIGRAVITY_REDIRECT` can carry that
 * URL for a rerun whose page is already open.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 180_000;

const live = process.env['BOITE_E2E_ANTIGRAVITY'] === '1' ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('antigravity, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-antigravity-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'the release installs, the account signs in through authenticate, and a real turn answers',
    async () => {
      const client = await harness.connect();
      const project = await client.call('projects.add', { path: projectDir, name: 'antigravity live' });

      const installed = await client.call('providers.install', { providerId: 'antigravity' });
      expect(installed.state).toBe('installed');

      // Every Antigravity account is isolated, the one the user asked for the
      // default location included: this never touches their own IDE login.
      const account = await client.call('accounts.add', {
        providerId: 'antigravity',
        label: 'live',
        useDefaultLocation: true,
      });
      expect(account.isolationDir).not.toBeNull();
      expect(account.status).toBe('unauthenticated');

      const urls: string[] = [];
      const states: string[] = [];
      client.on('account.login', (event) => {
        if (event.accountId !== account.id) return;
        if (event.url !== null && !urls.includes(event.url)) urls.push(event.url);
        states.push(event.state);
        if (event.output.length > 0) console.log(`login: ${event.output}`);
      });

      await client.call('accounts.login', { accountId: account.id });
      await waitFor(() => urls.length > 0, 60_000);
      console.log(`open this and sign in: ${urls[0] ?? ''}`);

      // The agent's own loopback listener takes the answer. A browser that
      // reached it already finished the sign-in on its own; a headless run
      // hands the redirect over instead.
      const redirect = process.env['BOITE_E2E_ANTIGRAVITY_REDIRECT'];
      if (redirect !== undefined && redirect.length > 0) {
        await client.call('accounts.loginInput', { accountId: account.id, text: redirect });
      }
      await waitFor(() => states.includes('done') || states.includes('failed'), LOGIN_TIMEOUT_MS);
      expect(states.at(-1)).toBe('done');

      const accounts = await client.call('accounts.list', {});
      expect(accounts.find((entry) => entry.id === account.id)?.status).toBe('ok');

      // The agent owns its model list; the descriptor carries only `default`.
      const probe = await client.call('providers.probe', { providerId: 'antigravity', accountId: account.id });
      expect(probe.models[0]?.id).toBe('default');
      console.log(`models: ${probe.models.map((model) => model.id).join(', ')}`);

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'antigravity',
        accountId: account.id,
        cwd: projectDir,
        title: 'live antigravity',
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

      expect(started.some((record) => record.exe.toLowerCase().includes('agy_acp_server'))).toBe(true);
      const first = await client.call('threads.get', { threadId });
      expect(first.sessionId).not.toBeNull();
      expect(assistantText(first.messages).toLowerCase()).toContain('pong');
    },
    INSTALL_TIMEOUT_MS + LOGIN_TIMEOUT_MS + TURN_TIMEOUT_MS,
  );
});
