import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ATTACHMENTS_PER_TURN, type Attachment } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, holdAccountTurns, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { await h.stop(); restore?.(); restore = undefined; });

async function setup(nativeSession: string | null = null) {
  const client = await h.connect();
  const { threadId, accountId } = await echoThread(h, client);
  const seen: TurnContext[] = [];
  let finish!: (result: TurnResult) => void;
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      seen.push(ctx);
      return {
        done: new Promise(resolve => { finish = resolve; }),
        stop() { finish({ status: 'stopped', sessionId: nativeSession, usage: null }); },
        async steer() { return true; },
      };
    },
  });
  const start = async (prompt: string, attachments?: Attachment[]) => {
    const count = seen.length;
    const turn = await client.call('turns.start', { threadId, prompt, attachments });
    await waitFor(() => seen.length > count);
    return turn;
  };
  const stop = async () => {
    await client.call('turns.stop', { threadId });
    await waitFor(() => h.core.threads.require(threadId).status === 'idle');
  };
  const complete = async () => {
    finish({ status: 'done', sessionId: nativeSession, usage: null });
    await waitFor(() => h.core.threads.require(threadId).status === 'idle');
  };
  return { client, threadId, accountId, seen, start, stop, complete };
}

test('stopping the first prompt before a native session exists preserves its text and attachments for the next request', async () => {
  const { threadId, seen, start, stop } = await setup();
  const image = { kind: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=', name: 'reference.png' };
  const file = { kind: 'file' as const, mimeType: 'text/plain', data: Buffer.from('original brief').toString('base64'), name: 'brief.txt' };
  await start('Use blue widgets from the attached brief', [image, file]);
  await stop();
  await start('Make them larger');
  expect(seen[1]?.prompt).toContain('Use blue widgets from the attached brief');
  expect(seen[1]?.prompt).toContain('Make them larger');
  expect(seen[1]?.prompt).toContain('brief.txt');
  expect(seen[1]?.attachments).toEqual([image]);
  const users = h.core.journal.listMessages(threadId).filter(message => message.role === 'user');
  expect(users).toHaveLength(2);
  expect(users[1]?.parts).toEqual([{ type: 'text', text: 'Make them larger' }]);
});

test('a resumed native session receives consecutive stopped prompts and their follow-ups only until a user turn completes', async () => {
  const { client, threadId, seen, start, stop, complete } = await setup('native-session');
  await start('Earlier completed request');
  await complete();
  const first = await start('Keep the layout compact');
  await client.call('turns.steer', { threadId, turnId: first.id, prompt: 'Also keep keyboard navigation', clientRequestId: 'stopped_follow_up' });
  await stop();
  await start('Use violet accents');
  await stop();
  await start('Continue with those constraints');
  expect(seen[3]?.sessionId).toBe('native-session');
  const prompt = seen[3]!.prompt;
  expect(prompt).toContain('Keep the layout compact');
  expect(prompt).toContain('Also keep keyboard navigation');
  expect(prompt).toContain('Use violet accents');
  expect(prompt.indexOf('Keep the layout compact')).toBeLessThan(prompt.indexOf('Also keep keyboard navigation'));
  expect(prompt.indexOf('Also keep keyboard navigation')).toBeLessThan(prompt.indexOf('Use violet accents'));
  expect(prompt.indexOf('Use violet accents')).toBeLessThan(prompt.indexOf('Continue with those constraints'));
  expect(prompt).not.toContain('Earlier completed request');
  await complete();
  await start('A later request');
  expect(seen[4]?.prompt).not.toContain('Keep the layout compact');
  expect(seen[4]?.prompt).not.toContain('Use violet accents');
});

test('a queued prompt stopped before driver dispatch is included when an existing native session resumes', async () => {
  const { client, threadId, accountId, seen, start, stop, complete } = await setup('native-session');
  await start('Establish the native session');
  await complete();
  const release = holdAccountTurns(h, accountId);
  try {
    const queued = await client.call('turns.start', { threadId, prompt: 'The missing instruction' });
    expect(h.core.journal.getTurn(queued.id)?.status).toBe('queued');
    await stop();
    expect(h.core.journal.getTurn(queued.id)?.status).toBe('stopped');
    expect(seen).toHaveLength(1);
  } finally { release(); }
  await start('Use my previous instruction');
  expect(seen[1]?.prompt).toContain('The missing instruction');
  expect(seen[1]?.sessionId).toBe('native-session');
});

test('stopped file attachments remain readable when resuming a native session', async () => {
  const { seen, start, stop, complete } = await setup('native-session');
  await start('Establish the native session');
  await complete();
  await start('Remember this specification', [{ kind: 'file', mimeType: 'text/plain', data: Buffer.from('retained specification').toString('base64'), name: 'spec.txt' }]);
  await stop();
  await start('Implement it');
  const reference = seen[2]!.prompt.split('\n').find(line => line.startsWith('{') && line.includes('spec.txt'));
  expect(reference).toBeDefined();
  expect(readFileSync(JSON.parse(reference!).path, 'utf8')).toBe('retained specification');
});

test('a native command stays bare and does not consume interrupted instructions', async () => {
  const { seen, start, stop, complete } = await setup('native-session');
  await start('Establish the native session');
  await complete();
  const instruction = 'Keep the entire specification: ' + 'constraint '.repeat(1500);
  await start(instruction);
  await stop();
  await start('/status');
  expect(seen[2]?.prompt).toBe('/status');
  await complete();
  await start('Continue');
  expect(seen[3]?.prompt).toContain(instruction);
  expect(seen[3]?.prompt).not.toContain('/status');
});

test('interrupted instructions survive a core restart without an in-memory pending queue', async () => {
  const { threadId, seen, start, stop, complete } = await setup('native-session');
  await start('Establish the native session');
  await complete();
  await start('Remember the instruction across restart');
  await stop();
  await h.server.stop();
  await h.core.close();
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const turn = next.threads.startTurn(threadId, 'Continue after restart');
    await waitFor(() => seen.length === 3);
    expect(seen[2]?.prompt).toContain('Remember the instruction across restart');
    expect(seen[2]?.sessionId).toBe('native-session');
    next.threads.stopTurn(threadId);
    await waitFor(() => next.journal.getTurn(turn.id)?.status === 'stopped');
  } finally { await next.close(); }
});

test('interrupted images carried into the next turn stay within its byte total, oldest left as files', async () => {
  const { seen, start, stop, complete } = await setup('native-session');
  await start('Establish the native session');
  await complete();
  const heavy = (name: string) => ({ kind: 'image' as const, mimeType: 'image/png' as const, data: Buffer.alloc(3 * 1024 * 1024, name.length).toString('base64'), name });
  const images = [heavy('a.png'), heavy('bb.png'), heavy('ccc.png')];
  await start('Three heavy screenshots', images);
  await stop();
  const current = heavy('current.png');
  await start('And this one', [current]);
  // 3 MB now leaves 7 MB: the two newest fit, the oldest goes as a file.
  expect(seen[2]?.attachments).toEqual([images[1]!, images[2]!, current]);
  expect(seen[2]!.prompt.split('\n').some(line => line.startsWith('{') && line.includes('a.png'))).toBe(true);
});

test('current files count against the interrupted images a turn carries', async () => {
  const { seen, start, stop, complete } = await setup('native-session');
  await start('Establish the native session');
  await complete();
  const images = Array.from({ length: ATTACHMENTS_PER_TURN }, (_, index) => ({
    kind: 'image' as const, mimeType: 'image/png' as const, data: Buffer.from(`image-${index}`).toString('base64'), name: `image-${index}.png`,
  }));
  await start('Keep these references', images);
  await stop();
  const files = Array.from({ length: 10 }, (_, index) => ({ kind: 'file' as const, mimeType: 'text/plain', data: Buffer.from(`notes ${index}`).toString('base64'), name: `notes-${index}.txt` }));
  await start('Read these notes against them', files);
  // Ten files and forty images make the turn's fifty; the driver reads the files by path, the ten oldest images too.
  expect(seen[2]?.attachments).toEqual(images.slice(10));
  expect(seen[2]!.prompt.split('\n').some(line => line.startsWith('{') && line.includes('image-9.png'))).toBe(true);
});

test('interrupted images keep native attachment limits and leave overflow readable as files', async () => {
  const { seen, start, stop, complete } = await setup('native-session');
  await start('Establish the native session');
  await complete();
  const images = Array.from({ length: ATTACHMENTS_PER_TURN }, (_, index) => ({
    kind: 'image' as const, mimeType: 'image/png' as const, data: Buffer.from(`image-${index}`).toString('base64'), name: `image-${index}.png`,
  }));
  await start('Keep these references', images);
  await stop();
  const current = { ...images[0]!, name: 'current.png' };
  await start('Compare with this one', [current]);
  expect(seen[2]?.attachments).toEqual([...images.slice(1), current]);
  const reference = seen[2]!.prompt.split('\n').find(line => line.startsWith('{') && line.includes('image-0.png'));
  expect(reference).toBeDefined();
  expect(readFileSync(JSON.parse(reference!).path, 'utf8')).toBe('image-0');
});
