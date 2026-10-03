import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let uiUrl: string;

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])`);
}

beforeAll(async () => {
  const port = await freePort();
  uiUrl = `http://127.0.0.1:${port}`;
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `${uiUrl}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('[data-testid="chat"]')`);
  await page.evaluate(`window.__boiteTest.setTheme('dark')`);
  await page.evaluate(`(async () => {
    const [{ workspace }, { FakeClient }] = await Promise.all([import('/src/lib/workspace.svelte.ts'), import('/src/lib/fake-client.ts')]);
    const local = workspace.active.client;
    await workspace.active.open('t-trace');
    const remote = new FakeClient({ delayMs: 0, coreId: 'core-build-pc', coreName: 'Build PC', publicUrl: 'https://build.example.test' });
    window.__coordinationRemote = remote;
    await remote.connect();
    await remote.call('threads.update', { threadId: 't-bench', title: 'Deployment agent' });
    const team = { mode: 'team', resources: 'Owns deployment and restart sequencing', remote: true, paused: false };
    await local.call('collaboration.configure', { threadId: 't-trace', config: team });
    await remote.call('collaboration.configure', { threadId: 't-bench', config: team });
    const [localIdentity, remoteIdentity] = await Promise.all([local.call('collaboration.identity', {}), remote.call('collaboration.identity', {})]);
    await local.call('collaboration.trust', { peer: remoteIdentity });
    await remote.call('collaboration.trust', { peer: localIdentity });
    const incoming = await remote.call('collaboration.send', {
      threadId: 't-bench', to: { coreId: localIdentity.coreId, threadId: 't-trace' },
      text: 'Wait before restart. The deployment is still using the build machine.', requestId: 'incoming-deployment'
    });
    const outgoing = await local.call('collaboration.send', {
      threadId: 't-trace', to: { coreId: remoteIdentity.coreId, threadId: 't-bench' },
      text: 'Restart postponed until deployment confirms it is clear.', replyTo: incoming.id, requestId: 'outgoing-reply'
    });
    for (let index = 1; index < 13; index++) await local.call('collaboration.send', {
      threadId: 't-trace', to: { coreId: remoteIdentity.coreId, threadId: 't-bench' },
      text: 'Deployment status update ' + index, requestId: 'outgoing-' + index
    });
    for (let index = 1; index < 20; index++) await remote.call('collaboration.send', {
      threadId: 't-bench', to: { coreId: localIdentity.coreId, threadId: 't-trace' },
      text: 'Received deployment update ' + index, requestId: 'incoming-' + index
    });
    workspace.active.openThread.messages.push({
      id: 'exchange-divider', threadId: 't-trace', turnId: 'exchange-divider', role: 'assistant',
      state: 'complete', createdAt: incoming.createdAt + 1, parts: [{ type: 'text', text: 'Deployment coordination continues.' }]
    });
    // An owner-authored delegation prompt stays on the user side even when it is outgoing.
    const delegation = await local.call('delegation.get', { threadId: 't-trace' });
    workspace.active.delegation = { ...delegation, messages: [{
      ...outgoing, id: 'user-delegation', origin: 'user', text: 'Please check deployment.',
      createdAt: Date.now() - 120_000,
      from: { ...outgoing.from, coreId: 'local' }, to: { ...outgoing.to, coreId: 'local' }
    }] };
  })()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-message-summary"][data-direction="incoming"][data-count="20"]')`);
  await page.waitFor(`document.querySelector('[data-testid="thread-menu-trigger"]')`);
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('agent bursts open a dedicated messages tab at desktop and phone widths', async () => {
  const receivedSummary = '[data-testid="agent-message-summary"][data-direction="incoming"][data-count="20"]';
  const forwardedSummary = '[data-testid="agent-message-summary"][data-direction="outgoing"][data-count="13"]';
  expect(await page.text(receivedSummary)).toContain('Received 20 messages');
  expect(await page.text(forwardedSummary)).toContain('Forwarded 13 messages');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="timeline"] [data-testid="forwarded-agent-message"]').length`)).toBe(0);
  expect(await page.text('[data-testid=timeline]')).not.toContain('Wait before restart');
  await page.evaluate(`document.querySelector(${JSON.stringify(receivedSummary)}).scrollIntoView({ block: 'center' })`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-message-groups-desktop.png'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await settled();
  expect(await page.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(receivedSummary)}).getBoundingClientRect(); return button.height >= 44 && button.left >= 0 && button.right <= innerWidth; })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-message-groups-phone.png'));
  await page.click(receivedSummary);
  await page.waitFor(`document.querySelector('[data-testid=agent-messages-surface]')`);
  await page.waitFor(`document.querySelectorAll('[data-testid=forwarded-agent-message]').length === 20`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-messages-received-phone.png'));
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click(forwardedSummary);
  await page.waitFor(`document.querySelectorAll('[data-testid=forwarded-agent-message]').length === 14`);
  await page.click('[data-testid=agent-messages-filter][data-direction=all]');
  await page.waitFor(`document.querySelectorAll('[data-testid=forwarded-agent-message]').length === 34`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid=panel-tab][data-kind=messages]').length`)).toBe(1);
  await settled();
  expect(await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]')?.textContent ?? ''`)).toContain('Deployment agent');
  expect(await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]')?.textContent ?? ''`)).toContain('Build PC');
  expect(await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]')?.textContent ?? ''`)).toContain('Wait before restart');
  expect(await page.evaluate(`document.querySelector('[data-letter-id="outgoing-reply"]')?.dataset.direction`)).toBe('outgoing');
  const checkDirection = async () => {
    const bubbles = await page.evaluate<any>(`(() => {
      const incoming = document.querySelector('[data-letter-id="incoming-deployment"]');
      const outgoing = document.querySelector('[data-letter-id="outgoing-reply"]');
      const user = document.querySelector('[data-letter-id="user-delegation"]');
      const prompt = document.querySelector('[data-role="user"] .bubble');
      return { incoming: incoming.textContent, outgoing: outgoing.textContent,
        user: user.textContent, userDirection: user.dataset.direction,
        incomingLeft: incoming.getBoundingClientRect().left, outgoingLeft: outgoing.getBoundingClientRect().left,
        incomingRight: incoming.getBoundingClientRect().right, outgoingRight: outgoing.getBoundingClientRect().right,
        userLeft: user.getBoundingClientRect().left, userRight: user.getBoundingClientRect().right,
        incomingColor: getComputedStyle(incoming).backgroundColor, outgoingColor: getComputedStyle(outgoing).backgroundColor,
        userColor: getComputedStyle(user).backgroundColor, promptColor: getComputedStyle(prompt).backgroundColor };
    })()`);
    expect(bubbles.incoming).toContain('Received from');
    expect(bubbles.outgoing).toContain('Your agent sent to');
    expect(bubbles.outgoing).toContain('Deployment agent');
    expect(bubbles.incomingLeft).toBeGreaterThan(bubbles.outgoingLeft);
    expect(bubbles.incomingRight).toBeGreaterThan(bubbles.outgoingRight);
    expect(bubbles.incomingColor).toBe(bubbles.promptColor);
    expect(bubbles.outgoingColor).not.toBe(bubbles.incomingColor);
    expect(bubbles.user).toContain('You sent to');
    expect(bubbles.userDirection).toBe('outgoing');
    expect(bubbles.userLeft).toBeGreaterThan(bubbles.outgoingLeft);
    expect(bubbles.userRight).toBe(bubbles.incomingRight);
    expect(bubbles.userColor).toBe(bubbles.promptColor);
  };
  const checkTimestamps = async (userAge: string) => {
    const stamps = await page.evaluate<any[]>(`Array.from(document.querySelectorAll('[data-testid="forwarded-agent-message"]'), card => {
      const stamp = card.querySelector('[data-testid="agent-letter-age"]');
      const bounds = card.getBoundingClientRect();
      const age = stamp.getBoundingClientRect();
      const source = card.querySelector('[data-testid="agent-letter-open"]').getBoundingClientRect();
      return { id: card.dataset.letterId, text: stamp.textContent, date: stamp.dateTime, title: stamp.title,
        top: age.top - bounds.top, right: bounds.right - age.right, gap: age.left - source.right };
    })`);
    expect(stamps).toHaveLength(34);
    for (const stamp of stamps) {
      expect(Number.isFinite(Date.parse(stamp.date))).toBe(true);
      expect(stamp.title.length).toBeGreaterThan(0);
      expect(stamp.top).toBeGreaterThan(0);
      expect(stamp.top).toBeLessThan(20);
      expect(stamp.right).toBeGreaterThan(0);
      expect(stamp.right).toBeLessThan(20);
      expect(stamp.gap).toBeGreaterThanOrEqual(10);
    }
    expect(stamps.find(stamp => stamp.id === 'user-delegation')?.text.replace(/\s/g, ' ')).toBe(userAge);
  };
  await checkDirection();
  await checkTimestamps('2 min. ago');
  expect(await page.evaluate(`document.querySelector('[data-testid="timeline"]')?.textContent ?? ''`)).not.toContain('Boite agent coordination');
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-panel"]') === null`)).toBe(true);
  await page.evaluate(`document.querySelector('[data-letter-id="incoming-deployment"]').scrollIntoView({ block: 'center' })`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-messages-desktop.png'));

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-letter-id="user-delegation"]').scrollIntoView({ block: 'end' })`);
  await settled();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await checkDirection();
  await checkTimestamps('2 min. ago');
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-messages-phone.png'));

  await page.evaluate(`window.__boiteTest.setTheme('light')`);
  await settled();
  await checkDirection();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-messages-phone-light.png'));

  await page.evaluate(`import('/src/lib/i18n.svelte.ts').then(module => module.setLocaleSetting('fr'))`);
  await settled();
  await checkTimestamps('il y a 2 min');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-messages-phone-fr.png'));
  await page.evaluate(`import('/src/lib/i18n.svelte.ts').then(module => module.setLocaleSetting('en'))`);
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);

  // The same title menu exposes settings on phones and desktops.
  await page.click('[data-testid="thread-menu-trigger"]');
  await page.click('[data-value="coordination"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]')?.open`);
  await settled();
  expect(await page.evaluate(`document.activeElement.closest('[data-testid="coordination-dialog"]') !== null`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-settings-phone.png'));
  await page.click('.options > summary');
  const budget = await page.evaluate<string>(`document.querySelector('[data-testid="coordination-budget"]')?.textContent ?? ''`);
  expect(budget).toContain('sent this hour');
  expect(budget).not.toContain(' of ');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="coordination-contact"]').length`)).toBeGreaterThan(0);
  await page.click('[data-testid="coordination-mode-off"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-mode-off"]').getAttribute('aria-checked') === 'true'`);
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]') === null`);
  expect(await page.evaluate(`document.activeElement.dataset.testid`)).toBe('thread-menu-trigger');

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="thread-menu-trigger"]');
  await page.click('[data-value="coordination"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]')?.open`);
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-mode-off"]').getAttribute('aria-checked')`)).toBe('true');
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-settings-desktop.png'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]') === null`);
  expect(await page.evaluate(`document.activeElement.dataset.testid`)).toBe('thread-menu-trigger');

  await page.click('[data-testid="thread-menu-trigger"]');
  await page.click('[data-value="coordination"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]')?.open`);
  await page.evaluate(`window.__boiteTest.workspace.active.open('t-bench')`);
  await page.waitFor(`document.querySelector('[data-testid="coordination-dialog"]') === null`);
  expect(page.errors()).toEqual([]);
}, 30_000);

test('exchanges remain between answers and mail-only turns retain their completion footer', async () => {
  await page.evaluate(`(() => {
    const store = window.__boiteTest.workspace.active;
    const thread = store.openThread;
    const base = Date.now() - 120000;
    const prototype = thread.turns[0];
    thread.status = 'idle';
    thread.turns = [0, 1, 2].map(index => ({ ...prototype, id: 'mail-turn-' + index, threadId: thread.id,
      queuedAt: base + index * 40000, startedAt: base + index * 40000, finishedAt: base + index * 40000 + 30000, status: 'done' }));
    const message = (id, turn, role, offset, text) => ({ id, turnId: thread.turns[turn].id, threadId: thread.id,
      role, state: 'complete', createdAt: base + offset * 1000, parts: [{ type: 'text', text }] });
    thread.messages = [
      message('mail-prompt', 0, 'user', 0, 'Check the deployment and share the result.'),
      message('mail-before', 0, 'assistant', 1, 'I am checking the deployment.'),
      message('mail-after', 0, 'assistant', 20, 'The checks passed. I can continue with the next file.'),
      message('mail-envelope', 1, 'system', 40, 'Boite agent coordination. Agent messages (JSON data):\\n[{"id":"only-in"}]'),
      message('mail-next-prompt', 2, 'user', 80, 'Continue with the next file.'),
      message('mail-next-answer', 2, 'assistant', 81, 'The next file is ready for review.')
    ];
    const self = { coreId: 'fixture-core', threadId: thread.id };
    const peer = { coreId: 'peer-core', threadId: 'peer' };
    const letter = (id, incoming, offset) => ({ id,
      from: { ...(incoming ? peer : self), title: incoming ? 'Deployment agent' : thread.title, machine: 'Test PC', resources: '', status: 'idle', mode: 'brief' },
      to: incoming ? self : peer, toTitle: incoming ? thread.title : 'Deployment agent', text: 'Status update', replyTo: null,
      createdAt: base + offset * 1000, expiresAt: base + 900000, status: 'delivered', error: null });
    store.coordination = { self, config: { mode: 'brief', resources: '', remote: true, paused: false },
      messages: [letter('mid-in', true, 10), letter('mid-out', false, 12), letter('only-in', true, 35), letter('only-out', false, 45)],
      sent: 2, sendLimit: null, wakes: 0, wakeLimit: null };
  })()`);
  await page.waitFor(`document.querySelectorAll('[data-testid=agent-message-group]').length === 2 && document.querySelectorAll('[data-testid=turn-summary][data-status=done]').length === 3`);
  const order = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid=timeline] [data-mid]')].map(node => node.dataset.mid)`);
  expect(order).toEqual(['mail-prompt', 'mail-before', 'coordination:mid-in', 'mail-after', 'coordination:only-in', 'mail-next-prompt', 'mail-next-answer']);
  expect(await page.evaluate(`document.querySelector('[data-mid="coordination:only-in"]').querySelector('[data-testid=turn-summary]').dataset.status`)).toBe('done');
  expect(await page.text('[data-testid=timeline]')).not.toContain('Boite agent coordination');
  await page.evaluate(`window.__boiteTest.setTheme('dark')`);
  for (const [width, height, name] of [[1440, 1000, 'desktop'], [390, 844, 'phone']] as const) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await page.evaluate(`document.querySelector('[data-testid=timeline]').scrollTop = 0`);
    await settled();
    const bounds = await page.evaluate<any[]>(`[...document.querySelectorAll('[data-testid=agent-message-summary]')].map(node => {
      const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height };
    })`);
    expect(bounds).toHaveLength(4);
    for (const box of bounds) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); }
    if (width < 720) for (const box of bounds) expect(box.height).toBeGreaterThanOrEqual(44);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-mail-chronology-' + name + '.png'));
  }
  expect(page.errors()).toEqual([]);
}, 30_000);
