import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { startUi } from './lib/ui.ts';

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])');
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

test('silent Codex reasoning and completed stored tools remain visible after reconnect on desktop and phone', async () => {
  let page: BrowserPage | undefined, core: RunningCore | undefined, client: CoreClient | undefined, ui: { close(): Promise<void> } | undefined;
  try {
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    ui = await startUi(port, { development: true });
    core = await startCore({ env: { CODEX_FAKE_SILENT_DELAY: '100' } });
    client = await connect(core.url, core.token);
    await client.call('settings.set', { browserOrigins: [origin] });
    const profile = { detect: {}, executable: [{ kind: 'path', value: 'bun' }], launch: { args: [join(import.meta.dir, '../../packages/core/test/fixtures/codex-server.ts')] }, isolation: {} };
    mkdirSync(join(core.dataDir, 'providers'), { recursive: true });
    writeFileSync(join(core.dataDir, 'providers/codex-fixture.json'), JSON.stringify({ id: 'codex-fixture', schemaVersion: 1, name: 'Codex fixture', shortName: 'Codex', protocol: 'codex-appserver', roots: ['{isolationDir}'], profiles: { windows: profile, linux: profile, macos: profile }, auth: { kind: 'none' }, models: [{ id: 'fake-codex', name: 'Fake Codex', default: true }], capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true } }));
    expect((await client.call('providers.reload', {})).rejected).toEqual([]);
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Migration test' });
    const account = await client.call('accounts.add', { providerId: 'codex-fixture', label: 'Fixture', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, accountId: account.id, providerId: 'codex-fixture', model: 'fake-codex', title: 'Migration activity' });
    await client.call('threads.update', { threadId: thread.id, title: thread.title });
    page = await BrowserPage.launch({ url: `${origin}/?core=${encodeURIComponent(core.url)}&token=${encodeURIComponent(core.token)}` });
    await page.click('[data-testid=confirm-ok]');
    await page.click(`[data-thread-id="${thread.id}"]`);
    await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === ${JSON.stringify(thread.id)} && !globalThis.__boiteTest.workspace.active.loadingThread`);
    await client.call('turns.start', { threadId: thread.id, prompt: '[silent-reasoning]' });
    await page.waitFor('globalThis.__boiteTest.workspace.active.openThread?.progress?.phase === "thinking"');
    expect(await page.evaluate('document.querySelector("[data-testid=turn-progress], [data-testid=turn-last-activity]") === null')).toBe(true);
    expect(await page.evaluate('globalThis.__boiteTest.workspace.active.openThread.messages.filter(message => message.role === "assistant").flatMap(message => message.parts).filter(part => part.type === "thinking").length')).toBe(0);
    await capture(page, 'codex-silent-thinking-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await capture(page, 'codex-silent-thinking-phone.png');
    await page.waitFor('globalThis.__boiteTest.workspace.active.openThread?.progress?.phase === "waiting"');
    const before = await client.call('threads.get', { threadId: thread.id });
    const ids = before.messages.map(message => message.id);
    // Closing the page drops its websocket and subscription, then a new page loads the stored snapshot.
    await page.close();
    page = await BrowserPage.launch({ url: `${origin}/?core=${encodeURIComponent(core.url)}&token=${encodeURIComponent(core.token)}` });
    await page.click('[data-testid=confirm-ok]');
    const working = `[data-testid=project][data-project-id="${project.id}"] [data-testid=project-working-toggle]`;
    await page.waitFor(`document.querySelector(${JSON.stringify(working)})?.dataset.count === '1'`);
    await page.click(working);
    await page.click(`[data-thread-id="${thread.id}"]`);
    await page.waitFor('globalThis.__boiteTest.workspace.active.openThread?.progress?.phase === "waiting"');
    expect(await page.evaluate('globalThis.__boiteTest.workspace.active.openThread.messages.map(message => message.id)')).toEqual(ids);
    expect(await page.evaluate('document.querySelectorAll("[data-role=assistant]").length')).toBe(1);
    expect(await page.evaluate('document.querySelector("[data-testid=chat]").textContent.includes("Message already stored.")')).toBe(true);
    expect(await page.evaluate('document.querySelector("[data-testid=chat]").textContent.includes("opaque-do-not-render")')).toBe(false);
    expect(await page.evaluate('globalThis.__boiteTest.workspace.active.openThread.messages.flatMap(message => message.parts).filter(part => part.type === "tool").map(part => [part.status, part.output])')).toEqual([['done', 'Filesystem copied']]);
    await page.evaluate('(() => { const store = globalThis.__boiteTest.workspace.active; store.openThread = { ...store.openThread, progress: { ...store.openThread.progress, at: Date.now() - 75000 } }; })()');
    await page.waitFor('document.querySelector("[data-testid=turn-progress]")?.textContent === "Waiting for provider"');
    await capture(page, 'codex-silent-reconnected-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await capture(page, 'codex-silent-reconnected-phone.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await client.call('turns.stop', { threadId: thread.id });
  } finally {
    await page?.close(); await ui?.close(); client?.close(); await core?.stop();
  }
}, 120_000);
