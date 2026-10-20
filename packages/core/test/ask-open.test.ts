import { afterEach, expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });

test('boite ask --open keeps the page on the card, and refuses an address that is not a web page or carries a login', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await owner.call('turns.start', { threadId, prompt: 'hello' });
  await waitFor(() => h.core.journal.lastTurn(threadId) !== null);

  const ask = (open: string) => owner.call('questions.ask', { threadId, text: 'billing.example: to download the invoices', options: ['Signed in', 'Skip'], open });
  const { questionId } = await ask('https://billing.example/login?next=%2Finvoices');
  const card = h.core.journal.listMessages(threadId).flatMap(message => message.parts).find(part => part.type === 'question' && part.questionId === questionId);
  expect(card).toMatchObject({ open: { url: 'https://billing.example/login?next=%2Finvoices' }, async: true });

  expect(await thrown(ask('file:///etc/passwd'))).toThrow('http or https');
  expect(await thrown(ask('https://me:hunter2@billing.example/'))).toThrow('user name or password');
});

test('a paired phone opens the page of a pending question in the conversation it watches, and nothing else', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await owner.call('turns.start', { threadId, prompt: 'hello' });
  await waitFor(() => h.core.journal.lastTurn(threadId) !== null);
  const { questionId } = await owner.call('questions.ask', { threadId, text: 'ci.example: to read the failed run', options: ['Signed in', 'Skip'], open: 'https://ci.example/login' });
  const { questionId: plain } = await owner.call('questions.ask', { threadId, text: 'Which branch?', options: ['main', 'dev'] });
  const opened: string[] = [];
  h.core.browser.command = (async ({ action }: { action: { url: string } }) => { opened.push(action.url); return { value: { ok: true } }; }) as typeof h.core.browser.command;
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    expect(await thrown(phone.call('questions.openPage', { threadId, questionId }))).toThrow('subscribe to the active conversation');
    await phone.call('threads.subscribe', { threadId });
    await phone.call('questions.openPage', { threadId, questionId });
    expect(opened).toEqual(['https://ci.example/login']);
    expect(await thrown(phone.call('questions.openPage', { threadId, questionId: plain }))).toThrow('not a pending question with a page');
    expect(await thrown(phone.call('panel.open', { threadId, surface: { kind: 'browser', url: 'https://ci.example/login' } }))).toThrow('for the owner only');
    expect(opened).toHaveLength(1);
  } finally { phone.close(); }
});
