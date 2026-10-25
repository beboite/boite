import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let origin: string;
const card = '[data-testid="pinned-quota"]';
const account = '[data-testid="pinned-quota-account"]';
const position = '[data-testid="pinned-quota-position"]';
const experiment = '[data-testid="experiment-pinned-quotas"]';

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  origin = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({
    url: `${origin}/?fake=1&open=recent`, windowSize: { width: 1440, height: 1000 },
    args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
  });
}, 120_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 60_000);

async function boot(width = 2000, machines = false, agents = false) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390, maxTouchPoints: 1 });
  await page.evaluate(`localStorage.removeItem('boite.experiments'); localStorage.removeItem('boite.pinned-quotas.v1'); localStorage.removeItem('boite.quotas')`);
  await page.navigate(`${origin}/?fake=1&open=recent${machines ? '&machines=1' : ''}${agents ? '&agents=1' : ''}`);
  await page.waitFor('globalThis.__boiteTest?.workspace.active?.openThread');
  if (machines) await page.waitFor('globalThis.__boiteTest.workspace.machines.length === 2');
  await fixture();
}

async function fixture() {
  await page.evaluate(`(async () => {
    const workspace = globalThis.__boiteTest.workspace;
    globalThis.pinnedCalls = [];
    const make = (providerId, id, label, used) => ({
      providerId, accountId: 'proxy:' + providerId + ':' + id, providerName: providerId === 'claude' ? 'Claude' : 'Codex', label,
      enabled: true, status: 'ready', checkedAt: Date.now(), error: null,
      windows: [{ id: 'five-hour', label: '5 hours', usedPercent: used, resetsAt: Date.now() + 7200000 },
        { id: 'seven-day', label: 'Weekly', usedPercent: used + 10, resetsAt: Date.now() + 172800000 }],
      gateway: { kind: 'douane', entryId: id, display: 'accounts', plan: 'Test subscription', accounts: 1, status: 'ready', credits: [] },
    });
    globalThis.pinnedRows = [make('claude', 'orchard', 'Orchard', 24), make('claude', 'harbor', 'Harbor', 72), make('codex', 'cedar', 'Cedar', 38)];
    const { quotaReader } = await import('/src/lib/quota-reader.svelte.ts');
    for (const machine of workspace.machines) {
      const store = machine.store;
      store.settings = { ...store.settings, subscriptionProxy: { enabled: true, kind: 'douane', baseUrl: 'https://gateway.test', dashboardUrl: 'https://gateway.test' } };
      const call = store.client.call.bind(store.client);
      store.client.call = (method, params) => {
        if (method !== 'quotas.list') return call(method, params);
        globalThis.pinnedCalls.push({ machine: machine.id, params });
        return Promise.resolve(structuredClone(globalThis.pinnedRows));
      };
      quotaReader(store.endpointUrl ?? 'here', store.core).accept(globalThis.pinnedRows);
    }
    const store = workspace.active;
    store.openThread = { ...store.openThread, providerId: 'claude', accountId: 'a-claude-main', model: 'claude/opus-5.5' };
  })()`);
}

async function enableAndPin() {
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-experiments"]');
  await page.click(experiment);
  await page.waitFor(`document.querySelector('${experiment}')?.checked === true`);
  await page.evaluate('globalThis.__boiteTest.workspace.active.showChat()');
  await page.click('[data-testid="nav-limits"]');
  await page.click('[data-testid="quota-pin"]');
  await page.click('[data-testid="limits-glance"] button[aria-label="Close"]');
  await page.waitFor(`document.querySelector('${card}') && !document.querySelector('[data-testid="limits-glance"]')`);
  await page.waitFor(`document.querySelectorAll('${account}').length === 2`);
}

async function move(value: string) {
  const points = await page.evaluate<{ x: number; y: number; endX: number; endY: number }>(`(() => {
    const q = document.querySelector('${card} header strong').getBoundingClientRect();
    const b = document.querySelector('${value === 'dock' ? '[data-quota-dock-target]' : '[data-testid="chat"] .discussion'}').getBoundingClientRect();
    return { x: q.x + 20, y: q.y + q.height / 2,
      endX: ${value === 'dock' || value.endsWith('left') ? 'b.left + 50' : 'b.right - 50'},
      endY: ${value === 'dock' || value.startsWith('top') ? 'b.top + 80' : 'b.bottom - 50'} };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.y });
  await page.waitFor('document.hasFocus()');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.x, y: points.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.endX, y: points.endY, buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.endX, y: points.endY, button: 'left', clickCount: 1 });
  await page.waitFor(`document.querySelector('${card}')?.dataset.position === '${value}' && JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).position === '${value}'`);
  await page.settleAnimations();
}

async function capture(name: string) {
  await page.evaluate(`globalThis.__boiteTest.setTheme('light')`);
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', `pinned-quotas-${name}.png`));
  await page.evaluate(`globalThis.__boiteTest.setTheme('dark')`);
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', `pinned-quotas-${name}-dark.png`));
  await page.evaluate(`globalThis.__boiteTest.setTheme('light')`);
  await page.settleAnimations();
}

async function fitsConversation() {
  return page.evaluate<boolean>(`(() => {
    const quota = [...document.querySelectorAll('${card}')].find(el => el.getBoundingClientRect().width > 0).getBoundingClientRect();
    const composer = document.querySelector('[data-testid="composer"]').getBoundingClientRect();
    return quota.left >= 0 && quota.right <= innerWidth && quota.top >= 0 && quota.bottom <= composer.top
      && document.documentElement.scrollWidth <= innerWidth;
  })()`);
}

test('Settings enables pinning, and all Claude gateway accounts share a translucent card in every chat corner', async () => {
  await boot();
  await page.click('[data-testid="nav-limits"]');
  expect(await page.evaluate(`document.querySelector('[data-testid="quota-pin"]')`)).toBeNull();
  await page.click('[data-testid="limits-glance"] button[aria-label="Close"]');
  await enableAndPin();
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.pinned-quotas.v1'))`)).toEqual({ pinned: true, position: 'bottom-left' });
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${account}')).map(row => [row.dataset.provider, row.dataset.accountId])`)).toEqual([
    ['claude', 'proxy:claude:orchard'], ['claude', 'proxy:claude:harbor'],
  ]);
  await page.evaluate('document.activeElement?.blur()');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1400, y: 10 });
  await page.settleAnimations();
  expect(await page.evaluate(`matchMedia('(hover: hover)').matches`)).toBe(true);
  const restingOpacity = await page.evaluate<number>(`Number(getComputedStyle(document.querySelector('${card}')).opacity)`);
  expect(restingOpacity).toBeGreaterThan(0);
  expect(restingOpacity).toBeLessThan(1);
  const pointer = await page.evaluate<{ x: number; y: number }>(`(() => { const b = document.querySelector('${card}').getBoundingClientRect(); return { x: b.x + 8, y: b.y + 8 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointer });
  await page.settleAnimations();
  expect(await page.evaluate(`Number(getComputedStyle(document.querySelector('${card}')).opacity)`)).toBe(1);
  for (const corner of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
    await move(corner);
    expect(await fitsConversation()).toBe(true);
    const gaps = await page.evaluate<{ left: number; right: number; top: number; bottom: number }>(`(() => {
      const q = document.querySelector('${card}').getBoundingClientRect(), b = document.querySelector('${card}').parentElement.getBoundingClientRect();
      return { left: q.left - b.left, right: b.right - q.right, top: q.top - b.top, bottom: b.bottom - q.bottom };
    })()`);
    expect(corner.endsWith('left') ? gaps.left : gaps.right).toBeCloseTo(12, 0);
    expect(corner.startsWith('top') ? gaps.top : gaps.bottom).toBeCloseTo(12, 0);
  }
  await capture('desktop-chat');
  expect(page.errors()).toEqual([]);
}, 60_000);

test('a narrow reading margin docks automatically and a wider chat restores the chosen corner', async () => {
  await boot(1440);
  await enableAndPin();
  await page.settleAnimations();
  expect(await page.evaluate(`document.querySelector('${card}').classList.contains('docked')`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${card}').getBoundingClientRect().height`)).toBeLessThan(165);
  expect(await page.evaluate(`document.querySelector('${card}').getBoundingClientRect().right <= document.querySelector('[data-testid=chat]').getBoundingClientRect().left`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${position}')`)).toBeNull();
  await capture('auto-dock');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.querySelector('${card}')?.dataset.position === 'bottom-left'`);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).position`)).toBe('bottom-left');
  await page.evaluate(`document.documentElement.dataset.chatWidth = 'full'`);
  await page.waitFor(`document.querySelector('${card}')?.classList.contains('docked')`);
  await page.evaluate(`delete document.documentElement.dataset.chatWidth`);
  await page.waitFor(`document.querySelector('${card}')?.dataset.position === 'bottom-left'`);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('dragging account content moves the card while a drag starting on refresh does not', async () => {
  await boot(2000);
  await enableAndPin();
  const points = await page.evaluate<{ x: number; y: number; endX: number; endY: number }>(`(() => {
    const q = document.querySelector('${account} .account').getBoundingClientRect();
    const b = document.querySelector('[data-testid="chat"] .discussion').getBoundingClientRect();
    return { x: q.x + 45, y: q.y + q.height / 2, endX: b.right - 50, endY: b.top + 50 };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.y });
  await page.waitFor('document.hasFocus()');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.x, y: points.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.endX, y: points.endY, buttons: 1 });
  await page.waitFor(`document.querySelector('${card}')?.matches(':popover-open') === true`);
  expect(await page.evaluate(`document.querySelector('${card}').matches(':popover-open')`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'pinned-quotas-dragging.png'));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.endX, y: points.endY, button: 'left', clickCount: 1 });
  await page.waitFor(`document.querySelector('${card}')?.dataset.position === 'top-right' && JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).position === 'top-right'`);
  await page.settleAnimations();
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).position`)).toBe('top-right');
  const refresh = await page.evaluate<{ x: number; y: number }>(`(() => { const b = document.querySelector('[data-testid="pinned-quota-refresh"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...refresh, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.y, buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.x, y: points.y, button: 'left', clickCount: 1 });
  await page.settleAnimations();
  expect(await page.evaluate(`document.querySelector('${card}').dataset.position`)).toBe('top-right');
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).position`)).toBe('top-right');
  expect(page.errors()).toEqual([]);
}, 60_000);

test.each([1024, 390])('pinning quotas preserves the empty draft layout without a sidebar at %ipx', async (width) => {
  await boot();
  await enableAndPin();
  await page.click('[data-testid="new-thread"]');
  await page.waitFor(`document.querySelector('[data-testid="draft-empty"]')`);
  await page.evaluate('globalThis.__boiteTest.workspace.active.sidebarCollapsed = true');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390, maxTouchPoints: 1 });
  await page.evaluate(`(async () => { const { pinnedQuotas } = await import('/src/lib/pinned-quotas.svelte.ts'); pinnedQuotas.set(false); })()`);
  await page.waitFor(`!document.querySelector('${card}')`);
  await page.settleAnimations();
  const layout = `(() => {
    const composer = document.querySelector('[data-testid="composer"]').getBoundingClientRect();
    const heading = document.querySelector('${width === 390 ? '.mobile-welcome' : '[data-testid="draft-sentence"]'}').getBoundingClientRect();
    return { composerTop: composer.top, composerHeight: composer.height, headingTop: heading.top, headingBottom: heading.bottom };
  })()`;
  const before = await page.evaluate(layout);
  await page.evaluate(`(async () => { const { pinnedQuotas } = await import('/src/lib/pinned-quotas.svelte.ts'); pinnedQuotas.set(true); })()`);
  await page.waitFor(`document.querySelectorAll('${card}').length === 1 && document.querySelectorAll('${account}').length === 2`);
  await page.settleAnimations();
  await capture(`draft-${width}`);
  expect(await page.evaluate(layout)).toEqual(before);
  expect(await page.evaluate(`(() => {
    const q = document.querySelector('${card}').getBoundingClientRect();
    const h = document.querySelector('${width === 390 ? '.mobile-welcome' : '[data-testid="draft-sentence"]'}').getBoundingClientRect();
    return q.right <= h.left || q.left >= h.right || q.bottom <= h.top || q.top >= h.bottom;
  })()`)).toBe(true);
  expect(await page.evaluate(`(() => {
    const q = document.querySelector('${card}').getBoundingClientRect();
    const c = document.querySelector('[data-testid="composer"]').getBoundingClientRect();
    return q.left >= 0 && q.right <= innerWidth && q.top >= 0 && q.bottom <= innerHeight
      && (q.right <= c.left || q.left >= c.right || q.bottom <= c.top || q.top >= c.bottom)
      && document.documentElement.scrollWidth <= innerWidth;
  })()`)).toBe(true);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('dock reserves rail space above the foot and leaves the final thread reachable by scrolling', async () => {
  await boot(1440);
  await enableAndPin();
  await page.evaluate(`(() => {
    const store = globalThis.__boiteTest.workspace.active;
    const base = store.threads.find(thread => thread.id === 't-trace');
    store.threads = [...store.threads, ...Array.from({ length: 24 }, (_, i) => ({ ...base, id: 'pinned-list-' + i, title: 'Fixture thread ' + String(i + 1).padStart(2, '0'), updatedAt: base.updatedAt - (i + 1) * 1000 }))];
  })()`);
  await move('dock');
  expect(await page.evaluate(`(() => {
    const q = document.querySelector('${card}'), list = document.querySelector('[data-project-list]');
    const foot = q.parentElement.querySelector('.foot');
    return !list.contains(q) && q.previousElementSibling === list && q.nextElementSibling === foot
      && list.getBoundingClientRect().bottom <= q.getBoundingClientRect().top
      && q.getBoundingClientRect().bottom <= foot.getBoundingClientRect().top;
  })()`)).toBe(true);
  await page.evaluate(`document.querySelector('[data-project-list]').scrollTop = document.querySelector('[data-project-list]').scrollHeight`);
  await page.settleAnimations();
  expect(await page.evaluate(`(() => {
    const list = document.querySelector('[data-project-list]'), rows = [...list.querySelectorAll('[data-testid="thread-row"]')];
    const last = rows.at(-1).getBoundingClientRect(), box = list.getBoundingClientRect();
    return list.scrollHeight > list.clientHeight && list.scrollTop > 0 && last.top >= box.top && last.bottom <= box.bottom
      && document.elementFromPoint(last.x + last.width / 2, last.y + last.height / 2)?.closest('[data-testid="thread-row"]') === rows.at(-1);
  })()`)).toBe(true);
  await capture('desktop-dock');
  await page.evaluate('globalThis.__boiteTest.workspace.active.sidebarCollapsed = true');
  await page.waitFor(`document.querySelectorAll('${card}').length === 1 && document.querySelector('${card}')?.dataset.position === 'bottom-left'`);
  await page.settleAnimations();
  expect(await fitsConversation()).toBe(true);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).position`)).toBe('dock');
  await page.evaluate('globalThis.__boiteTest.workspace.active.sidebarCollapsed = false');
  await page.waitFor(`document.querySelectorAll('${card}').length === 1 && document.querySelector('${card}')?.dataset.position === 'dock'`);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('a saved dock preference uses the bot sidebar and reserves space in a phone conversation', async () => {
  await boot(1440, false, true);
  await enableAndPin();
  await move('dock');
  await page.evaluate(`(async () => {
    const { setExperiment } = await import('/src/lib/experiments.ts');
    setExperiment('resident-agents', true);
    const store = globalThis.__boiteTest.workspace.active;
    const agent = (await store.client.call('agents.snapshot', {})).profiles.find(profile => profile.name === 'Mira');
    store.showAgents(agent.id);
  })()`);
  await page.waitFor(`globalThis.__boiteTest.workspace.active.page === 'agents' && globalThis.__boiteTest.workspace.active.openThread?.agentSessionId && document.querySelector('.agents-main [data-testid="chat"]')`);
  await fixture();
  await page.evaluate('globalThis.__boiteTest.workspace.active.panel.hide()');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  for (const width of [1440, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390, maxTouchPoints: 1 });
    await page.settleAnimations();
    expect(await page.evaluate(`document.querySelector('${width === 390 ? '.agents-main' : '.agents-rail'} ${card}')?.checkVisibility() === true`)).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('${card}').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelector('${card}')?.dataset.position`)).toBe(width === 390 ? 'bottom-left' : 'dock');
    expect(await page.evaluate(`document.querySelectorAll('${account}').length`)).toBe(2);
    if (width === 390) expect(await fitsConversation()).toBe(true);
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).position`)).toBe('dock');
    await page.evaluate(`globalThis.__boiteTest.setTheme('dark')`);
    await page.settleAnimations();
    await page.screenshot(join(import.meta.dir, '.artifacts', `pinned-quotas-agents-${width}-dark.png`));
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.evaluate('globalThis.__boiteTest.workspace.active.showChat()');
  await page.waitFor(`document.querySelectorAll('${card}').length === 1 && document.querySelector('${card}')?.dataset.position === 'dock'`);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('the owning machine refreshes explicitly, and model and provider switches select their upstream accounts', async () => {
  await boot(1440, true);
  await page.evaluate(`(async () => {
    const w = globalThis.__boiteTest.workspace;
    await w.select(w.machines[1].store, 't-trace');
    w.active.openThread = { ...w.active.openThread, providerId: 'claude', accountId: 'a-claude-main', model: 'claude/opus-5.5' };
  })()`);
  await enableAndPin();
  await page.waitFor(`document.querySelector('[data-testid="pinned-quota-refresh"]')?.disabled === false`);
  await page.evaluate('globalThis.pinnedCalls = []');
  await page.click('[data-testid="pinned-quota-refresh"]');
  await page.waitFor('globalThis.pinnedCalls.length > 0');
  expect(await page.evaluate('globalThis.pinnedCalls.every(call => call.machine === globalThis.__boiteTest.workspace.machines[1].id && call.params.refresh === true)')).toBe(true);
  await page.evaluate(`globalThis.__boiteTest.workspace.active.openThread = { ...globalThis.__boiteTest.workspace.active.openThread, model: 'codex/gpt-6.1' }`);
  await page.waitFor(`document.querySelectorAll('${account}').length === 1 && document.querySelector('${account}')?.dataset.provider === 'codex'`);
  await page.evaluate(`globalThis.__boiteTest.workspace.active.openThread = { ...globalThis.__boiteTest.workspace.active.openThread, providerId: 'codex', accountId: 'a-codex', model: 'claude/opus-5.5' }`);
  await page.waitFor(`document.querySelectorAll('${account}').length === 2 && document.querySelector('${account}')?.dataset.provider === 'claude'`);
  await page.waitFor(`document.querySelector('[data-testid="pinned-quota-refresh"]')?.disabled === false`);
  await page.evaluate(`globalThis.__boiteTest.workspace.active.principal = 'session'; globalThis.pinnedCalls = []`);
  await page.click('[data-testid="pinned-quota-refresh"]');
  await page.waitFor('globalThis.pinnedCalls.length > 0');
  expect(await page.evaluate('globalThis.pinnedCalls.every(call => call.machine === globalThis.__boiteTest.workspace.machines[1].id && call.params.refresh === false)')).toBe(true);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('reload restores pin and placement, unpin persists, and switching off the experiment hides the card', async () => {
  await boot();
  await enableAndPin();
  await move('top-right');
  await page.reload();
  await page.waitFor('globalThis.__boiteTest?.workspace.active?.openThread');
  await fixture();
  await page.waitFor(`document.querySelector('${card}')?.dataset.position === 'top-right'`);
  await page.click('[data-testid="pinned-quota-unpin"]');
  await page.waitFor(`!document.querySelector('${card}')`);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')).pinned`)).toBe(false);
  await page.click('[data-testid="nav-limits"]');
  await page.click('[data-testid="quota-pin"]');
  await page.click('[data-testid="limits-glance"] button[aria-label="Close"]');
  await page.waitFor(`document.querySelector('${card}')`);
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-experiments"]');
  await page.click(experiment);
  await page.evaluate('globalThis.__boiteTest.workspace.active.showChat()');
  await page.waitFor(`!document.querySelector('${card}')`);
  await page.click('[data-testid="nav-limits"]');
  expect(await page.evaluate(`document.querySelector('[data-testid="quota-pin"]')`)).toBeNull();
  expect(page.errors()).toEqual([]);
}, 60_000);

test('the phone keeps the pinned card above the composer without overflow, including a saved dock preference', async () => {
  await boot();
  await enableAndPin();
  await move('dock');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const phoneCard = '[data-testid="chat"] [data-testid="pinned-quota"]';
  await page.waitFor(`document.querySelector('${phoneCard}')?.dataset.position === 'bottom-left' && [...document.querySelectorAll('${card}')].filter(el => el.getBoundingClientRect().width > 0).length === 1`);
  await page.settleAnimations();
  expect(await fitsConversation()).toBe(true);
  expect(await page.evaluate(`Number(getComputedStyle(document.querySelector('${phoneCard}')).opacity)`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('[data-testid=chat] .timeline').getBoundingClientRect().bottom <= document.querySelector('${phoneCard}').getBoundingClientRect().top`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${phoneCard} .body').scrollWidth <= document.querySelector('${phoneCard} .body').clientWidth`)).toBe(true);
  await page.evaluate('globalThis.__boiteTest.workspace.active.sidebarOpen = true');
  await page.waitFor(`document.querySelectorAll('${card}').length === 1 && document.querySelector('${card}')?.dataset.position === 'dock'`);
  await page.settleAnimations();
  expect(await page.evaluate(`document.querySelector('${card}').getBoundingClientRect().width > 0 && !document.querySelector('${phoneCard}')`)).toBe(true);
  await page.evaluate('globalThis.__boiteTest.workspace.active.sidebarOpen = false');
  await page.waitFor(`document.querySelectorAll('${card}').length === 1 && document.querySelector('${phoneCard}')?.dataset.position === 'bottom-left'`);
  await page.settleAnimations();
  expect(await fitsConversation()).toBe(true);
  await capture('phone');
  await page.click(`${phoneCard} [data-testid="pinned-quota-unpin"]`);
  await page.waitFor(`!document.querySelector('${card}')`);
  expect(page.errors()).toEqual([]);
}, 60_000);
