import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const timeline = '[data-testid=timeline]';
const jump = '[data-testid=jump-to-latest]';
const artifacts = process.env.BOITE_SCROLL_CAPTURES ?? join(import.meta.dir, '.artifacts');

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}

test('sending from history respects reduced motion and preserves the prompt across navigation', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${timeline}')`);
  await settled();
  await page.evaluate(`document.querySelector('${timeline}').scrollTop -= 1500`);
  await page.waitFor(`document.querySelector('${jump}')`);
  await page.evaluate(`window.__boiteTest.workspace.active.send('A prompt sent while reading history')`);
  const aligned = `(() => {
    const box = document.querySelector('${timeline}');
    const prompt = window.__boiteTest.workspace.active.openThread.messages.findLast(message => message.role === 'user');
    const row = box?.querySelector('[data-mid="' + prompt.id + '"]');
    const inset = Math.min(96, Math.max(48, box.clientHeight * 0.12));
    return !!row && Math.abs(row.getBoundingClientRect().top - box.getBoundingClientRect().top - inset) < 2;
  })()`;
  await page.waitFor(`${aligned} && window.__boiteTest.workspace.active.openThread.status === 'idle'`).catch(async error => {
    console.error(await page.evaluate(`(() => { const box = document.querySelector('${timeline}'); return { top: box.scrollTop, height: box.clientHeight, total: box.scrollHeight, room: document.querySelector('[data-testid=prompt-room]')?.getBoundingClientRect().height, rows: [...box.querySelectorAll('[data-mid]')].map(row => ({id: row.dataset.mid, top: row.getBoundingClientRect().top - box.getBoundingClientRect().top, height: row.getBoundingClientRect().height})), focus: window.__boiteTest.workspace.active.promptFocus }; })()`));
    await page.screenshot(join(artifacts, 'prompt-reduced-failure.png'));
    throw error;
  });
  await page.waitFor(`${aligned} && document.querySelector('[data-testid=prompt-room]')`);
  await page.evaluate(`window.__boiteTest.workspace.active.open('t-trace')`);
  await page.evaluate(`window.__boiteTest.workspace.active.open('t-long')`);
  await page.waitFor(aligned);
  await page.waitFor(`document.querySelector('[data-testid=prompt-room]')`);
  expect(await page.evaluate(`document.querySelector('${jump}') === null`)).toBe(true);
  await page.screenshot(join(artifacts, 'prompt-reduced-phone.png'));
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
}, 30_000);

test('reader input cancels the lift and input from another client preserves the reading position', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${timeline}')`);
  await settled();
  await page.evaluate(`(async () => {
    const box = document.querySelector('${timeline}');
    const store = window.__boiteTest.workspace.active;
    box.scrollTop -= 1000;
    await store.send('A cancellable lift [permission]');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
    box.scrollTop -= 300;
  })()`);
  await page.waitFor(`document.querySelector('${jump}')`);
  const position = await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`);
  // Wait several frames past the CSS motion duration to detect a surviving tween.
  await page.evaluate(`new Promise(resolve => { const start = performance.now(); const frame = () => performance.now() - start > 350 ? resolve() : requestAnimationFrame(frame); requestAnimationFrame(frame); })`);
  expect(Math.abs(await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`) - position)).toBeLessThan(2);
  await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    await store.stop();
    await store.client.call('turns.start', { threadId: store.openThread.id, prompt: 'Input from another client [permission]' });
  })()`);
  await page.waitFor(`window.__boiteTest.workspace.active.openThread.messages.some(message => message.role === 'user' && message.parts[0].text.includes('another client'))`);
  await settled();
  expect(Math.abs(await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`) - position)).toBeLessThan(2);
}, 30_000);

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent&long=1`;
  page = await BrowserPage.launch({ url });
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

for (const phone of [false, true]) {
  const name = phone ? 'phone' : 'desktop';
  for (const history of ['empty', 'short', 'windowed']) {
    test(`a sent prompt rises smoothly and its response takes the reserved space on ${name}, ${history} history`, async () => {
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile: phone });
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await page.navigate(history === 'windowed' ? url : url.replace('&long=1', ''));
      await page.waitFor(`document.querySelector('${timeline}')`);
      if (history === 'empty') await page.evaluate(`(async () => {
        const store = window.__boiteTest.workspace.active;
        const account = store.accountsOf('echo')[0];
        await store.createThread({ projectId: store.projects[0].id, providerId: 'echo', accountId: account.id, title: 'A fresh conversation' });
      })()`);
      await settled();
      await page.type('[data-testid=composer-input]', 'Start a fresh view [permission]');
      // Observe real frames from the send button through the end of the lift.
      const positions = await page.evaluate<number[]>(`new Promise(resolve => {
        const box = document.querySelector('${timeline}');
        const positions = []; const started = performance.now();
        document.querySelector('[data-testid=composer-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const sample = () => {
          positions.push(box.scrollTop);
          if (performance.now() - started < 600) requestAnimationFrame(sample);
          else resolve(positions);
        }; requestAnimationFrame(sample);
      })`);
      const offset = `(() => {
        const box = document.querySelector('${timeline}');
        const store = window.__boiteTest.workspace.active;
        const prompt = store.openThread.messages.findLast(message => message.role === 'user');
        const row = box.querySelector('[data-mid="' + prompt.id + '"]');
        const inset = Math.min(96, Math.max(48, box.clientHeight * 0.12));
        return row ? Math.abs(row.getBoundingClientRect().top - box.getBoundingClientRect().top - inset) : Infinity;
      })()`;
      await page.waitFor(`${offset} < 2 && document.querySelector('[data-testid=permission-card]')`);
      expect(await page.evaluate<number>(offset)).toBeLessThan(2);
      if (history !== 'empty') expect(await page.evaluate(`document.querySelector('[data-testid=message-marker][aria-current=location]')?.dataset.messageId === window.__boiteTest.workspace.active.openThread.messages.findLast(message => message.role === 'user').id`)).toBe(true);
      if (history !== 'empty') expect(new Set(positions.map(position => Math.round(position))).size).toBeGreaterThan(3);
      expect(await page.evaluate(`document.querySelector('${jump}') === null`)).toBe(true);
      await page.screenshot(join(artifacts, `prompt-top-${name}-${history}.png`));

      await page.evaluate(`(() => {
        const message = window.__boiteTest.workspace.active.openThread.messages.findLast(message => message.role === 'assistant');
        message.parts = [{ type: 'text', text: 'Here is the first part of the answer.\\n\\n' }];
      })()`);
      await page.waitFor(`${offset} < 2 && document.querySelector('[data-testid=prompt-room]')`);
      // Keep the prompt inset and answer reserve in sync when the viewport changes.
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: phone ? 480 : 1300, deviceScaleFactor: 1, mobile: phone });
      await page.waitFor(`${offset} < 2 && document.querySelector('[data-testid=prompt-room]')`);
      await page.screenshot(join(artifacts, `prompt-resized-${name}-${history}.png`));
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile: phone });
      await page.waitFor(`${offset} < 2 && document.querySelector('[data-testid=prompt-room]')`);
      await page.evaluate(`(() => {
        const message = window.__boiteTest.workspace.active.openThread.messages.findLast(message => message.role === 'assistant');
        message.parts[0].text = Array.from({length: 60}, (_, i) => 'Response paragraph ' + i + ': the answer fills the available screen.').join('\\n\\n') + '\\n\\n';
      })()`);
      await page.waitFor(`!document.querySelector('[data-testid=prompt-room]') && (() => { const box = document.querySelector('${timeline}'); return box.scrollHeight - box.clientHeight - box.scrollTop < 2; })()`).catch(async error => {
        console.error(await page.evaluate(`(() => { const box = document.querySelector('${timeline}'); return { top: box.scrollTop, height: box.clientHeight, total: box.scrollHeight, room: document.querySelector('[data-testid=prompt-room]')?.getBoundingClientRect().height, rows: [...box.querySelectorAll('[data-mid]')].map(row => ({id: row.dataset.mid, height: row.getBoundingClientRect().height})), jump: !!document.querySelector('${jump}') }; })()`));
        await page.screenshot(join(artifacts, `prompt-failure-${name}.png`));
        throw error;
      });

      // Wheel input releases following; further response growth must preserve reading.
      await page.evaluate(`(() => {
        const box = document.querySelector('${timeline}');
        box.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
        box.scrollTop -= 300;
      })()`);
      await page.waitFor(`document.querySelector('${jump}')`);
      const reading = await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`);
      await page.evaluate(`window.__boiteTest.workspace.active.openThread.messages.findLast(message => message.role === 'assistant').parts[0].text += 'More response content.\\n\\n'.repeat(10)`);
      await settled();
      expect(Math.abs(await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`) - reading)).toBeLessThan(2);
      await page.click(jump);
      await page.waitFor(`!document.querySelector('${jump}') && (() => { const box = document.querySelector('${timeline}'); return box.scrollHeight - box.clientHeight - box.scrollTop < 2; })()`);
      await page.screenshot(join(artifacts, `prompt-response-${name}-${history}.png`));
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      expect(page.errors()).toEqual([]);
    }, 30_000);
  }

  test(`the return button stays centered throughout its entrance on ${name}`, async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile: phone });
    await page.navigate(url);
    await page.waitFor(`document.querySelector('${timeline}')`);
    await settled();
    await page.evaluate(`document.querySelector('${timeline}').scrollTop = 0`);
    await page.waitFor(`document.querySelector('${jump}')`);
    const offsets = await page.evaluate<number[]>(`(() => {
      const button = document.querySelector('${jump}');
      const parent = button.parentElement.getBoundingClientRect();
      // Restart the real CSS entrance even if it finished during the CDP round trip.
      button.style.animation = 'none';
      void button.offsetWidth;
      button.style.removeProperty('animation');
      const animations = button.getAnimations();
      if (animations.length === 0) throw new Error('The return button entrance animation is missing');
      animations.forEach(a => a.pause());
      return [0, 0.5, 1].map(progress => {
        animations.forEach(a => a.currentTime = Number(a.effect.getTiming().duration) * progress);
        const r = button.getBoundingClientRect();
        return Math.abs(r.left + r.width / 2 - parent.left - parent.width / 2);
      });
    })()`);
    await page.evaluate(`document.querySelector('${jump}').getAnimations().forEach(a => a.currentTime = Number(a.effect.getTiming().duration) / 2)`);
    await page.screenshot(join(artifacts, `jump-entrance-${name}.png`));
    expect(Math.max(...offsets)).toBeLessThan(1);
    await page.evaluate(`document.querySelector('${jump}').getAnimations().forEach(a => a.finish())`);
    await settled();
    await page.click(jump);
    await page.waitFor(`!document.querySelector('${jump}') && (() => { const t = document.querySelector('${timeline}'); return t.scrollHeight - t.clientHeight - t.scrollTop < 2; })()`);
  }, 30_000);

  test(`the return button stays above expanded activity and accepts a pointer on ${name}`, async () => {
    await page.navigate(url);
    await page.waitFor(`document.querySelector('${timeline}')`);
    await settled();
    await page.evaluate(`(() => {
      const store = window.__boiteTest.workspace.active;
      store.openThread.activity = { goal: null, loop: null, tasks: Array.from({length: 8}, (_, i) => ({id: 'task-' + i, text: 'Inspect conversation interaction ' + i, status: i === 0 ? 'in_progress' : 'pending'})) };
      document.querySelector('${timeline}').scrollTop = 0;
    })()`);
    await page.waitFor(`document.querySelector('${jump}') && document.querySelector('[data-testid=activity-tasks-toggle]')`);
    await page.click('[data-testid=activity-tasks-toggle]');
    await settled();
    await page.screenshot(join(artifacts, `jump-activity-${name}.png`));
    const position = await page.evaluate<{ clear: boolean; reachable: boolean; x: number; y: number }>(`(() => {
      const button = document.querySelector('${jump}');
      const r = button.getBoundingClientRect();
      const dock = document.querySelector('[data-testid=thread-activity]').getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { clear: r.bottom <= dock.top, reachable: button.contains(document.elementFromPoint(x, y)), x, y };
    })()`);
    expect(position.clear).toBe(true);
    expect(position.reachable).toBe(true);
    if (phone) expect(await page.evaluate(`document.querySelector('${jump}').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: position.x, y: position.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: position.x, y: position.y });
    await page.waitFor(`!document.querySelector('${jump}')`);
    await settled();
    await page.screenshot(join(artifacts, `jump-latest-${name}.png`));
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  }, 30_000);
}

test('a pinned conversation follows its answer on every frame, and a wheel turned up leaves it', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url.replace('&long=1', '&stream=tokens'));
  await page.waitFor('window.__boiteTest?.workspace.active.booted');
  // The recent thread already runs a turn; the trace thread is at rest and answers at once.
  await page.evaluate(`window.__boiteTest.workspace.active.open('t-trace')`);
  await page.waitFor(`document.querySelector('[data-testid=composer-input]') && document.querySelector('${timeline}') && !window.__boiteTest.workspace.active.busy`);
  await settled();
  // The fake agent reasons over the prompt, then echoes it back sixteen characters a delta.
  // A streaming answer shows whole paragraphs, so the echo is made of short ones.
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid=composer-input]');
    input.value = 'A paragraph long enough to wrap across the conversation column, sent back word for word.\\n\\n'.repeat(48);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.click('[data-testid=composer-send]');
  await page.waitFor(`document.querySelectorAll('${timeline} .prose.live .paragraph').length >= 2`, 30_000);
  // Read after each layout, once the list's own observer has run: the distance from the bottom the frame paints.
  const gaps = await page.evaluate<number[]>(`new Promise((done) => {
    const box = document.querySelector('${timeline}');
    const gaps = [];
    const watch = new ResizeObserver(() => gaps.push(box.scrollHeight - box.clientHeight - box.scrollTop));
    watch.observe(document.querySelector('${timeline} .prose.live'));
    setTimeout(() => { watch.disconnect(); done(gaps); }, 1000);
  })`);
  expect(gaps.length).toBeGreaterThan(5);
  // Before, the list caught up ten times a second and painted the new lines below the fold in between.
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1);

  // A small keyboard step leaves following too, before reaching its 80 px tolerance.
  await page.evaluate(`(() => { const box = document.querySelector('${timeline}'); box.tabIndex = -1; box.focus({ preventScroll: true }); })()`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await page.waitFor(`document.querySelector('${jump}')`);
  await page.evaluate('new Promise((done) => setTimeout(done, 300))');
  const keyed = await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`);
  await page.evaluate('new Promise((done) => setTimeout(done, 400))');
  await page.screenshot(join(import.meta.dir, '.artifacts', 'chat-scroll-keyboard.png'));
  expect(Math.abs((await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`)) - keyed)).toBeLessThanOrEqual(1);
  await page.click(jump);
  await page.waitFor(`!document.querySelector('${jump}') && (() => { const t = document.querySelector('${timeline}'); return t.scrollHeight - t.clientHeight - t.scrollTop < 2; })()`);

  const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${timeline}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
  await page.waitFor(`document.querySelector('${jump}')`);
  await page.evaluate('new Promise((done) => setTimeout(done, 300))');
  expect(await page.evaluate<boolean>(`!!document.querySelector('${timeline} .prose.live')`)).toBe(true);
  const left = await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`);
  await page.evaluate('new Promise((done) => setTimeout(done, 400))');
  // The answer keeps growing below; the text being read stays where the wheel put it.
  expect(Math.abs((await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`)) - left)).toBeLessThanOrEqual(1);
  await page.click(jump);
  await page.waitFor(`!document.querySelector('${jump}') && (() => { const t = document.querySelector('${timeline}'); return t.scrollHeight - t.clientHeight - t.scrollTop < 2; })()`);
}, 45_000);
