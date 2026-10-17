import { expect, test } from 'bun:test';
import { sleepState, TabSleep, type Sleeper } from '../src/browser/sleep.ts';

/** A page whose DevTools calls are logged, and held while `hold` names their method. */
function fakeTab() {
  const calls: string[] = [];
  const holds = new Map<string, () => void>();
  let hold: string | null = null;
  const tab: Sleeper = {
    sleep: sleepState(),
    page: {
      send: async (method, params = {}) => {
        const name = `${method} ${JSON.stringify(params)}`;
        if (hold === method) await new Promise<void>(resolve => holds.set(method, () => { holds.delete(method); resolve(); }));
        calls.push(name);
        return {};
      },
    },
  };
  return { tab, calls, holdNext: (method: string) => { hold = method; }, release: (method: string) => { hold = null; holds.get(method)?.(); }, held: (method: string) => holds.has(method) };
}

const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true); };

// A command that arrives while the page is being frozen must meet it awake:
// the wake waits for the freeze to end and puts the page back before the
// command runs, never the other way round.
test('a use that arrives during a freeze runs after the page is active again', async () => {
  const { tab, calls, holdNext, release, held } = fakeTab();
  const sleep = new TabSleep<Sleeper>(() => false, () => false, 20);
  holdNext('Page.setWebLifecycleState');
  sleep.schedule(tab);
  await until(() => held('Page.setWebLifecycleState'));
  const ran = sleep.use(tab, async () => { calls.push('command'); return 'done'; });
  await Bun.sleep(30);
  expect(calls).toEqual(['Emulation.setFocusEmulationEnabled {"enabled":false}']);
  release('Page.setWebLifecycleState');
  expect(await ran).toBe('done');
  expect(calls).toEqual([
    'Emulation.setFocusEmulationEnabled {"enabled":false}',
    'Page.setWebLifecycleState {"state":"frozen"}',
    'Page.setWebLifecycleState {"state":"active"}',
    'Emulation.setFocusEmulationEnabled {"enabled":true}',
    'command',
  ]);
  expect(tab.sleep.asleep).toBe(false);
  sleep.drop(tab);
});

test('a tab sleeps only once nothing uses or holds it, and a dropped tab never does', async () => {
  const { tab, calls } = fakeTab();
  let holding = true;
  const sleep = new TabSleep<Sleeper>(() => holding, () => false, 20);
  // A use that runs longer than the wait keeps the page awake throughout.
  await sleep.use(tab, () => Bun.sleep(60));
  expect(calls).toEqual([]);
  // A holder (a viewer, a recording, a running turn) keeps it awake too.
  await Bun.sleep(60);
  expect(calls).toEqual([]);
  holding = false;
  await until(() => tab.sleep.asleep);
  expect(calls).toEqual(['Emulation.setFocusEmulationEnabled {"enabled":false}', 'Page.setWebLifecycleState {"state":"frozen"}']);
  sleep.drop(tab);
  await sleep.use(tab, async () => {});
  await Bun.sleep(60);
  // Woken for that use, and never frozen again once its tab is gone.
  expect(calls.slice(2)).toEqual(['Page.setWebLifecycleState {"state":"active"}', 'Emulation.setFocusEmulationEnabled {"enabled":true}']);
});

// A freeze can time out on a loaded machine: the tab must try again after the
// wait instead of running until something next uses it.
test('a freeze that fails is tried again after the wait', async () => {
  const { tab, calls } = fakeTab();
  const send = tab.page.send;
  let failures = 1;
  tab.page.send = async (method, params, timeoutMs) => {
    if (method === 'Page.setWebLifecycleState' && failures > 0) { failures--; throw new Error('timed out'); }
    return send(method, params, timeoutMs);
  };
  const sleep = new TabSleep<Sleeper>(() => false, () => false, 20);
  sleep.schedule(tab);
  await until(() => tab.sleep.asleep);
  expect(calls).toEqual([
    'Emulation.setFocusEmulationEnabled {"enabled":false}',
    'Emulation.setFocusEmulationEnabled {"enabled":true}',
    'Emulation.setFocusEmulationEnabled {"enabled":false}',
    'Page.setWebLifecycleState {"state":"frozen"}',
  ]);
  sleep.drop(tab);
});

// A turn that runs for half an hour without touching its tab must not keep
// it awake throughout: the turn holds it only for a while after its last use,
// and the next command wakes it.
test('a running turn keeps an unused tab awake for a while only, and its next command wakes it', async () => {
  const { tab, calls } = fakeTab();
  const sleep = new TabSleep<Sleeper>(() => false, () => true, 20, 150);
  await sleep.use(tab, async () => {});
  await Bun.sleep(100);
  expect(tab.sleep.asleep).toBe(false);
  await until(() => tab.sleep.asleep);
  await sleep.use(tab, async () => { calls.push('command'); });
  expect(calls.slice(-3)).toEqual(['Page.setWebLifecycleState {"state":"active"}', 'Emulation.setFocusEmulationEnabled {"enabled":true}', 'command']);
  // The command starts the turn's hold again.
  await Bun.sleep(100);
  expect(tab.sleep.asleep).toBe(false);
  sleep.drop(tab);
});
