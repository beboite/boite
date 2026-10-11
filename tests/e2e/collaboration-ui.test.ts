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
    const here = { coreId: localIdentity.coreId, threadId: 't-trace' };
    const there = { coreId: remoteIdentity.coreId, threadId: 't-bench' };
    const incoming = await remote.call('collaboration.send', { threadId: 't-bench', to: here,
      text: 'Wait before restart. The deployment is still using the build machine.', requestId: 'incoming-deployment' });
    const outgoing = await local.call('collaboration.send', { threadId: 't-trace', to: there,
      text: 'Restart postponed until you say the build machine is clear.', replyTo: incoming.id, requestId: 'outgoing-reply' });
    // Short updates both ways, the way the agents are told to write.
    const said = [
      ['in', 'Deploy 2.4.1 at 62%. About 4 min left.'],
      ['in', 'Smoke tests running on staging.'],
      ['out', 'OK. I keep the trace tab work local until then.'],
      ['in', 'Done. Build machine is free, restart is yours.'],
      ['out', 'Restarting the build machine now. Back in 2 min.'],
      ['out', 'Back up. Trace capture passes on the new image.'],
      ['in', 'Thanks. Closing the deployment.']
    ];
    for (const [index, [side, text]] of said.entries()) await (side === 'in'
      ? remote.call('collaboration.send', { threadId: 't-bench', to: here, text, requestId: 'said-' + index })
      : local.call('collaboration.send', { threadId: 't-trace', to: there, text, requestId: 'said-' + index }));
    // A thread this one started reports back: its discussion carries that tie.
    const notes = await local.call('agent.spawn', { threadId: 't-trace', project: 'notes', prompt: 'Write the 2.4.1 release notes from the merged pull requests.', title: 'Release notes 2.4.1', requestId: 'spawn-notes' });
    window.__notes = notes.thread.id;
    await local.call('collaboration.send', { threadId: notes.thread.id, to: here, text: 'Draft ready: 14 changes, 2 breaking. Want the migration note first?', requestId: 'notes-draft' });
    // An owner-authored delegation prompt stays on the user side even when it is outgoing.
    const delegation = await local.call('delegation.get', { threadId: 't-trace' });
    workspace.active.delegation = { ...delegation, messages: [{
      ...outgoing, id: 'user-delegation', origin: 'user', text: 'Please check the benchmark against legacy.', replyTo: null,
      createdAt: incoming.createdAt - 1,
      from: { ...outgoing.from, coreId: 'local' }, to: { coreId: 'local', threadId: 't-bench' }, toTitle: 'Bench against legacy'
    }] };
  })()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-discussion-row"][data-peer="core-build-pc/t-bench"][data-count="9"]')`);
  await page.waitFor(`document.querySelector('[data-testid="thread-menu-trigger"]')`);
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the chat shows one row per discussion, and the panel lists discussions and opens their back and forth at desktop and phone widths', async () => {
  const deployment = '[data-testid="agent-discussion-row"][data-peer="core-build-pc/t-bench"][data-count="9"]';
  const notesId = await page.evaluate<string>('window.__notes');
  const notesRow = `[data-testid="agent-discussion-row"][data-peer="here/${notesId}"]`;
  // One row per conversation of a burst, in the order they started, with its last words; the started thread's report comes after the line that started it.
  expect(await page.evaluate(`[...document.querySelectorAll('[data-testid=timeline] [data-testid=agent-message-group]')].map(group => [...group.querySelectorAll('[data-testid=agent-discussion-row]')].map(node => node.dataset.peer + ':' + node.dataset.count))`))
    .toEqual([['here/t-bench:1', 'core-build-pc/t-bench:9'], [`here/${notesId}:1`]]);
  expect(await page.text(deployment)).toContain('Deployment agent');
  expect(await page.text(deployment)).toContain('Thanks. Closing the deployment.');
  expect(await page.text(notesRow)).toContain('Started from here');
  expect(await page.text(notesRow)).toContain('notes');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="timeline"] [data-testid="agent-discussion-message"]').length`)).toBe(0);
  expect(await page.text('[data-testid=timeline]')).not.toContain('Deploy 2.4.1 at 62%');
  await page.evaluate(`document.querySelector(${JSON.stringify(deployment)}).scrollIntoView({ block: 'center' })`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-discussions-chat-desktop.png'));

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector(${JSON.stringify(deployment)}).scrollIntoView({ block: 'center' })`);
  await settled();
  expect(await page.evaluate(`[...document.querySelectorAll('[data-testid=agent-discussion-row]')].every(node => { const box = node.getBoundingClientRect(); return box.height >= 44 && box.left >= 0 && box.right <= innerWidth; })`)).toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-discussions-chat-phone.png'));

  // A row opens its discussion on the burst's first letter, in a sheet on a phone.
  await page.click(deployment);
  await page.waitFor(`document.querySelector('[data-testid=agent-discussion-view][data-peer="core-build-pc/t-bench"]')`);
  await page.waitFor(`document.querySelectorAll('[data-testid=agent-discussion-view] [data-testid=agent-discussion-message]').length === 9`);
  // The burst's first letter flashes once; the captures wait for it to settle.
  await page.waitFor(`!document.querySelector('[data-testid=agent-discussion-message].flash')`);
  await settled();
  const checkSides = async () => {
    const sides = await page.evaluate<any>(`(() => {
      const view = document.querySelector('[data-testid=agent-discussion-view]');
      const incoming = view.querySelector('[data-letter-id="incoming-deployment"]');
      const outgoing = view.querySelector('[data-letter-id="outgoing-reply"]');
      const prompt = document.querySelector('[data-role="user"] .bubble');
      return { incomingRight: incoming.getBoundingClientRect().right, outgoingRight: outgoing.getBoundingClientRect().right,
        incomingLeft: incoming.getBoundingClientRect().left, outgoingLeft: outgoing.getBoundingClientRect().left,
        incomingColor: getComputedStyle(incoming.querySelector('.bubble')).backgroundColor,
        outgoingColor: getComputedStyle(outgoing.querySelector('.bubble')).backgroundColor,
        promptColor: prompt && getComputedStyle(prompt).backgroundColor,
        quote: outgoing.querySelector('[data-testid=agent-discussion-quote]')?.textContent ?? null,
        heading: view.querySelector('[data-testid=agent-discussion-heading]').textContent,
        where: view.querySelector('[data-testid=agent-discussion-where]').textContent,
        about: view.querySelector('.about')?.textContent ?? '' };
    })()`);
    // What reaches this agent sits on the user's side, in the user's prompt color; its own words on the agent's side.
    expect(sides.incomingRight).toBeGreaterThan(sides.outgoingRight);
    expect(sides.incomingLeft).toBeGreaterThan(sides.outgoingLeft);
    if (sides.promptColor) expect(sides.incomingColor).toBe(sides.promptColor);
    expect(sides.outgoingColor).not.toBe(sides.incomingColor);
    // The reply follows the message it answers: no quote needed.
    expect(sides.quote).toBeNull();
    expect(sides.heading).toBe('Deployment agent');
    expect(sides.where).toContain('Build PC');
    expect(sides.about).toContain('Owns deployment and restart sequencing');
  };
  await checkSides();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-discussion-phone.png'));

  await page.evaluate(`window.__boiteTest.setTheme('light')`);
  await settled();
  await checkSides();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-discussion-phone-light.png'));
  await page.evaluate(`window.__boiteTest.setTheme('dark')`);

  await page.evaluate(`import('/src/lib/i18n.svelte.ts').then(module => module.setLocaleSetting('fr'))`);
  await page.click('[data-testid=agent-discussion-back]');
  await page.waitFor(`document.querySelectorAll('[data-testid=agent-discussion]').length === 3`);
  await settled();
  expect(await page.text(`[data-testid=agent-discussion][data-peer="here/${notesId}"]`)).toContain('Lancée d\'ici');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-discussions-list-phone-fr.png'));
  await page.evaluate(`import('/src/lib/i18n.svelte.ts').then(module => module.setLocaleSetting('en'))`);
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);

  // On a desktop, the list and the open discussion sit side by side once the panel is wide.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click(deployment);
  await page.waitFor(`document.querySelector('[data-testid=agent-discussion-view]') && !document.querySelector('[data-testid=agent-discussion-message].flash')`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid=panel-tab][data-kind=messages]').length`)).toBe(1);
  await settled();
  await checkSides();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-discussion-desktop.png'));
  await page.click('[data-testid=panel-maximize]');
  await page.waitFor(`getComputedStyle(document.querySelector('[data-testid=agent-discussions]')).display !== 'none' && document.querySelector('[data-testid=agent-discussion-view]') !== null`);
  await settled();
  expect(await page.evaluate(`(() => { const list = document.querySelector('[data-testid=agent-discussions]').getBoundingClientRect(); const view = document.querySelector('[data-testid=agent-discussion-view]').getBoundingClientRect(); return list.right <= view.left + 1 && list.width > 200; })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-discussion-desktop-wide.png'));
  await page.click('[data-testid=panel-maximize]');
  await page.click(`[data-testid=agent-discussion][data-peer="here/t-bench"]`);
  await page.waitFor(`document.querySelector('[data-testid=agent-discussion-view][data-peer="here/t-bench"]')`);
  expect(await page.evaluate(`(() => { const user = document.querySelector('[data-letter-id="user-delegation"]'); return [user.classList.contains('right'), user.querySelector('.label')?.textContent]; })()`)).toEqual([true, 'You']);
  expect(await page.text('[data-testid=timeline]')).not.toContain('Boite agent coordination');
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

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
    const bounds = await page.evaluate<any[]>(`[...document.querySelectorAll('[data-testid=agent-discussion-row]')].map(node => {
      const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height };
    })`);
    // Each turn's exchange with the one peer is one row.
    expect(bounds).toHaveLength(2);
    for (const box of bounds) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); }
    if (width < 720) for (const box of bounds) expect(box.height).toBeGreaterThanOrEqual(44);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'agent-mail-chronology-' + name + '.png'));
  }
  expect(page.errors()).toEqual([]);
}, 30_000);
