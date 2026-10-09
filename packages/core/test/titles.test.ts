import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Core } from '../src/core.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defaultTitleModel } from '@boite/contracts';
import type { RpcEvents } from '@boite/contracts';
import { echoDriver, echoTitle } from '../src/drivers/echo.ts';
import { setDriver } from '../src/drivers/index.ts';
import { TITLE_RETRY } from '../src/threads/retitle.ts';
import { cleanAgentTitle, parseAgentTitle, titleFromPrompt, titleRequest } from '../src/titles.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const EVENT_TIMEOUT_MS = 5_000;

describe('title rules', () => {
  test('a prompt gives its first line, cut at a word', () => {
    expect(titleFromPrompt('  \n# Fix the scheduler\nmore lines')).toBe('Fix the scheduler');
    expect(titleFromPrompt('a'.repeat(70))).toBe('a'.repeat(60));
    const long = 'port the scheduler to workers and keep the caps per account in the journal';
    expect(titleFromPrompt(long)).toBe('port the scheduler to workers and keep the caps per account');
    expect(titleFromPrompt('   \n\n')).toBe('');
  });

  test('an agent answer loses its quotes, its label and its period', () => {
    expect(cleanAgentTitle('"Port the scheduler."')).toBe('Port the scheduler');
    expect(cleanAgentTitle('Title: **Caps per account**\nmore')).toBe('Caps per account');
    expect(cleanAgentTitle('\n  \n')).toBeNull();
    expect(cleanAgentTitle('""')).toBeNull();
    expect(cleanAgentTitle(`${'word '.repeat(30)}end`)).toHaveLength(59);
  });

  test('the request carries both sides, cut, and one instruction', () => {
    const request = titleRequest('hello', '');
    expect(request).toContain('<user>\nhello\n</user>');
    expect(request).toContain('(no text)');
    expect(titleRequest('x'.repeat(3000), 'y')).toContain('[cut]');
    expect(titleRequest('x'.repeat(3000) + ' final constraint', 'y'.repeat(3000) + ' resolved subject')).toContain('final constraint');
    expect(titleRequest('x', 'y'.repeat(3000) + ' resolved subject')).toContain('resolved subject');
    expect(titleRequest('fix this', '', true)).toContain('true only when the subject is still unknown');
    expect(titleRequest('fix this', 'scheduler')).toContain('Set needsRefinement to false');
  });

  test('structured answers preserve the refinement decision without showing JSON in the sidebar', () => {
    expect(parseAgentTitle('{"title":"Scheduler fix.","needsRefinement":true}')).toEqual({ title: 'Scheduler fix', needsRefinement: true });
    expect(parseAgentTitle('```json\n{"title":"Clear task","needsRefinement":false}\n```')).toEqual({ title: 'Clear task', needsRefinement: false });
    expect(parseAgentTitle('"Plain title."')).toEqual({ title: 'Plain title', needsRefinement: false });
    expect(parseAgentTitle('{"title":12}')).toBeNull();
    expect(parseAgentTitle('{"title":"Unknown","needsRefinement":"true"}')).toBeNull();
    expect(parseAgentTitle('{broken')).toBeNull();
  });

  test('each provider writes titles on the newest model of its small family, a dated id standing for its name', () => {
    const claude = { id: 'claude', protocol: 'claude-sdk' as const };
    // Nothing of the family listed: the CLI's alias for its newest Haiku.
    expect(defaultTitleModel(claude, [{ id: 'claude-opus-5' }])).toBe('haiku');
    expect(defaultTitleModel(claude, [{ id: 'claude-haiku-4-5-20251001' }])).toBe('claude-haiku-4-5-20251001');
    expect(defaultTitleModel(claude, [{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-haiku-5-5' }, { id: 'claude-opus-5' }])).toBe('claude-haiku-5-5');
    const codex = { id: 'codex', protocol: 'codex-appserver' as const };
    expect(defaultTitleModel(codex, [{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.4-mini' }])).toBe('gpt-5.6-luna');
    expect(defaultTitleModel(codex, [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }])).toBe('gpt-6-luna');
    expect(defaultTitleModel(codex, [{ id: 'gpt-5.1-codex-mini' }, { id: 'gpt-5.4-mini' }])).toBe('gpt-5.4-mini');
    // A second descriptor on Codex's protocol takes Codex's picks.
    expect(defaultTitleModel({ id: 'codex-work', protocol: 'codex-appserver' }, [])).toBe('gpt-6-luna');
    expect(defaultTitleModel({ id: 'echo', protocol: 'echo' }, [{ id: 'echo' }])).toBeNull();
  });

  test('the echo agent names the first five words and skips its directives', () => {
    expect(echoTitle('check the trace [permission] of this one now')).toBe('Echo: check the trace of this');
    expect(echoTitle('[tool] [sleep:10]')).toBeNull();
  });
});

describe('thread titles', () => {
  let harness: TestCore;

  beforeEach(async () => {
    TITLE_RETRY.delayMs = 1;
    harness = await startTestCore();
  });

  afterEach(async () => {
    await harness.stop();
    TITLE_RETRY.delayMs = 2_000;
  });

  test('the first running turn gets the agent title, a rename keeps it, and retitle asks again', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client, 'check the trace [permission]');
    await client.call('threads.subscribe', { threadId });
    const created = await client.call('threads.get', { threadId });
    expect(created.titleSource).toBe('prompt');

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, EVENT_TIMEOUT_MS);
    const retitled = client.next(
      'thread.updated',
      (thread) => thread.id === threadId && thread.titleSource === 'agent',
      EVENT_TIMEOUT_MS,
    );
    await client.call('turns.start', { threadId, prompt: 'check the trace of this one now [sleep:200]' });
    const agent = await retitled;
    expect(agent.title).toBe('Echo: check the trace of this');
    expect((await client.call('threads.get', { threadId })).status).toBe('running');
    expect((await finished).status).toBe('done');

    // The user's word is last: no turn overwrites it.
    const renamed = await client.call('threads.update', { threadId, title: 'mine' });
    expect(renamed).toMatchObject({ title: 'mine', titleSource: 'user' });
    const updates: RpcEvents['thread.updated'][] = [];
    client.on('thread.updated', (thread) => {
      if (thread.id === threadId) updates.push(thread);
    });
    const second = client.next('turn.finished', (turn) => turn.threadId === threadId, EVENT_TIMEOUT_MS);
    await client.call('turns.start', { threadId, prompt: 'another prompt entirely' });
    expect((await second).status).toBe('done');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(updates.every((thread) => thread.title === 'mine')).toBe(true);
    expect((await client.call('threads.get', { threadId })).titleSource).toBe('user');

    // Asked for, the agent's title comes back, from the first exchange still.
    const again = await client.call('threads.retitle', { threadId });
    expect(again).toMatchObject({ title: 'Echo: check the trace of this', titleSource: 'agent' });
    expect((await client.call('threads.get', { threadId })).title).toBe('Echo: check the trace of this');
  });

  test.each([false, true])('a vague title is refined once even when initial generation finishes last: %s', async (late) => {
    const release = Promise.withResolvers<void>();
    const asked: { initial: boolean; answer: string; images: number }[] = [];
    const restore = setDriver('echo', {
      ...echoDriver,
      title: async ctx => {
        asked.push({ initial: ctx.initial === true, answer: ctx.answer, images: ctx.attachments?.length ?? 0 });
        if (ctx.initial) {
          if (late) await release.promise;
          return JSON.stringify({ title: 'Unknown subject', needsRefinement: true });
        }
        return JSON.stringify({ title: 'Resolved subject', needsRefinement: false });
      },
    });
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client, 'fix this');
      const finished = client.next('turn.finished', turn => turn.threadId === threadId, EVENT_TIMEOUT_MS);
      const refined = client.next('thread.updated', thread => thread.id === threadId && thread.title === 'Resolved subject', EVENT_TIMEOUT_MS);
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      await client.call('turns.start', { threadId, prompt: 'fix this [sleep:100]', attachments: [{ kind: 'image', mimeType: 'image/png', data: png, name: 'subject.png' }] });
      await waitFor(() => asked.length === 1);
      if (late) {
        await finished;
        expect(asked).toHaveLength(1);
        release.resolve();
      } else {
        expect((await client.call('threads.get', { threadId })).status).toBe('running');
        await finished;
      }
      expect(await refined).toMatchObject({ titleSource: 'agent', titleState: { needsRefinement: false } });
      expect(asked).toHaveLength(2);
      expect(asked[0]).toEqual({ initial: true, answer: '', images: 1 });
      expect(asked[1]?.answer).toContain('fix this');
      expect(asked[1]?.initial).toBe(false);
      // Recovery and later turns cannot trigger another refinement.
      harness.core.threads.titles.recover();
      const second = client.next('turn.finished', turn => turn.threadId === threadId, EVENT_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'something else' });
      await second;
      expect(asked).toHaveLength(2);
    } finally {
      release.resolve();
      restore();
    }
  });

  test('a transient initial failure retries twice while the main turn keeps running', async () => {
    let calls = 0;
    const restore = setDriver('echo', { ...echoDriver, title: async () => {
      calls += 1;
      if (calls < 3) throw new Error('temporary title outage');
      return '{"title":"Recovered title","needsRefinement":false}';
    } });
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client);
      const retitled = client.next('thread.updated', thread => thread.id === threadId && thread.title === 'Recovered title', EVENT_TIMEOUT_MS);
      const finished = client.next('turn.finished', turn => turn.threadId === threadId, EVENT_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'a clear request [sleep:200]' });
      expect((await retitled).status).toBe('running');
      expect(calls).toBe(3);
      await finished;
      expect(calls).toBe(3);
    } finally { restore(); }
  });

  test('a same-text manual rename supersedes an initial title still in flight', async () => {
    const release = Promise.withResolvers<void>();
    let called = false;
    const restore = setDriver('echo', { ...echoDriver, title: async () => {
      called = true;
      await release.promise;
      return '{"title":"Generated replacement","needsRefinement":true}';
    } });
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client, 'fix this');
      const finished = client.next('turn.finished', turn => turn.threadId === threadId, EVENT_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'fix this' });
      await waitFor(() => called);
      await client.call('threads.update', { threadId, title: 'fix this' });
      release.resolve();
      await finished;
      expect(await client.call('threads.get', { threadId })).toMatchObject({ title: 'fix this', titleSource: 'user', titleState: { needsRefinement: false } });
    } finally { release.resolve(); restore(); }
  });

  test('a failed refinement keeps the earlier generated title and logs the exhausted retries', async () => {
    let calls = 0;
    const logs: string[] = [];
    const restore = setDriver('echo', { ...echoDriver, title: async ctx => {
      calls += 1;
      if (ctx.initial) return '{"title":"Useful early title","needsRefinement":true}';
      throw new Error('refinement outage');
    } });
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client);
      client.on('core.log', log => logs.push(log.message));
      await client.call('turns.start', { threadId, prompt: 'fix this' });
      await waitFor(() => logs.some(log => log.includes('refinement outage')));
      expect(calls).toBe(4);
      expect(await client.call('threads.get', { threadId })).toMatchObject({ title: 'Useful early title', titleSource: 'agent' });
    } finally { restore(); }
  });

  test('a persisted refinement decision is recovered by a new core', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, EVENT_TIMEOUT_MS);
    await client.call('turns.start', { threadId, prompt: 'resolve a vague subject' });
    await finished;
    const thread = harness.core.threads.require(threadId);
    harness.core.journal.putThread({ ...thread, title: 'Pending refinement', titleState: { version: 7, needsRefinement: true } });
    const recoveredDir = join(harness.dataDir, 'recovered');
    mkdirSync(recoveredDir);
    harness.core.journal.db.exec(`VACUUM INTO '${join(recoveredDir, 'journal.db').replaceAll("'", "''")}'`);
    const asked: boolean[] = [];
    const restore = setDriver('echo', { ...echoDriver, title: async ctx => {
      asked.push(ctx.initial === true);
      return '{"title":"Recovered subject","needsRefinement":false}';
    } });
    const recovered = new Core({ dataDir: recoveredDir, token: harness.token });
    try {
      await waitFor(() => recovered.journal.getThread(threadId)?.title === 'Recovered subject');
      expect(asked).toEqual([false]);
      expect(recovered.journal.getThread(threadId)?.titleState).toEqual({ version: 8, needsRefinement: false });
    } finally { await recovered.close(); restore(); }
  });

  test('a rename typed while the title is being written is the one that stays', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client, 'boxes');
    await client.call('threads.subscribe', { threadId });
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, EVENT_TIMEOUT_MS);
    await client.call('turns.start', { threadId, prompt: 'write something about boxes' });
    expect((await finished).status).toBe('done');

    // The ask is in flight when the rename lands, which is the whole race: the
    // agent answers about a title nobody is using any more, and its words used
    // to go over the user's on the way back.
    const asking = harness.core.threads.retitle(threadId);
    const renamed = harness.core.threads.update({ threadId, title: 'mine, typed during the ask' });
    expect(renamed.titleSource).toBe('user');

    expect(await asking).toMatchObject({ title: 'mine, typed during the ask', titleSource: 'user' });
    expect((await client.call('threads.get', { threadId })).title).toBe('mine, typed during the ask');
  });

  test('a thread with no prompt is refused, and a title from the prompt is the fallback', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client, 'untouched');
    await expect(client.call('threads.retitle', { threadId })).rejects.toThrow(
      'this thread has no prompt to write a title from',
    );

    // A prompt of directives alone leaves the echo agent nothing to say: the
    // core cuts the prompt itself, and says so in `titleSource`.
    // A manual name suppresses automatic naming, so this isolates regeneration.
    await client.call('threads.update', { threadId, title: 'renamed' });
    await client.call('threads.subscribe', { threadId });
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, EVENT_TIMEOUT_MS);
    await client.call('turns.start', { threadId, prompt: '[tool]' });
    expect((await finished).status).toBe('done');
    const back = await client.call('threads.retitle', { threadId });
    expect(back).toMatchObject({ title: '[tool]', titleSource: 'prompt' });
  });

  test('a title model names a provider that writes titles, or none', async () => {
    const client = await harness.connect();
    await expect(client.call('settings.set', { titleModel: { providerId: 'nobody', model: 'x' } })).rejects.toThrow(
      'not a loaded provider that writes titles',
    );
    // OpenCode speaks ACP, whose driver writes no title.
    await expect(client.call('settings.set', { titleModel: { providerId: 'opencode', model: 'x' } })).rejects.toThrow(
      'not a loaded provider that writes titles',
    );
    await expect(client.call('settings.set', { titleModel: { providerId: 'echo', model: ' ' } })).rejects.toThrow(
      'titleModel must be null',
    );
    const set = await client.call('settings.set', { titleModel: { providerId: ' echo ', model: ' echo-small ' } });
    expect(set.titleModel).toEqual({ providerId: 'echo', model: 'echo-small' });
    expect((await client.call('settings.set', { titleModel: null })).titleModel).toBeNull();
  });

  test('the model Settings names writes the title; without one the agent keeps its own', async () => {
    const asked: string[] = [];
    const restore = setDriver('echo', {
      ...echoDriver,
      title: async (ctx) => {
        asked.push(`${ctx.provider.id}:${ctx.account.providerId}:${ctx.model ?? 'own'}`);
        return `Named on ${ctx.model ?? 'its own'}`;
      },
    });
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client, 'boxes');
      await client.call('threads.subscribe', { threadId });
      const retitled = client.next(
        'thread.updated',
        (thread) => thread.id === threadId && thread.titleSource === 'agent',
        EVENT_TIMEOUT_MS,
      );
      await client.call('turns.start', { threadId, prompt: 'write something about boxes' });
      // Echo has no small model on record: the driver is asked with none.
      expect((await retitled).title).toBe('Named on its own');
      expect(asked).toEqual(['echo:echo:own']);

      await client.call('settings.set', { titleModel: { providerId: 'echo', model: 'echo-small' } });
      const again = await client.call('threads.retitle', { threadId });
      expect(again).toMatchObject({ title: 'Named on echo-small', titleSource: 'agent' });
      await waitFor(() => asked.length === 2);
      expect(asked[1]).toBe('echo:echo:echo-small');
    } finally {
      restore();
    }
  });

  test('a thread whose account signed out keeps the title from its prompt, no agent asked', async () => {
    const asked: string[] = [];
    const restore = setDriver('echo', {
      ...echoDriver,
      title: async (ctx) => {
        asked.push(ctx.account.id);
        return 'Named anyway';
      },
    });
    try {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client, 'crates');
      await client.call('threads.subscribe', { threadId });
      const retitled = client.next('thread.updated', (thread) => thread.id === threadId && thread.titleSource === 'agent', EVENT_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'stack the crates' });
      await retitled;
      expect(asked).toHaveLength(1);

      const account = harness.core.journal.getAccount((await client.call('threads.get', { threadId })).accountId)!;
      harness.core.journal.putAccount({ ...account, status: 'unauthenticated' });
      const back = await client.call('threads.retitle', { threadId });
      expect(back).toMatchObject({ title: 'stack the crates', titleSource: 'prompt' });
      expect(asked).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
