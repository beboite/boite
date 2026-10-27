import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

const input = '[data-testid=composer-input]';
const content = 'Continue this draft on the phone';

test('desktop and paired phone share drafts and attachments, and the core drains queues after both close', async () => {
  ensureProductionUi();
  let core = await startCore();
  let client = await connect(core.url, core.token);
  let desktop: BrowserPage | undefined, phone: BrowserPage | undefined;
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    await client.call('settings.set', { asyncQuestions: false });
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Composer sync' });
    const account = (await client.call('accounts.list', {})).find(item => item.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Server queue' });
    desktop = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
    phone = await BrowserPage.launch({ url: await mintPairing(core), windowSize: { width: 390, height: 844 } });
    await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const page of [desktop, phone]) await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');

    // A new conversation can be picked up by an independently paired device.
    await desktop.type(input, content);
    await phone.click('[data-testid=mobile-back], [data-testid=mobile-home]');
    await phone.waitFor(`Array.from(document.querySelectorAll('[data-testid=draft-row]')).some(el => el.textContent.includes(${JSON.stringify(content)}))`);
    await phone.evaluate(`Array.from(document.querySelectorAll('[data-testid=draft-row]')).find(el => el.textContent.includes(${JSON.stringify(content)})).click()`);
    await phone.waitFor(`document.querySelector('${input}')?.value === ${JSON.stringify(content)}`);
    await desktop.settleAnimations();
    await phone.settleAnimations();
    await desktop.screenshot(join(import.meta.dir, '.artifacts', 'composer-sync-desktop.png'));
    await phone.screenshot(join(import.meta.dir, '.artifacts', 'composer-sync-phone.png'));

    // A reply and its bytes travel through the same core-owned record.
    await desktop.click(`[data-thread-id="${thread.id}"]`);
    await phone.click('[data-testid=mobile-back]');
    await phone.click(`[data-testid="mobile-thread-${thread.id}"]`);
    for (const page of [desktop, phone]) await page.waitFor('document.querySelector("[data-testid=thread-header][data-status]")');
    await desktop.evaluate(`(() => { const send = WebSocket.prototype.send; window.composerWire = []; WebSocket.prototype.send = function(data) { if (typeof data === 'string') { const frame = JSON.parse(data); if (frame.method?.startsWith('composer.')) window.composerWire.push({method: frame.method, bytes: new TextEncoder().encode(data).length, inlineBytes: !!frame.params?.value?.input?.attachments?.some(file => 'data' in file)}); } return send.call(this, data); }; })()`);
    await desktop.type(input, 'An unsent reply with an attachment');
    await desktop.evaluate(`(() => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(1024 * 1024).fill(65)], 'draft.txt', {type: 'text/plain'})); document.querySelector('${input}').dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true})); })()`);
    await phone.waitFor(`document.querySelector('${input}')?.value.includes('An unsent reply with an attachment') && document.querySelector('[data-testid=composer-attachment]')?.textContent.includes('draft.txt')`);
    const saved = (await client.call('composer.list', {})).find(row => row.section === 'inputs' && row.id === thread.id)!;
    expect(saved.value?.input.attachments).toHaveLength(1);
    const attachment = await client.call('composer.asset.get', { assetId: saved.value!.input.attachments[0]!.assetId });
    expect(atob(attachment.data)).toBe('A'.repeat(1024 * 1024));
    await desktop.evaluate(`(async () => { const box = document.querySelector('${input}'); for (let i = 1; i <= 100; i++) { box.value = 'An unsent reply with an attachment ' + i; box.dispatchEvent(new Event('input', {bubbles: true})); await new Promise(resolve => setTimeout(resolve, 10)); } })()`);
    await phone.waitFor(`document.querySelector('${input}')?.value === 'An unsent reply with an attachment 100'`);
    const wire = await desktop.evaluate<{method: string; bytes: number; inlineBytes: boolean}[]>('window.composerWire');
    const uploads = wire.filter(frame => frame.method === 'composer.asset.put'), puts = wire.filter(frame => frame.method === 'composer.put');
    expect(uploads).toHaveLength(1);
    expect(puts.length).toBeLessThan(100);
    expect(puts.some(frame => frame.inlineBytes)).toBe(false);
    console.info(`composer wire: 1 MiB attachment, 100 edits, ${uploads.length} upload, ${puts.length} puts, ${puts.reduce((sum, frame) => sum + frame.bytes, 0)} metadata bytes`);
    await phone.click('[data-testid=composer-attachment-remove]');
    await desktop.waitFor('!document.querySelector("[data-testid=composer-attachment]")');

    // No tool boundary: the queue waits for the running turn to finish.
    await client.call('turns.start', { threadId: thread.id, prompt: 'Keep working [sleep:6000] Finished' });
    await desktop.waitFor('document.querySelector("[data-testid=thread-header]")?.dataset.status === "running"');
    await desktop.type(input, 'Deliver after every app is closed');
    await desktop.click('[data-testid=composer-send]');
    await phone.waitFor('document.querySelector("[data-testid=composer-queued]")?.textContent.includes("Deliver after every app is closed")');
    expect((await client.call('composer.list', {})).find(row => row.id === thread.id)?.value?.input.queued).toHaveLength(1);
    expect(desktop.errors()).toEqual([]);
    expect(phone.errors()).toEqual([]);
    await desktop.close(); desktop = undefined;
    await phone.close(); phone = undefined;
    const deadline = Date.now() + 20_000;
    while ((await client.call('threads.get', { threadId: thread.id })).messages.filter(message => message.role === 'user').length < 2 && Date.now() < deadline) await Bun.sleep(100);
    const delivered = await client.call('threads.get', { threadId: thread.id });
    expect(delivered.messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(delivered.turns).toHaveLength(2);
    expect((await client.call('composer.list', {})).find(row => row.id === thread.id)?.value?.input.queued).toEqual([]);

    // The server retains drafts and consumed queue state across a restart.
    client.close();
    await core.stop({ keepDataDir: true });
    core = await startCore({ dataDir: core.dataDir });
    client = await connect(core.url, core.token);
    const restored = await client.call('composer.list', {});
    expect(restored.some(row => row.section === 'drafts' && row.value?.input.text === content)).toBe(true);
    expect(restored.find(row => row.id === thread.id)?.value?.input.queued).toEqual([]);
    expect((await client.call('threads.get', { threadId: thread.id })).messages.filter(message => message.role === 'user')).toHaveLength(2);
  } finally {
    await desktop?.close(); await phone?.close(); client.close(); await core.stop();
  }
}, 120_000);
