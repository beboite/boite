import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RpcEvents } from '@boite/contracts';
import { echoTitle } from '../src/drivers/echo.ts';
import { cleanAgentTitle, titleFromPrompt, titleRequest } from '../src/titles.ts';
import { echoThread, startTestCore } from './harness.ts';
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
    expect(cleanAgentTitle(`${'word '.repeat(30)}end`)).toHaveLength(79);
  });

  test('the request carries both sides, cut, and one instruction', () => {
    const request = titleRequest('hello', '');
    expect(request).toContain('<user>\nhello\n</user>');
    expect(request).toContain('(no text)');
    expect(titleRequest('x'.repeat(3000), 'y')).toContain('[cut]');
  });

  test('the echo agent names the first five words and skips its directives', () => {
    expect(echoTitle('check the trace [permission] of this one now')).toBe('Echo: check the trace of this');
    expect(echoTitle('[tool] [sleep:10]')).toBeNull();
  });
});

describe('thread titles', () => {
  let harness: TestCore;

  beforeEach(async () => {
    harness = await startTestCore();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test('the first finished turn gets the agent title, a rename keeps it, and retitle asks again', async () => {
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
    await client.call('turns.start', { threadId, prompt: 'check the trace of this one now' });
    expect((await finished).status).toBe('done');
    const agent = await retitled;
    expect(agent.title).toBe('Echo: check the trace of this');

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
    await client.call('threads.subscribe', { threadId });
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, EVENT_TIMEOUT_MS);
    await client.call('turns.start', { threadId, prompt: '[tool]' });
    expect((await finished).status).toBe('done');
    await client.call('threads.update', { threadId, title: 'renamed' });
    const back = await client.call('threads.retitle', { threadId });
    expect(back).toMatchObject({ title: '[tool]', titleSource: 'prompt' });
  });
});
