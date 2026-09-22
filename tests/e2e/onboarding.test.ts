import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';
const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
const PALETTE_CHORD = `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }))`;
async function capture(name: string) {
  // Static layout captures use the final frame. The interaction test below
  // checks the running timeline, pause and replay separately.
  await page.evaluate(`document.fonts.ready.then(() => { for (const animation of document.getAnimations()) { if (animation.effect?.getTiming().iterations !== Infinity) animation.finish(); } })`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  // The one profile in the suite that has never seen the tour.
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, showTour: true });
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);
test('a new device gets the tour on its own, holds the app keys under it, and never again once closed', async () => {
  // The app loads the tour on demand: this proves the loader, not the component.
  await page.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === 'welcome'`);
  await capture('onboarding-welcome.png');

  // The palette chord belongs to the app, and nothing of the app fires under a modal.
  await page.evaluate(PALETTE_CHORD);
  await Bun.sleep(200);
  expect(await page.evaluate<boolean>(`!!document.querySelector('[data-testid=palette]')`)).toBe(false);

  await page.click('[data-testid=onboarding-dot-agents]');
  await page.click('[data-testid=onboarding-example-panel]');
  await page.waitFor(`document.querySelector('[data-testid=onboarding-scene]')?.dataset.scene === 'panel'`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid=onboarding-step] kbd').length`)).toBe(0);
  await capture('onboarding-panel.png');

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('onboarding-panel-phone.png');
  const bounds = await page.evaluate<{ left: number; right: number; bottom: number }>(`(() => { const r = document.querySelector('[data-testid=onboarding] [role=dialog]').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; })()`);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(bounds.bottom).toBeLessThanOrEqual(844);
  await page.send('Emulation.clearDeviceMetricsOverride', {});

  await page.click('[data-testid=onboarding-skip]');
  await page.waitFor(`!document.querySelector('[data-testid=onboarding]')`);
  expect(await page.evaluate<number>(`JSON.parse(localStorage.getItem('boite.onboarding')).version`)).toBeGreaterThan(0);

  // The same chord, with the tour gone, is the app's again.
  await page.evaluate(PALETTE_CHORD);
  await page.waitFor(`document.querySelector('[data-testid=palette]')`);
  await page.evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await page.waitFor(`!document.querySelector('[data-testid=palette]')`);

  await page.reload();
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  await Bun.sleep(500);
  expect(await page.evaluate<boolean>(`!!document.querySelector('[data-testid=onboarding]')`)).toBe(false);
}, 45_000);

test('seven screens fit both languages and widths, without leaving the tour', async () => {
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  await page.reload();
  await page.waitFor(`document.querySelector('[data-testid=onboarding]')`);
  for (const locale of ['en', 'fr']) {
    await page.click('[data-testid=onboarding-dot-welcome]');
    await page.click(`[data-testid=onboarding-locale-${locale}]`);
    for (const width of [1100, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      for (const step of ['welcome', 'profile', 'agents', 'usage', 'reach', 'quiet', 'privacy']) {
        await page.click(`[data-testid=onboarding-dot-${step}]`);
        await page.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === '${step}'`);
        await capture(`tour-${locale}-${width}-${step}.png`);
        expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
        expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-next]').getBoundingClientRect().bottom <= innerHeight`)).toBe(true);
        expect(await page.evaluate(`document.querySelector('[data-testid=onboarding] header .count') === null`)).toBe(true);
        // The question is its own picture: two answers, no scene.
        if (step !== 'profile') expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-scene]').textContent.includes('Illustration')`)).toBe(false);
        if (step === 'agents') {
          for (const demo of ['voice', 'panel', 'agents']) {
            await page.click(`[data-testid=onboarding-example-${demo}]`);
            await capture(`tour-${locale}-${width}-demo-${demo}.png`);
            expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-animation]').scrollWidth <= document.querySelector('[data-testid=onboarding-animation]').clientWidth`)).toBe(true);
          }
        }
      }
    }
  }
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click('[data-testid=onboarding-dot-agents]');
  expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).length`)).toBe(0);
  await capture('tour-reduced-motion.png');
}, 120_000);

test('light theme and a short phone viewport keep consent and navigation reachable', async () => {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  await page.reload();
  await page.waitFor(`document.querySelector('[data-testid=onboarding]')`);
  await page.click('[data-testid=onboarding-dot-welcome]');
  await page.click('[data-testid=onboarding-theme-light]');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid=onboarding-dot-privacy]');
  await page.waitFor(`document.querySelectorAll('[data-testid=telemetry-settings] input').length === 2`);
  await page.evaluate(`document.querySelector('[data-testid=telemetry-settings]').scrollIntoView({block:'center'})`);
  await capture('tour-light-short-phone.png');
  expect(await page.evaluate(`document.documentElement.dataset.theme`)).toBe('light');
  expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-next]').getBoundingClientRect().bottom <= innerHeight`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid=telemetry-settings] input').getBoundingClientRect().top >= 0`)).toBe(true);
  const exits = await page.evaluate<Array<{ name: string; duration: number }>>(`(() => {
    return [...document.querySelectorAll('[data-testid=onboarding], [data-testid=onboarding] [role=dialog]')].map(element => {
      element.classList.add('closing');
      const style = getComputedStyle(element);
      const exit = { name: style.animationName, duration: parseFloat(style.animationDuration) };
      element.classList.remove('closing');
      return exit;
    });
  })()`);
  expect(exits).toHaveLength(2);
  for (const exit of exits) {
    expect(exit.name).not.toBe('none');
    expect(exit.duration).toBeGreaterThan(0);
    expect(exit.duration).toBeLessThanOrEqual(0.001);
  }
  await page.click('[data-testid=onboarding-next]');
  await page.waitFor(`!document.querySelector('[data-testid=onboarding]')`);
}, 15_000);

test('demo selectors look actionable and animations pause, resume and replay', async () => {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  await page.reload();
  await page.waitFor(`document.querySelector('[data-testid=onboarding]')`);
  await page.click('[data-testid=onboarding-dot-agents]');
  for (const demo of ['voice', 'panel', 'agents']) {
    await page.click(`[data-testid=onboarding-example-${demo}]`);
    expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-example-${demo}]').getAttribute('aria-pressed')`)).toBe('true');
    const button = await page.evaluate<{ height: number; border: number; cursor: string }>(`(() => { const el = document.querySelector('[data-testid=onboarding-example-${demo}]'); const css = getComputedStyle(el); return {height: el.getBoundingClientRect().height, border: parseFloat(css.borderWidth), cursor: css.cursor}; })()`);
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.border).toBeGreaterThan(0);
    expect(button.cursor).toBe('pointer');
  }
  await page.click('[data-testid=onboarding-example-voice]');
  await page.click('[data-testid=onboarding-animation-pause]');
  await page.waitFor(`document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).every(a => a.playState === 'paused')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-animation-pause]').getAttribute('aria-pressed')`)).toBe('true');
  await page.click('[data-testid=onboarding-animation-pause]');
  await page.waitFor(`document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).some(a => a.playState === 'running')`);
  await page.evaluate(`document.querySelector('[data-testid=onboarding-animation]').dataset.previous = 'yes'`);
  await page.click('[data-testid=onboarding-animation-replay]');
  await page.waitFor(`!document.querySelector('[data-testid=onboarding-animation]').dataset.previous`);
  expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).some(a => a.playState === 'running')`)).toBe(true);
}, 20_000);

test('agent update notices wait until the tour closes without dismissing pending updates', async () => {
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  const url = await page.evaluate<string>(`(() => { const url = new URL(location.href); url.searchParams.set('updates', '1'); return url.href; })()`);
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === 'welcome'`);
  expect(await page.evaluate(`document.querySelector('[data-testid=harness-update-notices]') === null`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('tour-pending-updates-phone.png');
  await page.click('[data-testid=onboarding-skip]');
  await page.waitFor(`!document.querySelector('[data-testid=onboarding]')`);
  await page.waitFor(`document.querySelectorAll('[data-testid=harness-update-notice]').length === 2`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid=harness-update-run]').length`)).toBe(2);
}, 20_000);

test('an unavailable onboarding chunk does not hide agent update notices or block the app', async () => {
  const offline = await BrowserPage.launch({ url: 'about:blank', showTour: true });
  try {
    await offline.send('Network.enable', {});
    await offline.send('Network.setBlockedURLs', { urls: ['*Onboarding.svelte*'] });
    const origin = await page.evaluate<string>('location.origin');
    await offline.navigate(`${origin}/?fake=1&updates=1`);
    await offline.waitFor(`document.querySelector('[data-testid=nav-settings]')`);
    await offline.waitFor(`document.querySelectorAll('[data-testid=harness-update-notice]').length === 2`);
    expect(await offline.evaluate(`document.querySelector('[data-testid=onboarding]') === null`)).toBe(true);
    await offline.click('[data-testid=nav-settings]');
    await offline.waitFor(`document.querySelector('[data-testid=settings]')`);
  } finally {
    await offline.close();
  }
}, 30_000);
