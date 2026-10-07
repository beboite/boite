import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@boite/contracts';
import { removeDir, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 180_000;

/**
 * Opt-in: it runs the installed Grok CLI through a Douane gateway and spends
 * that gateway's Grok subscription. `BOITE_E2E_GROK_PROXY_URL` is the gateway's
 * API URL and `BOITE_E2E_GROK_PROXY_KEY` its key, when it asks for one. The
 * account is an isolated one that never signed in: the gateway is the login,
 * so nothing here reads `~/.grok`.
 */
const GATEWAY = process.env['BOITE_E2E_GROK_PROXY_URL'] ?? '';
const KEY = process.env['BOITE_E2E_GROK_PROXY_KEY'] ?? '';
const live = process.env['BOITE_E2E_GROK_PROXY'] === '1' && GATEWAY.length > 0 ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const last = messages.filter((message) => message.role === 'assistant').at(-1);
  return last === undefined ? '' : last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('grok behind douane, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    const origin = GATEWAY.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    harness = await startTestCore({ settings: { subscriptionProxy: { enabled: true, kind: 'douane', baseUrl: GATEWAY, dashboardUrl: `${origin}/admin/#quotas` } } });
    projectDir = mkdtempSync(join(tmpdir(), 'boite-grok-proxy-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'an account that never signed in lists the gateway\'s Grok models as xAI names them and answers on one',
    async () => {
      const client = await harness.connect();
      if (KEY.length > 0) await client.call('subscriptionProxy.key', { key: KEY });
      const project = await client.call('projects.add', { path: projectDir, name: 'grok behind douane' });
      const account = await client.call('accounts.add', { providerId: 'grok', label: 'Gateway Grok' });
      expect(account.isolationDir).not.toBeNull();
      expect(account.status).toBe('ok');

      // The CLI's own discovery, read from the gateway: xAI's ids with no
      // routing prefix, xAI's default first, each model with its effort scale.
      const probe = await client.call('providers.probe', { providerId: 'grok', accountId: account.id });
      expect(probe.models[0]?.id).toBe('default');
      const named = probe.models[1];
      expect(named?.id).toMatch(/^[^/]+$/);
      expect(named?.default).toBe(true);
      const effort = named?.effort?.default ?? null;
      expect(effort).not.toBeNull();

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'grok',
        accountId: account.id,
        cwd: projectDir,
        title: 'grok behind douane',
        model: named?.id ?? 'default',
        ...(effort === null ? {} : { effort }),
      });
      await client.call('threads.subscribe', { threadId: thread.id });
      const finished = client.next('turn.finished', (turn) => turn.threadId === thread.id, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId: thread.id, prompt: 'Reply with exactly the word: pong' });
      const done = await finished;
      expect(done.error).toBeNull();
      expect(done.status).toBe('done');
      expect(assistantText((await client.call('threads.get', { threadId: thread.id })).messages).toLowerCase()).toContain('pong');

      // The CLI ran on the key: it found no sign-in to prefer, and stored none.
      expect(existsSync(join(account.isolationDir ?? '', 'auth.json'))).toBe(false);
      expect(existsSync(join(harness.dataDir, 'subscription-proxy', 'grok-auth.json'))).toBe(false);
    },
    TURN_TIMEOUT_MS * 2,
  );
});
