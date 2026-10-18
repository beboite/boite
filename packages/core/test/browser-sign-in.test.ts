import { expect, test } from 'bun:test';
import { SIGN_IN_DONE, signInAnswerText, signInSites, type QuestionRequest } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { AgentBrowser } from '../src/browser.ts';
import { signInRequest } from '../src/browser-cli.ts';
import { echoThread, waitFor } from './harness.ts';
import { createBrowserFixture, picture } from './browser/fixture.ts';

const browserFixture = createBrowserFixture();
const { real, url } = browserFixture;

/** A turn to draw the card under: a card is asked inside a conversation that has started. */
async function started(): Promise<void> {
  const { harness, owner, threadId } = browserFixture;
  await owner.call('turns.start', { threadId, prompt: 'sign me in' });
  await waitFor(() => harness.core.journal.lastTurn(threadId)?.status === 'done', 10_000);
}

test('a sign-in card names each site once, takes only http(s) pages without credentials, and the CLI needs a reason', () => {
  expect(signInSites(['https://bank.example/login', 'https://BANK.example/other', 'http://shop.example:8080/'])).toEqual({ ok: true, sites: [
    { url: 'https://bank.example/login', host: 'bank.example' }, { url: 'http://shop.example:8080/', host: 'shop.example:8080' },
  ] });
  expect(signInSites([])).toMatchObject({ ok: false });
  expect(signInSites(['file:///etc/passwd'])).toMatchObject({ ok: false, message: expect.stringContaining('HTTP') });
  expect(signInSites(['https://ada:secret@bank.example/'])).toMatchObject({ ok: false, message: expect.stringContaining('password') });
  expect(signInSites(Array.from({ length: 7 }, (_, i) => `https://s${i}.example/`))).toMatchObject({ ok: false });
  expect(signInRequest(['https://a.example/', 'https://b.example/', '--why', 'to read the invoices', '--profile', 'Pro'])).toEqual({ reason: 'to read the invoices', urls: ['https://a.example/', 'https://b.example/'], profile: 'Pro' });
  expect(() => signInRequest(['https://a.example/'])).toThrow('--why');
  expect(() => signInRequest(['--why', 'x'])).toThrow('url');
  expect(() => signInRequest(['https://a.example/', '--why', 'x', '--tab', 'browser:1'])).toThrow('--tab');
  expect(signInAnswerText({ sites: [{ url: 'https://a.example/', host: 'a.example' }], profile: 'default', profileName: 'Default' })).toContain('boite browser open <url> --profile default');
});

test('the agent asks once per site, never into a private tab; only a subscribed viewer opens the page, and only the one on the card', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  await started();
  await expect(agent.call('browser.signIn', { threadId, reason: 'x', urls: ['https://a.example/'], profile: 'private' })).rejects.toThrow('private');
  await expect(agent.call('browser.signIn', { threadId, reason: 'x', urls: ['https://a.example/'], profile: 'nobody' })).rejects.toThrow('no browser profile');
  await expect(agent.call('browser.signIn', { threadId, reason: ' ', urls: ['https://a.example/'] })).rejects.toThrow('reason');
  const first = await agent.call('browser.signIn', { threadId, reason: 'To download the March invoices', urls: ['https://a.example/login', 'https://b.example/'] });
  expect(first).toMatchObject({ reused: false, signIn: { profile: 'default', profileName: 'Default', sites: [{ host: 'a.example' }, { host: 'b.example' }] } });
  // A second ask for a site the open card names is that same card.
  expect(await agent.call('browser.signIn', { threadId, reason: 'again', urls: ['https://b.example/home'] })).toMatchObject({ questionId: first.questionId, reused: true });
  const pending = (await owner.call('questions.list', { threadId })) as QuestionRequest[];
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ async: true, text: 'To download the March invoices', options: [{ id: SIGN_IN_DONE }], signIn: first.signIn });
  // The agent asks; opening a page is the user's: an agent token has no signInOpen.
  await expect(agent.call('browser.signInOpen', { threadId, questionId: first.questionId, site: 0 })).rejects.toThrow("agent's methods");
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    await expect(phone.call('browser.signInOpen', { threadId, questionId: first.questionId, site: 0 })).rejects.toThrow('subscribe');
    await phone.call('threads.subscribe', { threadId });
    await expect(phone.call('browser.signInOpen', { threadId, questionId: first.questionId, site: 2 })).rejects.toThrow('names 2 pages');
    await expect(phone.call('browser.signInOpen', { threadId, questionId: 'qst_unknown', site: 0 })).rejects.toThrow('closed');
  } finally { phone.close(); }
  // A skipped card is closed: its pages no longer open, and the next ask draws a new one.
  await owner.call('questions.skip', { threadId, questionId: first.questionId });
  await expect(owner.call('browser.signInOpen', { threadId, questionId: first.questionId, site: 0 })).rejects.toThrow('closed');
  expect((await agent.call('browser.signIn', { threadId, reason: 'again', urls: ['https://b.example/'] })).reused).toBe(false);
});

real('the user signs in once from the card in the panel: every conversation of the machine opens signed in, after a restart too', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  await started();
  const { questionId } = await agent.call('browser.signIn', { threadId, reason: 'To read your account page', urls: [url('/login')] });
  // The card's Open, from the owner's client: the login page shows in this conversation's browser.
  await owner.call('threads.subscribe', { threadId });
  const { tabId } = await owner.call('browser.signInOpen', { threadId, questionId, site: 0 });
  expect((await owner.call('browser.remoteStatus', { threadId })).tabs).toMatchObject([{ tabId, url: url('/login'), profile: 'default', active: true }]);
  // A second press brings the same tab forward rather than opening another.
  expect((await owner.call('browser.signInOpen', { threadId, questionId, site: 0 })).tabId).toBe(tabId);
  // The user clicks and types in the panel's live view, as a person: the agent never sees the password.
  let live = await picture(owner.call('browser.remoteFrame', { threadId, tabId }));
  const act = async (input: Parameters<typeof owner.call<'browser.remoteInput'>>[1]['input']) => {
    if (Date.now() - live.at > 1500) { await Bun.sleep(150); live = await picture(owner.call('browser.remoteFrame', { threadId, tabId })); }
    return owner.call('browser.remoteInput', { threadId, frameId: live.id, input });
  };
  const at = (x: number, y: number) => ({ x: x / live.width, y: y / live.height, width: live.width, height: live.height });
  await act({ kind: 'tap', ...at(200, 116) });
  await act({ kind: 'press', keys: ['a', 'd', 'a'] });
  await act({ kind: 'tap', ...at(200, 176) });
  await act({ kind: 'text', text: 'open sesame' });
  await act({ kind: 'key', key: 'Enter' });
  // The form posts, the site sets an HttpOnly session cookie and sends the page on.
  let signed: unknown = null;
  for (let i = 0; i < 100 && signed !== 'Signed in as ada'; i++) { await Bun.sleep(100); signed = await browserFixture.evaluate('document.title', tabId).catch(() => null); }
  expect(signed).toBe('Signed in as ada');
  await owner.call('questions.answer', { threadId, questionId, optionIds: [SIGN_IN_DONE] });
  expect((await owner.call('questions.list', { threadId })) as QuestionRequest[]).toEqual([]);
  const title = async (browser: AgentBrowser, thread: string) => {
    const opened = await browser.command({ threadId: thread, action: { kind: 'open', url: url('/account') } });
    await browser.command({ threadId: thread, tabId: opened.tabId, action: { kind: 'close' } });
    return opened.title;
  };
  // Another conversation of the machine, whose agent never saw the login, is signed in.
  const other = (await echoThread(harness, owner, 'another task')).threadId;
  expect(await title(harness.core.browser, other)).toBe('Signed in as ada');
  // Every browser process ends, as when the core restarts: a session cookie with no expiry is still there.
  await harness.core.browser.close();
  const again = new AgentBrowser(harness.core);
  try {
    const third = (await echoThread(harness, owner, 'a third task')).threadId;
    expect(await title(again, third)).toBe('Signed in as ada');
  } finally { await again.close(); }
}, 150_000);
