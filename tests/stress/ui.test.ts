import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from '../e2e/lib/cdp.ts';
import { pairingUrlOf, startCore } from '../e2e/lib/core.ts';
import { ensureProductionUi } from '../e2e/lib/prod-ui.ts';

const artifacts = process.env.BOITE_STRESS_ARTIFACTS ?? join(import.meta.dir, '..', 'e2e', '.artifacts', 'stress');

test('desktop and phone remain usable with 1000 threads and a 256-turn burst', async () => {
  ensureProductionUi();
  const core = await startCore();
  const client = await connect(core.url, core.token, { requestTimeoutMs: 30_000 }).catch(async error => {
    await core.stop();
    throw error;
  });
  let page: BrowserPage | undefined;
  let failed = false;
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    await client.call('settings.set', { maxConcurrentTurns: 64, perAccountConcurrency: 64, asyncQuestions: false });
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Stress workspace' });
    const threads = [];
    for (let i = 0; i < 1_000; i++) threads.push(await client.call('threads.create', {
      projectId: project.id, providerId: 'echo', accountId: account.id, title: `UI stress ${i}`,
    }));
    const boot = performance.now();
    page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1440, height: 1000 } });
    await page.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`, 30_000);
    await page.waitFor(`document.querySelectorAll('[data-testid=thread-row]').length === 1000`, 30_000);
    const bootMs = performance.now() - boot;
    await page.click('[data-testid=thread-row]');
    await page.waitFor(`document.querySelector('[data-testid=thread-title]')?.textContent.trim().startsWith('UI stress ')`);
    await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
    const selectedTitle = await page.text('[data-testid=thread-title]');
    const selected = threads.find(t => selectedTitle.trim() === t.title);
    assert(selected, `selected thread not found: ${JSON.stringify(selectedTitle)}`);
    await page.evaluate(`(() => {
      window.__stressLongTasks = [];
      new PerformanceObserver(list => window.__stressLongTasks.push(...list.getEntries().map(e => e.duration)))
        .observe({ type: 'longtask', buffered: false });
      window.__stressLag = [];
      let previous = performance.now();
      window.__stressTimer = setInterval(() => { const now = performance.now();
        window.__stressLag.push(Math.max(0, now - previous - 100)); previous = now; }, 100);
    })()`);
    const pending = threads.filter(t => t.id !== selected.id).slice(0, 256);
    const finishes = new Set<string>();
    client.on('turn.finished', turn => finishes.add(turn.id));
    const burst = Promise.all(pending.map(t => client.call('turns.start', {
      threadId: t.id, prompt: '[tool] background ' + 'abcdefgh '.repeat(64),
    })));
    // A request may fail while CDP is busy; await the rejection below so teardown still runs.
    void burst.catch(() => undefined);
    console.log('UI stress: burst sent');
    const typed = performance.now();
    await page.type('[data-testid=composer-input]', 'foreground survives load');
    const typingMs = performance.now() - typed;
    await page.waitFor(`!document.querySelector('[data-testid=composer-send]')?.disabled`);
    await page.click('[data-testid=composer-send]');
    await page.waitFor(`Array.from(document.querySelectorAll('[data-testid=message][data-role=assistant] [data-testid=text-part]'))
      .some(n => n.textContent === 'foreground survives load')`, 30_000);
    const foregroundMs = performance.now() - typed;
    console.log(`UI stress: foreground answered in ${foregroundMs.toFixed(0)} ms; ${finishes.size} finishes received`);
    const turns = await burst;
    const end = Date.now() + 60_000;
    while (!turns.every(t => finishes.has(t.id))) {
      if (Date.now() >= end) {
        const scheduler = await client.call('scheduler.get', {});
        const missing = turns.filter(t => !finishes.has(t.id));
        const thread = await client.call('threads.get', { threadId: missing[0]!.threadId });
        assert.fail(JSON.stringify({ finished: finishes.size, missing: missing.length,
          running: scheduler.running.length, queued: scheduler.queued.length, sample: thread.turns }));
      }
      await Bun.sleep(20);
    }
    await page.waitFor(`document.querySelector('[data-testid=composer-send]')`);
    await page.evaluate('document.fonts.ready');
    await page.screenshot(join(artifacts, 'desktop.png'));
    const timing = await page.evaluate<{ longTasks: number[]; timerLag: number[] }>(`(() => {
      clearInterval(window.__stressTimer);
      return { longTasks: window.__stressLongTasks, timerLag: window.__stressLag };
    })()`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.waitFor('window.innerWidth === 390');
    await page.waitFor(`document.querySelector('[data-testid=mobile-tabs]')`);
    await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
    await page.type('[data-testid=composer-input]', 'phone draft survives');
    assert.equal(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`), 'phone draft survives');
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => undefined)))`);
    await page.screenshot(join(artifacts, 'phone.png'));
    assert.equal((await client.call('threads.list', { projectId: project.id })).length, 1000);
    console.log(JSON.stringify({ scenario: 'UI stress', threads: 1000, backgroundTurns: 256, concurrency: 64,
      bootMs, typingMs, foregroundMs, longestTaskMs: Math.max(0, ...timing.longTasks),
      maxTimerLagMs: Math.max(0, ...timing.timerLag), artifacts }));
    assert(typingMs < 5_000, `typing stalled for ${typingMs.toFixed(0)} ms`);
    assert(Math.max(0, ...timing.longTasks) < 5_000, 'browser blocked for over five seconds');
  } catch (error) {
    failed = true;
    console.error('UI stress failed:', error);
    console.log(JSON.stringify({ scheduler: await client.call('scheduler.get', {}).catch(e => String(e)), coreOutput: core.output() }));
    await page?.screenshot(join(artifacts, 'failure.png')).catch(() => undefined);
    if (page) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }).catch(() => undefined);
      await page.waitFor('window.innerWidth === 390').catch(() => undefined);
      await page.screenshot(join(artifacts, 'phone-failure.png')).catch(() => undefined);
    }
    throw error;
  } finally {
    client.close();
    const cleanup = await Promise.allSettled([page?.close(), core.stop()]);
    for (const result of cleanup) if (result.status === 'rejected') {
      if (!failed) throw result.reason;
      console.error('UI stress cleanup failed:', result.reason);
    }
  }
}, 120_000);
