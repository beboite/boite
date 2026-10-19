import { afterEach, expect, test } from 'bun:test';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

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

  await expect(ask('file:///etc/passwd')).rejects.toThrow('http or https');
  await expect(ask('https://me:hunter2@billing.example/')).rejects.toThrow('user name or password');
});
