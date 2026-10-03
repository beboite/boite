import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_RECORDING_TYPES } from '../../packages/contracts/src/index.ts';
import { startBrowserSession } from './lib/browser-session.ts';
import { connect } from '../../packages/core/src/client.ts';
const executable = process.env.BOITE_E2E_SHELL_EXE;
test.skipIf(process.platform !== 'win32' || !executable)('a paired phone sees and controls the native page; recording marks omit typed and password keys', async () => {
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Boite · direct iPhone</title><style>body{font:24px system-ui;padding:40px;background:#f4f0e8;color:#163d34}button,input{font:inherit;padding:16px;margin:12px}#result{min-height:40px}</style><h1>Depuis votre iPhone</h1><button id="action" onclick="document.querySelector('#result').textContent='Le téléphone a cliqué !'">Tester le clic</button><p id="result">En attente du téléphone</p><input id="message" placeholder="Votre message"><input id="password" type="password"><div style="height:1200px">Glissez pour défiler</div>`, { headers: { 'content-type': 'text/html;charset=utf-8' } }) });
  const session = await startBrowserSession(executable!, 'Validation du direct et des vidéos', ['remote-browser', 'pr-review', 'recording-indicators']);
  const captures = join(import.meta.dir, '.artifacts'); mkdirSync(captures, { recursive: true });
  const { client, command, threadId, page } = session;
  const { grant } = await client.call('pairing.grant', {}), phone = await connect(session.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    await phone.call('threads.subscribe', { threadId });
    const { tabId } = await command({ kind: 'open', url: site.url.href });
    await command({ kind: 'resize', width: 900, height: 700 });
    const first = await phone.call('browser.remoteFrame', { threadId });
    expect(first.title).toContain('iPhone'); expect(Buffer.from(first.base64, 'base64').subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    writeFileSync(join(captures, 'remote-live.jpg'), Buffer.from(first.base64, 'base64'));
    const point = async (selector: '#action' | '#message') => {
      const points = (await command({ kind: 'evaluate', expression: `Object.fromEntries(['#action', '#message'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return [selector, { x: (r.x + r.width / 2) / innerWidth, y: (r.y + r.height / 2) / innerHeight }];
      }))` })).value as Record<typeof selector, { x: number; y: number }>;
      return points[selector];
    };
    await phone.call('browser.remoteInput', { threadId, frameId: first.id, input: { kind: 'tap', ...await point('#action'), width: first.width, height: first.height } });
    expect((await command({ kind: 'evaluate', expression: "document.querySelector('#result').textContent" })).value).toBe('Le téléphone a cliqué !');
    await phone.call('browser.remoteInput', { threadId, frameId: first.id, input: { kind: 'tap', ...await point('#message'), width: first.width, height: first.height } });
    await phone.call('browser.remoteInput', { threadId, frameId: first.id, input: { kind: 'text', text: 'Bonjour depuis le téléphone' } });
    expect((await command({ kind: 'evaluate', expression: "document.querySelector('#message').value" })).value).toBe('Bonjour depuis le téléphone');
    await command({ kind: 'resize', width: 800, height: 600 });
    await expect(phone.call('browser.remoteInput', { threadId, frameId: first.id, input: { kind: 'key', key: 'Enter' } })).rejects.toThrow('page changed');
    // The pixel assertion below compares a dark badge with the light fixture.
    // Select the host theme explicitly instead of inheriting the runner's OS theme.
    await page.evaluate("localStorage.setItem('boite.theme', 'dark'); window.dispatchEvent(new StorageEvent('storage', { key: 'boite.theme' })); true");
    await page.waitFor("document.documentElement.dataset.theme !== 'light'");
    await command({ kind: 'recording-start', indicators: true });
    await command({ kind: 'click', selector: '#action' }); await Bun.sleep(220);
    await command({ kind: 'press', key: 'Tab' }); await Bun.sleep(220);
    const marks = () => command({ kind: 'evaluate', expression: "Object.keys(globalThis).filter(k=>k.startsWith('__boiteInput_')).flatMap(k=>globalThis[k].marks)" });
    expect(JSON.stringify((await marks()).value)).toContain('Tab');
    await command({ kind: 'type', selector: '#password', text: 'private-value-123' });
    await command({ kind: 'press', key: 'Backspace' }); await Bun.sleep(180);
    const events = JSON.stringify((await marks()).value); expect(events).not.toContain('private-value'); expect(events).not.toContain('⌫');
    const result = (await command({ kind: 'recording-stop' })).recording!;
    expect(result.bytes).toBeGreaterThan(1000); expect(result.reason).toBe('stopped');
    const chunks: Buffer[] = []; let offset = 0;
    for (;;) { const r = (await command({ kind: 'recording-read', recordingId: result.id, offset })).value as { base64: string; nextOffset: number; done: boolean }; chunks.push(Buffer.from(r.base64, 'base64')); offset = r.nextOffset; if (r.done) break; }
    writeFileSync(join(captures, `recording-indicators.${BROWSER_RECORDING_TYPES[result.mime]}`), Buffer.concat(chunks));
    expect((await command({ kind: 'evaluate', expression: "Object.keys(globalThis).filter(k=>k.startsWith('__boiteInput_')).length" })).value).toBe(0);
    await page.waitFor("document.querySelector('[data-testid=browser-recording-preview]')?.readyState >= 2");
    // Decode the saved clip: collecting an event alone did not prove that the
    // encoder captured its badge after the asynchronous page screenshot.
    const badgeVisible = await page.evaluate(`(async () => {
      const video = document.querySelector('[data-testid=browser-recording-preview]');
      await new Promise(resolve => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = video.duration * .65; });
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
      const pixel = ctx.getImageData(canvas.width / 2 - 22, canvas.height - 45, 1, 1).data;
      return pixel[0] + pixel[1] + pixel[2] < 300;
    })()`);
    expect(badgeVisible).toBe(true);
    await page.screenshot(join(captures, 'recording-indicators-desktop.png'));
    await command({ kind: 'recording-discard', recordingId: result.id });
    await command({ kind: 'close' }, tabId);
    await Bun.sleep(250);
    await expect(phone.call('browser.remoteFrame', { threadId })).rejects.toThrow('browser tab');
  } finally { phone.close(); await session.close(); site.stop(true); }
}, 120000);
