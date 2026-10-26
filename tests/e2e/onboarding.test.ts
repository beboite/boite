import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';
import { mobileAction } from './lib/mobile.ts';
let server: { close(): Promise<void> };
let page: BrowserPage;
const PALETTE_CHORD = `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }))`;
/** Notes, for every palette that opens, whether the tour was up at that moment. */
const WATCH_PALETTE = `(() => {
  window.__paletteOpens = [];
  let shown = false;
  new MutationObserver(() => {
    const open = !!document.querySelector('[data-testid=palette]');
    if (open && !shown) window.__paletteOpens.push(!!document.querySelector('[data-testid=onboarding]'));
    shown = open;
  }).observe(document.body, { childList: true, subtree: true });
})()`;
/** Runs before the app on the next load: notes whether the tour is ever drawn. */
const WATCH_TOUR = `new MutationObserver(() => { if (document.querySelector('[data-testid=onboarding]')) window.__tourShown = true; }).observe(document, { childList: true, subtree: true });`;
async function capture(name: string, browser = page) {
  // Static layout captures use the final frame. The interaction test below
  // checks the running timeline, pause and replay separately.
  await browser.evaluate(`document.fonts.ready.then(() => { for (const animation of document.getAnimations()) { if (animation.effect?.getTiming().iterations !== Infinity) animation.finish(); } })`);
  await browser.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  // The one profile in the suite that has never seen the tour.
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, showTour: true });
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);
test('a new device gets the tour on its own, holds the app keys under it, and never again once closed', async () => {
  // The app loads the tour on demand: this proves the loader, not the component.
  await page.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === 'welcome'`);
  await capture('onboarding-welcome.png');

  // The palette chord belongs to the app, and nothing of the app fires under a
  // modal. Every palette that opens from here on is noted with whether the tour
  // was up, and the check waits for the one the same chord opens once the tour
  // is gone: a palette the blocked chord let through would be drawn before it.
  await page.evaluate(WATCH_PALETTE);
  await page.evaluate(PALETTE_CHORD);

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

  // The same chord, with the tour gone, is the app's again, and it is the only one that opened the palette.
  await page.evaluate(PALETTE_CHORD);
  await page.waitFor(`document.querySelector('[data-testid=palette]')`);
  expect(await page.evaluate(`window.__paletteOpens`)).toEqual([false]);
  await page.evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await page.waitFor(`!document.querySelector('[data-testid=palette]')`);

  // After a reload the tour, had it been decided, would load at boot and hold
  // the keys once drawn. A watcher set before the app's scripts notes whether it
  // ever appears; the palette opening on the chord proves the keys are the
  // app's, and its own chunk is asked for after the tour's would have been.
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_TOUR }) as { identifier: string };
  try {
    await page.reload();
    await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
    await page.evaluate(PALETTE_CHORD);
    await page.waitFor(`document.querySelector('[data-testid=palette]')`);
    await page.evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await page.waitFor(`!document.querySelector('[data-testid=palette]')`);
    expect(await page.evaluate<boolean>(`window.__tourShown === true || !!document.querySelector('[data-testid=onboarding]')`)).toBe(false);
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
}, 45_000);

/** On a computer every screen fits the panel: a tour that scrolls hides its own demonstration. */
const FITS = `(() => { const screen = document.querySelector('[data-testid=onboarding-step]'); return screen.scrollHeight <= screen.clientHeight; })()`;
test('seven screens fit both languages and widths, without leaving the tour', async () => {
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  await page.reload();
  await page.waitFor(`document.querySelector('[data-testid=onboarding]')`);
  for (const locale of ['en', 'fr']) {
    await page.click('[data-testid=onboarding-dot-welcome]');
    await page.click(`[data-testid=onboarding-locale-${locale}]`);
    for (const width of [1100, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      let panelHeight: number | undefined;
      for (const step of ['welcome', 'profile', 'agents', 'usage', 'reach', 'quiet', 'privacy']) {
        await page.click(`[data-testid=onboarding-dot-${step}]`);
        await page.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === '${step}'`);
        await capture(`tour-${locale}-${width}-${step}.png`);
        if (width > 390 || step === 'privacy') expect(await page.evaluate(FITS)).toBe(true);
        const height = await page.evaluate<number>(`document.querySelector('[data-testid=onboarding] [role=dialog]').getBoundingClientRect().height`);
        expect(height).toBeLessThanOrEqual(width === 390 ? step === 'privacy' ? 868 : 640 : 600);
        // Privacy is the final action, and uses the phone's height to expose every choice.
        if (panelHeight !== undefined && !(width === 390 && step === 'privacy')) expect(height).toBe(panelHeight);
        panelHeight = height;
        if (step !== 'profile' && step !== 'privacy') {
          // The measures come with a failure: the controls' place depends on the pointer the machine reports.
          expect(await page.evaluate(`(() => {
            const scene = document.querySelector('[data-testid=onboarding-scene]');
            const controls = scene.querySelector('.controls');
            const top = controls.getBoundingClientRect().top, bottom = scene.querySelector('.stage').getBoundingClientRect().bottom;
            return { below: getComputedStyle(controls).display === 'none' || top >= bottom, top, bottom, transform: getComputedStyle(controls).transform, hover: matchMedia('(hover: hover)').matches, figure: scene.className, step: '${step}' };
          })()`)).toMatchObject({ below: true });
        }
        expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
        // Privacy ends on its consent rows, every other screen on Next.
        expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-${step === 'privacy' ? 'back' : 'next'}]').getBoundingClientRect().bottom <= innerHeight`)).toBe(true);
        expect(await page.evaluate(`document.querySelector('[data-testid=onboarding] header .count') === null`)).toBe(true);
        // The question is its own picture: two answers, no scene.
        expect(await page.evaluate(`!document.querySelector('[data-testid=onboarding-scene]')?.textContent.includes('Illustration')`)).toBe(true);
        if (step === 'agents') {
          for (const demo of ['voice', 'panel', 'agents']) {
            await page.click(`[data-testid=onboarding-example-${demo}]`);
            await capture(`tour-${locale}-${width}-demo-${demo}.png`);
            if (width > 390) expect(await page.evaluate(FITS)).toBe(true);
            expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-animation]').scrollWidth <= document.querySelector('[data-testid=onboarding-animation]').clientWidth`)).toBe(true);
          }
        }
      }
    }
  }
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click('[data-testid=onboarding-dot-agents]');
  // The scenes are the tour's pictures: they play like a GIF even under reduced motion, with the pause at hand.
  await page.waitFor(`document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).some(a => a.playState === 'running')`);
  expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid=onboarding-scene] .controls')).display`)).not.toBe('none');
  await capture('tour-reduced-motion.png');
}, 120_000);

test('light theme and a short phone viewport keep consent and navigation reachable', async () => {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  // The seven screens open at a computer's width; a page that boots phone-wide gets the two-screen tour.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.reload();
  await page.waitFor(`document.querySelector('[data-testid=onboarding]')`);
  await page.click('[data-testid=onboarding-dot-welcome]');
  await page.click('[data-testid=onboarding-theme-light]');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid=onboarding-dot-privacy]');
  await page.waitFor(`document.querySelector('[data-testid=onboarding-telemetry-enhanced]')`);
  await page.evaluate(`document.querySelector('[data-testid=onboarding-telemetry-enhanced]').scrollIntoView({block:'center'})`);
  await capture('tour-light-short-phone.png');
  expect(await page.evaluate(`document.documentElement.dataset.theme`)).toBe('light');
  expect(await page.evaluate(`document.querySelector('[data-testid=onboarding-back]').getBoundingClientRect().bottom <= innerHeight`)).toBe(true);
  expect(await page.evaluate(`(() => { const r = document.querySelector('[data-testid=onboarding-telemetry-enhanced]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
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
  await page.click('[data-testid=onboarding-telemetry-enhanced]');
  await page.waitFor(`!document.querySelector('[data-testid=onboarding]')`);
}, 15_000);

test('demo selectors look actionable and animations pause, resume and replay', async () => {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  // The seven screens open at a computer's width; a page that boots phone-wide gets the two-screen tour.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.reload();
  await page.waitFor(`document.querySelector('[data-testid=onboarding]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 640, deviceScaleFactor: 1, mobile: true });
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

  // Played to its end, the scene rests on its last frame and starts again by itself.
  await page.evaluate(`(() => { const stage = document.querySelector('[data-testid=onboarding-animation]'); for (const a of stage.getAnimations({subtree:true})) a.finish(); stage.dataset.previous = 'yes'; })()`);
  await page.waitFor(`!document.querySelector('[data-testid=onboarding-animation]').dataset.previous && document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).some(a => a.playState === 'running')`, 8_000);
  // A hidden window holds it where it is.
  await page.evaluate(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))`);
  await page.waitFor(`document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).every(a => a.playState !== 'running')`);
  await page.evaluate(`delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'))`);
  await page.waitFor(`document.querySelector('[data-testid=onboarding-animation]').getAnimations({subtree:true}).some(a => a.playState === 'running')`);
}, 30_000);

test('pending agent updates remain in Machines after the tour closes', async () => {
  await page.evaluate(`localStorage.removeItem('boite.onboarding')`);
  const url = await page.evaluate<string>(`(() => { const url = new URL(location.href); url.searchParams.set('updates', '1'); return url.href; })()`);
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === 'welcome'`);
  expect(await page.evaluate(`document.querySelector('[data-testid=harness-update-notices]') === null`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('tour-pending-updates-phone.png');
  await page.click('[data-testid=onboarding-skip]');
  await page.waitFor(`!document.querySelector('[data-testid=onboarding]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=harness-update-notices]') === null`)).toBe(true);
  // A phone's settings open on the machine itself, which leads to Machines.
  await mobileAction(page, 'mobile-settings');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-connection]')`);
  await page.click('[data-testid=mobile-settings-connection]');
  // Machines lists what the agents still offer, and Update starts them from there.
  await page.waitFor(`[...document.querySelectorAll('[data-testid=updates-other]')].map(row => row.dataset.part).sort().join() === 'claude,codex'`);
  expect(await page.evaluate(`document.querySelector('[data-testid=updates-run-all]').disabled`)).toBe(false);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.harnessUpdates.filter(update => update.pending).length`)).toBe(2);
}, 20_000);

test('an unavailable onboarding chunk keeps agent updates accessible in Machines', async () => {
  // Compile the lazy Settings styles before the isolated browser tests the
  // missing tour chunk. Cold Vite transforms are not application startup.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (!await page.evaluate(`!!document.querySelector('[data-testid=settings]')`)) await page.click('[data-testid=nav-settings]');
  await page.waitFor(`document.querySelector('[data-testid=settings]')`, 30_000);
  const offline = await BrowserPage.launch({ url: 'about:blank', showTour: true });
  try {
    await offline.send('Network.enable', {});
    await offline.send('Network.setBlockedURLs', { urls: ['*Onboarding.svelte*'] });
    const origin = await page.evaluate<string>('location.origin');
    await offline.navigate(`${origin}/?fake=1&updates=1`);
    await offline.waitFor(`document.querySelector('[data-testid=nav-settings]')`);
    expect(await offline.evaluate(`document.querySelector('[data-testid=onboarding]') === null`)).toBe(true);
    expect(await offline.evaluate(`document.querySelector('[data-testid=harness-update-notices]') === null`)).toBe(true);
    // The tour that could not load still holds the update card back.
    expect(await offline.evaluate(`document.querySelector('[data-testid=updates-card]') === null`)).toBe(true);
    await offline.click('[data-testid=nav-settings]');
    await offline.waitFor(`document.querySelector('[data-testid=settings-tab-machines]')`);
    await offline.click('[data-testid=settings-tab-machines]');
    await offline.waitFor(`document.querySelector('[data-testid=machines-page]') && [...document.querySelectorAll('[data-testid=updates-other]')].map(row => row.dataset.part).sort().join() === 'claude,codex'`);
    // Each agent's own Update is on Providers.
    await offline.click('[data-testid=settings-tab-accounts]');
    await offline.waitFor(`document.querySelectorAll('[data-testid=harness-updates-card] [data-testid=harness-update-row-run]').length === 2`);
  } finally {
    await offline.close();
  }
}, 60_000);

test('a phone gets two screens: the welcome and what the computer does, no host setting', async () => {
  const origin = await page.evaluate<string>('location.origin');
  for (const locale of ['en', 'fr']) {
    // A first-run phone owns a fresh profile and history, independent of the desktop Settings scenarios.
    const phone = await BrowserPage.launch({ url: 'about:blank', showTour: true, windowSize: { width: 390, height: 844 } });
    try {
      await phone.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('boite.locale', '${locale}')` });
      await phone.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await phone.navigate(`${origin}/?fake=1`);
      await phone.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === 'welcome' && (history.state?.boiteDepth ?? 0) > 0`);
      const historyDepth = await phone.evaluate<number>('history.state.boiteDepth');
      expect(await phone.evaluate<string[]>(`[...document.querySelectorAll('[data-testid=onboarding] .dot')].map(dot => dot.dataset.testid)`)).toEqual(['onboarding-dot-welcome', 'onboarding-dot-reach']);
      await capture(`tour-phone-${locale}-welcome.png`, phone);
      await phone.click('[data-testid=onboarding-next]');
      await phone.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === 'reach'`);
      expect(await phone.evaluate(`document.querySelector('#onboarding-title').textContent`)).toBe(locale === 'en' ? 'Your computer does the work' : 'Votre ordinateur fait le travail');
      expect(await phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      expect(await phone.evaluate(`document.querySelector('[data-testid=onboarding-next]').getBoundingClientRect().bottom <= innerHeight`)).toBe(true);
      await capture(`tour-phone-${locale}-reach.png`, phone);
      // The second screen is the last: its button closes the tour, and the device remembers.
      await phone.click('[data-testid=onboarding-next]');
      await phone.waitFor(`!document.querySelector('[data-testid=onboarding]') && (history.state?.boiteDepth ?? 0) < ${historyDepth}`);
      expect(await phone.evaluate<number>(`JSON.parse(localStorage.getItem('boite.onboarding')).version`)).toBeGreaterThan(0);
    } finally {
      await phone.close();
    }
  }
}, 45_000);
