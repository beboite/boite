import { expect } from 'bun:test';
import { createBrowserFixture } from './browser/fixture.ts';
import { thrown } from './settle.ts';

// A command given up past a step's bound must not act once its work comes back:
// the next command already ran, and the conversation's tabs are its own.
const browserFixture = createBrowserFixture();
const { real, url, evaluate, fakeHost, agents } = browserFixture;

type Tabs = { tabs: { tabId: string; active: boolean; stuck?: { action: string; since: number } }[] };

real('an open given up while its browser starts leaves no tab and no navigation once the browser answers', async () => {
  const { harness, agent, threadId } = browserFixture;
  const held = Promise.withResolvers<void>();
  const host = await fakeHost('shell', [], held.promise);
  const bounds = harness.core.browser.stepMs;
  try {
    await host.app.call('browser.hostAttach', {});
    harness.core.browser.stepMs = { ...bounds, start: 300 };
    expect(await thrown(agent.call('browser.command', { threadId, action: { kind: 'open', url: url('/shop') } }))).toThrow(/browser open .*start step/);
    harness.core.browser.stepMs = bounds;
    // The browser answers now: the given-up open resumes while the next one runs.
    held.resolve();
    const second = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url('/') } });
    expect(second.title).toBe('Fixture');
    await Bun.sleep(1500);
    const { tabs } = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as Tabs;
    expect(tabs.map(tab => ({ tabId: tab.tabId, active: tab.active }))).toEqual([{ tabId: second.tabId!, active: true }]);
    expect(agents.has('/shop')).toBe(false);
  } finally {
    held.resolve();
    harness.core.browser.stepMs = bounds;
    await host.close();
  }
}, 30_000);

real('an action given up on a tab marks it until its work ends: other commands on it are refused at once, close works', async () => {
  const { harness, agent, threadId } = browserFixture;
  const { tabId } = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url('/') } });
  harness.core.browser.stepMs = { ...harness.core.browser.stepMs, act: 300 };
  const slow = (ms: number) => agent.call('browser.command', { threadId, tabId, action: { kind: 'evaluate', expression: `new Promise(done => setTimeout(() => done(1), ${ms}))` } });
  expect(await thrown(slow(1500))).toThrow(/browser evaluate .*act step/);
  const at = Date.now();
  const refusal = await thrown(agent.call('browser.command', { threadId, tabId, action: { kind: 'snapshot' } }));
  expect(Date.now() - at).toBeLessThan(1000);
  expect(refusal).toThrow(tabId!);
  expect(refusal).toThrow(/evaluate.*close/);
  const marked = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as Tabs;
  expect(marked.tabs[0]?.stuck).toMatchObject({ action: 'evaluate' });
  // The given-up work settles: the mark goes and the tab answers again.
  let cleared = marked;
  for (const end = Date.now() + 8000; cleared.tabs[0]?.stuck && Date.now() < end; await Bun.sleep(100)) {
    cleared = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as Tabs;
  }
  expect(cleared.tabs[0]?.stuck).toBeUndefined();
  expect(await evaluate('1 + 1', tabId)).toBe(2);
  // Marked again, the tab still closes.
  expect(await thrown(slow(5000))).toThrow(/act step/);
  expect((await agent.call('browser.command', { threadId, tabId, action: { kind: 'close' } })).value).toMatchObject({ closed: true });
  const closed = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as Tabs;
  expect(closed.tabs).toEqual([]);
}, 30_000);
