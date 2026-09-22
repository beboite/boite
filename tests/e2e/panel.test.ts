import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp';

const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: Awaited<ReturnType<typeof createServer>>;
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

/** Something on the store of the open page, the way the other e2e files reach it. */
async function onStore(code: string) {
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({ store }) => { ${code} })`);
}

async function phone(on: boolean) {
  await page.send('Emulation.setDeviceMetricsOverride', on
    ? { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }
    : { width: 1310, height: 820, deviceScaleFactor: 1, mobile: false });
}

beforeAll(async () => {
  const port = await freePort();
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&long=1`, windowSize: { width: 1310, height: 820 } });
  await page.waitFor(`document.querySelector('${id('timeline')}')`);
  await onStore(`await store.open('t-trace');`);
  await page.waitFor(`document.querySelector('${id('panel-toggle')}')`);
  // A cold vite and a cold Chromium on a loaded runner: the budget readability.test.ts gives the same start.
}, 90_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the panel opens on its launcher, and the workbench surfaces fit both widths', async () => {
  // The layout is remembered per thread: this run starts on an empty strip.
  await onStore(`store.panel.closeAll();`);
  await page.click(id('panel-toggle'));
  await page.waitFor(`document.querySelector('${id('panel-launcher')}')`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('panel-launcher')} .card')).map(card => card.dataset.testid)`)).toEqual([
    'launch-agents',
    'launch-browser',
    'launch-changes',
    'launch-files',
    'launch-tasks',
    'launch-trace'
  ]);
  // A page needs the shell's webview, so the browser card is the one refused here.
  expect(await page.evaluate(`document.querySelector('${id('launch-browser')}').disabled`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('launch-changes')}').disabled`)).toBe(false);
  await capture('panel-launcher.png');

  await page.click(id('launch-changes'));
  await page.waitFor(`document.querySelectorAll('${id('changes-row')}').length === 7`);
  await page.click(`${id('changes-row')}[data-path="src/components/RightPanel.svelte"]`);
  await page.waitFor(`document.querySelector('${id('diff-view')}')`);
  expect(await page.evaluate(`document.querySelector('${id('changes-row')}[data-path="src/components/RightPanel.svelte"]').getAttribute('aria-selected')`)).toBe('true');
  await capture('changes-desktop.png');
  expect(await page.evaluate(`(() => { const panel = document.querySelector('${id('changes-panel')}'); return panel.scrollWidth <= panel.clientWidth; })()`)).toBe(true);
  // The status badges are a colour mixed into the ground, and light is the
  // theme one of them could go light on light in. The screenshot of this
  // harness keeps the frame the palette was dark in, so the proof is the
  // computed colour of each badge against what it sits on.
  await page.evaluate(`import('/src/lib/theme.ts').then(({ setTheme }) => setTheme('light'))`);
  await page.waitFor(`document.documentElement.dataset.theme === 'light'`);
  expect(await page.evaluate(`(() => {
    const ground = getComputedStyle(document.querySelector('${id('changes-panel')}').closest('.panel')).backgroundColor;
    return Array.from(document.querySelectorAll('${id('changes-row')} .mark')).map((mark) => {
      const style = getComputedStyle(mark);
      return style.color === ground || style.color === style.backgroundColor ? mark.textContent.trim() : null;
    }).filter(Boolean);
  })()`)).toEqual([]);
  await page.evaluate(`import('/src/lib/theme.ts').then(({ setTheme }) => setTheme('dark'))`);
  await page.waitFor(`document.documentElement.dataset.theme === undefined`);

  // The agent's list is what a running turn writes; the project's cards are seeded.
  await onStore(`store.openThread.activity = { goal: { objective: 'Give every thread its workbench', status: 'active', iterations: 2, error: null }, loop: null, tasks: [
    { id: 'read-contract', text: 'Read the panel contract', status: 'completed' },
    { id: 'draw-changes', text: 'Draw the changes surface', status: 'in_progress' },
    { id: 'wire-tree', text: 'Wire the file tree', status: 'pending' }
  ] };`);
  await page.click(id('panel-add'));
  await page.waitFor(`document.querySelector('${id('panel-add-menu')}')`);
  await page.click(`${id('panel-add-menu')} [data-value=tasks]`);
  await page.waitFor(`document.querySelectorAll('${id('todo-row')}').length === 3`);
  await page.waitFor(`document.querySelectorAll('${id('agent-task')}').length === 3`);
  expect(await page.evaluate(`document.querySelectorAll('${id('panel-tab')}').length`)).toBe(2);
  // Closing preserves the body during its transition and removes its controls
  // from keyboard navigation immediately; reopening keeps the draft intact.
  await page.type(id('todo-input'), 'Keep this draft while folded');
  await page.click(id('tasks-section-todos'));
  expect(await page.evaluate(`document.querySelector('${id('todo-input')}').closest('[inert]') !== null`)).toBe(true);
  await page.waitFor(`document.querySelector('${id('todo-input')}').closest('[inert]').getBoundingClientRect().height < 1`);
  await page.click(id('tasks-section-todos'));
  await page.waitFor(`!document.querySelector('${id('todo-input')}').closest('[inert]')`);
  expect(await page.evaluate(`document.querySelector('${id('todo-input')}').value`)).toBe('Keep this draft while folded');
  await page.type(id('todo-input'), '');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click(id('tasks-section-todos'));
  await page.waitFor(`document.querySelector('${id('todo-input')}').closest('[inert]').getBoundingClientRect().height < 1`);
  expect(await page.evaluate(`parseFloat(getComputedStyle(document.querySelector('${id('todo-input')}').closest('[inert]')).transitionDuration) < 0.001`)).toBe(true);
  await page.click(id('tasks-section-todos'));
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  await capture('tasks-desktop.png');

  await phone(true);
  await page.waitFor(`document.querySelector('${id('tasks-panel')}')`);
  await capture('tasks-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('todo-row')} button')).every(button => getComputedStyle(button).opacity === '1' && button.getBoundingClientRect().height >= 44)`)).toBe(true);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('todo-row')} .text')).every(text => getComputedStyle(text).whiteSpace !== 'nowrap')`)).toBe(true);

  await page.click(`${id('panel-tab')}[data-kind=changes]`);
  await page.waitFor(`document.querySelector('${id('changes-panel')}')`);
  await capture('changes-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  // A sheet over the chat, not a column beside it, and still no row cut off.
  expect(await page.evaluate(`(() => { const rows = Array.from(document.querySelectorAll('${id('changes-row')}')); const list = rows[0].parentElement.getBoundingClientRect(); return rows.every(row => row.getBoundingClientRect().right <= list.right + 1); })()`)).toBe(true);

  await phone(false);
  await page.click(id('panel-toggle'));
  await page.waitFor(`document.querySelector('${id('panel-toggle')}').getAttribute('aria-pressed') === 'false'`);
}, 60_000);

/** The middle of an element, in the page's own pixels, for a real pointer. */
async function middleOf(selector: string): Promise<{ x: number; y: number }> {
  return await page.evaluate<{ x: number; y: number }>(`(() => { const box = document.querySelector('${selector}').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
}

async function zoomPercent(): Promise<number> {
  return Number.parseInt(await page.text(id('file-zoom')), 10);
}

test('the tree opens on a directory, the editor lands on a line, and a picture zooms under a real pointer', async () => {
  await onStore(`store.panel.closeAll(); store.panel.openFiles('docs/guide');`);
  await page.waitFor(`document.querySelector('${id('files-row')}[data-path="docs/guide/editor.md"]')`);
  expect(await page.evaluate(`document.querySelector('${id('files-row')}[data-path="docs"]').getAttribute('aria-expanded')`)).toBe('true');
  await capture('files-desktop.png');

  // A click on a file is a tab of its own; the agent's `show file:line` is the same tab at a line.
  await page.click(`${id('files-row')}[data-path="docs/guide/editor.md"]`);
  await page.waitFor(`document.querySelector('${id('file-text')}')?.value.includes('# The editor')`);
  await onStore(`store.panel.openFile('src/lib/store.svelte.ts', 64);`);
  await page.waitFor(`document.querySelector('${id('file-highlight')}')?.dataset.line === '64'`);
  // The band and the number of the same line sit on the same pixels, or the gutter lies.
  expect(await page.evaluate(`(() => {
    const band = document.querySelector('${id('file-highlight')}').getBoundingClientRect();
    const number = document.querySelector('${id('file-line')}[data-line="64"]').getBoundingClientRect();
    const view = document.querySelector('${id('file-editor')}').getBoundingClientRect();
    // Line 64 is below the first screen, so the editor scrolled to show it.
    return Math.abs(band.top - number.top) < 1.5 && band.top > view.top && band.bottom < view.bottom && document.querySelector('${id('file-text')}').scrollTop > 0;
  })()`)).toBe(true);
  await capture('file-text-desktop.png');

  await onStore(`store.panel.openFile('assets/preview.png');`);
  await page.waitFor(`document.querySelector('${id('file-natural')}')?.textContent.includes('640 x 400')`);
  const fitted = await zoomPercent();
  // Fitted means the whole picture is inside the surface.
  expect(await page.evaluate(`(() => {
    const view = document.querySelector('${id('file-viewport')}').getBoundingClientRect();
    const picture = document.querySelector('${id('file-image')}').getBoundingClientRect();
    return picture.left >= view.left - 1 && picture.right <= view.right + 1 && picture.top >= view.top - 1 && picture.bottom <= view.bottom + 1;
  })()`)).toBe(true);
  await capture('file-image-desktop.png');

  // The wheel zooms around the pointer: the pixel under it stays under it.
  const view = await middleOf(id('file-viewport'));
  const at = { x: view.x - 60, y: view.y - 40 };
  const under = `(() => { const box = document.querySelector('${id('file-image')}').getBoundingClientRect(); return { u: (${at.x} - box.left) / box.width, v: (${at.y} - box.top) / box.height }; })()`;
  const before = await page.evaluate<{ u: number; v: number }>(under);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -1200 });
  await page.waitFor(`Number.parseInt(document.querySelector('${id('file-zoom')}').textContent, 10) > ${fitted * 2}`);
  const after = await page.evaluate<{ u: number; v: number }>(under);
  expect(Math.abs(after.u - before.u)).toBeLessThan(0.01);
  expect(Math.abs(after.v - before.v)).toBeLessThan(0.01);

  // A drag pans by what the pointer moved.
  const edge = await page.evaluate<number>(`document.querySelector('${id('file-image')}').getBoundingClientRect().left`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: view.x, y: view.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: view.x + 50, y: view.y + 30, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: view.x + 50, y: view.y + 30, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitFor(`Math.abs(document.querySelector('${id('file-image')}').getBoundingClientRect().left - ${edge} - 50) < 1.5`);
  await capture('file-image-zoomed.png');

  await page.click(id('file-actual'));
  await page.waitFor(`document.querySelector('${id('file-zoom')}').textContent === '100%'`);
  await page.click(id('file-fit'));
  await page.waitFor(`document.querySelector('${id('file-zoom')}').textContent === '${fitted}%'`);

  // A sound is the native player, and it has read the file: it knows how long it is.
  await onStore(`store.panel.openFile('assets/chime.wav');`);
  await page.waitFor(`document.querySelector('${id('file-audio')}')?.duration > 0`);
  // What is neither text nor media is a name, a size and a link.
  await onStore(`store.panel.openFile('assets/handbook.pdf');`);
  await page.waitFor(`document.querySelector('${id('file-download')}')?.getAttribute('download') === 'handbook.pdf'`);

  await phone(true);
  await page.click(`${id('panel-tab')}[data-surface-id="file:src/lib/store.svelte.ts"]`);
  await page.waitFor(`document.querySelector('${id('file-text')}')`);
  await capture('file-text-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await phone(false);
  await onStore(`store.panel.closeAll();`);
}, 60_000);

test('an unsaved edit survives a tab switch and its tab asks before closing, at both widths', async () => {
  await onStore(`store.panel.closeAll(); store.panel.openFile('README.md');`);
  await page.waitFor(`document.querySelector('${id('file-text')}')?.value.includes('# boite')`);
  await page.evaluate(`(() => { const area = document.querySelector('${id('file-text')}'); area.value += 'An edit nobody saved.\\n'; area.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.waitFor(`document.querySelector('${id('file-dirty')}')`);
  await onStore(`store.panel.openTasks();`);
  await page.waitFor(`document.querySelector('${id('tasks-panel')}')`);
  await page.click(`${id('panel-tab')}[data-surface-id="file:README.md"]`);
  await page.waitFor(`document.querySelector('${id('file-text')}')?.value.includes('An edit nobody saved.')`);

  const closer = `${id('panel-tab')}[data-surface-id="file:README.md"] ${id('panel-tab-close')}`;
  for (const width of ['desktop', 'phone'] as const) {
    await phone(width === 'phone');
    await page.click(closer);
    await page.waitFor(`document.querySelector('${id('confirm-dialog')}')`);
    await capture(`file-discard-${width}.png`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.click(id('confirm-cancel'));
    await page.waitFor(`!document.querySelector('${id('confirm-dialog')}')`);
  }
  expect(await page.evaluate(`document.querySelector('${id('file-text')}').value.includes('An edit nobody saved.')`)).toBe(true);
  await page.click(closer);
  await page.waitFor(`document.querySelector('${id('confirm-dialog')}')`);
  await page.click(id('confirm-ok'));
  await page.waitFor(`!document.querySelector('${id('panel-tab')}[data-surface-id="file:README.md"]')`);
  await phone(false);
  await onStore(`store.panel.closeAll();`);
}, 60_000);
