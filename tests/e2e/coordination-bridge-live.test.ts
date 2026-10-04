import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { startUi } from './lib/ui.ts';

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])');
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

test('the owner app relays signed reads, preserves directional grants on reload, and displays actual turn activity', async () => {
  const cores: RunningCore[] = [], clients: CoreClient[] = [];
  let page: BrowserPage | undefined, ui: { close(): Promise<void> } | undefined;
  try {
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    ui = await startUi(port);
    for (let index = 0; index < 2; index++) {
      const core = await startCore(); cores.push(core);
      const client = await connect(core.url, core.token); clients.push(client);
      await client.call('settings.set', { browserOrigins: [origin] });
    }
    const threads = [];
    for (const [index, client] of clients.entries()) {
      const project = await client.call('projects.add', { path: cores[index]!.dataDir, name: index ? 'Server project' : 'Client project' });
      const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
      threads.push(await client.call('threads.create', { projectId: project.id, accountId: account.id, providerId: 'echo', title: index ? 'Server agent' : 'Client migration' }));
    }
    const [pc, server] = clients as [CoreClient, CoreClient];
    const [cardPC, cardServer] = await Promise.all(clients.map(client => client.call('collaboration.identity', {})));
    page = await BrowserPage.launch({ url: `${origin}/?core=${encodeURIComponent(cores[0]!.url)}&token=${encodeURIComponent(cores[0]!.token)}` });
    await page.click('[data-testid=confirm-ok]');
    await page.waitFor(`document.querySelector('[data-thread-id="${threads[0]!.id}"]')`);
    expect(await page.evaluate(`globalThis.__boiteTest.workspace.add(${JSON.stringify({ url: cores[1]!.url, token: cores[1]!.token })}, 'Build server')`)).toBe(true);
    await page.waitFor('globalThis.__boiteTest.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === "ready")');
    await page.evaluate('globalThis.__boiteTest.workspace.machines[0].label = "Client PC"');
    // Wait for the app's automatic link, not a manually installed test relay.
    await page.waitFor(`globalThis.__boiteTest.workspace.machines[0].store.coordinationPeers().then(peers => peers.some(peer => peer.coreId === ${JSON.stringify(cardServer!.coreId)}))`);
    // Trust is published before both signed relay routes finish registering.
    // Probe the routes before checking a destination's read permission.
    await page.waitFor(`Promise.all([
      globalThis.__boiteTest.workspace.machines[0].store.checkCoordinationPeer(${JSON.stringify(cardServer!.coreId)}),
      globalThis.__boiteTest.workspace.machines[1].store.checkCoordinationPeer(${JSON.stringify(cardPC!.coreId)})
    ]).then(() => true).catch(() => false)`);
    const address = { coreId: cardPC!.coreId, threadId: threads[0]!.id };
    await expect(server.call('collaboration.read', { threadId: threads[1]!.id, target: address })).rejects.toThrow('not allowed to read');
    // Install an existing directional permission before the app migrates its legacy connections.
    await pc.call('collaboration.trust', { peer: { ...cardServer!, readThreads: true, viaClient: true } });
    // The server cannot dial this address. Only the real browser relay can complete the read.
    await server.call('collaboration.trust', { peer: { ...cardPC!, url: 'http://127.0.0.1:1', viaClient: true } });
    expect((await server.call('collaboration.read', { threadId: threads[1]!.id, target: address })).contact.threadId).toBe(threads[0]!.id);
    await expect(pc.call('collaboration.read', { threadId: threads[0]!.id, target: { coreId: cardServer!.coreId, threadId: threads[1]!.id } })).rejects.toThrow('not allowed to read');
    await page.click('[data-testid=nav-settings]'); await page.click('[data-testid=settings-tab-machines]');
    await page.waitFor('globalThis.__boiteTest.workspace.machines.every(machine => machine.store.group?.cores.length === 2)');
    expect(await pc.call('collaboration.peers', {})).toEqual([]);
    expect(await server.call('collaboration.peers', {})).toEqual([]);
    expect((await server.call('collaboration.read', { threadId: threads[1]!.id, target: address })).contact.threadId).toBe(threads[0]!.id);
    await page.evaluate('document.querySelector("[data-testid=group-card]").scrollIntoView()');
    await capture(page, 'agent-read-access-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.waitFor('document.querySelector("[data-testid=group-card]")');
    await page.evaluate('document.querySelector("[data-testid=group-card]").scrollIntoView({ block: "center" })');
    await capture(page, 'agent-read-access-phone.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    expect(await page.evaluate('document.querySelectorAll("[data-testid=group-card]").length')).toBe(1);
    expect(await page.evaluate('document.querySelector("[data-testid=agent-links]") === null')).toBe(true);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.reload', {});
    await page.waitFor('globalThis.__boiteTest?.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === "ready")');
    await page.waitFor(`globalThis.__boiteTest.workspace.machines[1].store.client.call('collaboration.directory', { threadId: ${JSON.stringify(threads[1]!.id)} }).then(result => result.agents.some(agent => agent.coreId === ${JSON.stringify(cardPC!.coreId)}))`);
    expect(await pc.call('collaboration.peers', {})).toEqual([]);
    expect((await server.call('collaboration.read', { threadId: threads[1]!.id, target: address })).contact.threadId).toBe(threads[0]!.id);
    await pc.call('collaboration.untrust', { coreId: cardServer!.coreId });
    await expect(server.call('collaboration.read', { threadId: threads[1]!.id, target: address })).rejects.toThrow('not allowed to read');
    await page.click(`[data-thread-id="${threads[0]!.id}"]`);
    await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === ${JSON.stringify(threads[0]!.id)} && !globalThis.__boiteTest.workspace.active.loadingThread`);
    await page.type('[data-testid=composer-input]', 'Prepare the filesystem [think][sleep:60000]');
    await page.click('[data-testid=composer-send]');
    await page.waitFor('document.querySelector("[data-testid=turn-progress]")?.textContent.includes("Thinking")');
    const observed = await pc.call('threads.get', { threadId: threads[0]!.id });
    expect(observed.progress?.phase).toBe('thinking');
    // Age only the view fixture to exercise the quiet-state layout without a one-minute sleep.
    await page.evaluate('(() => { const store = globalThis.__boiteTest.workspace.active; store.openThread = { ...store.openThread, progress: { ...store.openThread.progress, at: Date.now() - 65000 } }; })()');
    await page.waitFor('document.querySelector("[data-testid=turn-last-activity]")?.textContent.includes("No new activity")');
    await capture(page, 'agent-activity-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await capture(page, 'agent-activity-phone.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    expect(await page.evaluate('document.querySelector("[data-testid=turn-summary] button") === null')).toBe(true);
    await page.evaluate('globalThis.__boiteTest.workspace.active.panel.open("trace")');
    await page.waitFor('document.querySelector("[data-testid=trace-panel]")');
    await pc.call('turns.stop', { threadId: threads[0]!.id });
    await page.close(); page = undefined;
    await expect(server.call('collaboration.read', { threadId: threads[1]!.id, target: address })).rejects.toThrow();
  } finally {
    await page?.close(); await ui?.close();
    for (const client of clients) client.close();
    for (const core of cores.reverse()) await core.stop();
  }
}, 120_000);
