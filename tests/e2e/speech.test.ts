import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';
const requireUi = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(requireUi.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
beforeAll(async () => {
  const port = await freePort(); url = `http://127.0.0.1:${port}`;
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen(); page = await BrowserPage.launch({ url: `${url}/?fake=1` });
  await page.waitFor(`document.querySelector('${id('dictation-start')}')`);
  // Exercise the real AudioWorklet and resampler without touching a physical microphone.
  await page.evaluate(`window.__audioFixtures = new Set(); window.__stoppedTracks = 0; navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext({sinkId: {type:'none'}}); await context.resume();
    const oscillator = context.createOscillator(); oscillator.frequency.value = 220;
    const destination = context.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
    const fixture = {context, oscillator, destination}; window.__audioFixtures.add(fixture);
    for (const track of destination.stream.getTracks()) {
      const stop = track.stop.bind(track); track.stop = () => { window.__stoppedTracks++; stop(); oscillator.stop(); window.__audioFixtures.delete(fixture); if (context.state !== 'closed') void context.close(); };
    }
    return destination.stream;
  }`);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

async function capture(name: string) {
  await page.evaluate(`document.fonts.ready`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
async function type(value: string) {
  await page.evaluate(`(() => { const el = document.querySelector('${id('composer-input')}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
}
async function record() {
  await page.send('Runtime.evaluate', { expression: `document.querySelector('${id('dictation-start')}').click()`, userGesture: true });
  await page.waitFor(`['recording','error'].includes(document.querySelector('${id('dictation')}')?.dataset.phase)`);
  expect(await page.evaluate(`document.querySelector('${id('dictation')}')?.textContent`)).toContain('Listening');
  await page.send('HeapProfiler.collectGarbage', {});
  try { await page.waitFor(`Number(document.querySelector('[data-testid="dictation"] .duration')?.textContent.split(':')[1]) >= 1`); } catch (error) { console.log(await page.evaluate(`({dictation: document.querySelector('[data-testid="dictation"]')?.outerHTML, contexts: [...window.__audioFixtures].map(f => ({state:f.context.state, time:f.context.currentTime})), hidden:document.hidden})`)); throw error; }
  await page.waitFor(`document.querySelector('${id('dictation-preview')}')?.textContent.includes('Please add a test')`);
  expect(await page.evaluate(`document.querySelector('${id('dictation')}').getBoundingClientRect().height <= 44`)).toBe(true);
  expect(await page.evaluate(`!!document.querySelector('${id('dictation-stop')} svg')`)).toBe(true);
}
test('dictation captures audio and appends a transcript without sending or overwriting typed text', async () => {
  await type('Existing draft.');
  await capture('speech-desktop-idle.png');
  await record();
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('Existing draft.');
  await capture('speech-desktop-recording.png');
  expect(await page.evaluate(`document.querySelector('${id('composer-send')}').disabled`)).toBe(true);
  await type('Existing draft. Typed while talking.');
  await page.click(id('dictation-stop'));
  await page.waitFor(`document.querySelector('${id('composer-input')}').value.includes('Please add a test')`);
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('Existing draft. Typed while talking. Please add a test for this change.');
  expect(await page.evaluate('window.__stoppedTracks')).toBeGreaterThan(0);
  expect(await page.evaluate(`document.querySelector('${id('dictation')}').dataset.phase`)).toBe('idle');
}, 30_000);

test('phone dictation fits, cancels with Escape, and does not change the draft', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await type('Keep this draft.'); await capture('speech-phone-idle.png'); await record(); await capture('speech-phone-recording.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  expect(await page.evaluate(`document.querySelector('.composer .bar').getBoundingClientRect().height <= 56`)).toBe(true);
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`);
  await page.waitFor(`!!document.querySelector('${id('dictation-start')}')`);
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('Keep this draft.');
}, 30_000);

test('voice settings save API selection, hide credentials on reload, and fit phone and desktop', async () => {
  await page.evaluate(`document.querySelector('${id('nav-settings')}').click()`);
  await page.click(id('settings-tab-voice'));
  await page.waitFor(`document.querySelector('${id('voice-local')}')`);
  await capture('speech-phone-settings.png');
  await page.click(id('voice-api'));
  await page.evaluate(`const input = document.querySelector('${id('voice-groq-key')}'); input.value = 'fixture-only'; input.dispatchEvent(new Event('input', {bubbles:true}));`);
  await page.click(id('voice-save'));
  await page.waitFor(`document.querySelector('.saved')`);
  expect(await page.evaluate(`document.querySelector('${id('voice-groq-key')}').value`)).toBe('');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 950, deviceScaleFactor: 1, mobile: false });
  await capture('speech-desktop-settings.png');
  for (const provider of ['OpenRouter', 'Groq']) {
    await page.evaluate(`Array.from(document.querySelectorAll('.segmented button')).find(button => button.textContent === ${JSON.stringify(provider)}).click()`);
    expect(await page.evaluate(`!!document.querySelector('.saved')`)).toBe(false);
    await capture('speech-provider-unsaved.png');
    await page.click(id('voice-save'));
    await page.waitFor(`document.querySelector('.saved')`);
  }
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  expect(page.errors()).toEqual([]);
}, 30_000);

test('a denied microphone preserves the draft and shows a readable light-theme error', async () => {
  await page.click(id('settings-back'));
  await page.evaluate(`document.documentElement.dataset.theme = 'light'; navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));`);
  await type('Do not lose this.');
  await page.send('Runtime.evaluate', { expression: `document.querySelector('${id('dictation-start')}').click()`, userGesture: true });
  await page.waitFor(`document.querySelector('${id('dictation')}')?.dataset.phase === 'error'`);
  expect(await page.text(id('dictation-preview'))).toContain('Microphone permission was denied');
  await capture('speech-permission-light.png');
  await page.click(id('dictation-cancel'));
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('Do not lose this.');
  expect(page.errors()).toEqual([]);
}, 30_000);
