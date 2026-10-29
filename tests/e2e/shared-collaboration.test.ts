import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: {close(): Promise<void>};
let url: string;
const id = (value: string) => `[data-testid="${value}"]`;
async function capture(page: BrowserPage, name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
async function captureFrench(page: BrowserPage, name: string) {
  await page.evaluate(`window.__boiteTest.setLocaleSetting('fr')`);
  await page.waitFor(`document.documentElement.lang === 'fr'`);
  await capture(page, name);
  await page.evaluate(`window.__boiteTest.setLocaleSetting('en')`);
  await page.waitFor(`document.documentElement.lang === 'en'`);
}
beforeAll(async () => { const port = await freePort(); url = `http://127.0.0.1:${port}`; server = await startDevUi(port); }, 60_000);
afterAll(async () => { await server?.close(); }, 30_000);

// Explicit two-core in-memory transport. Real sealing/network/provider boundaries
// are exercised by the core E2E fixtures, never by a browser's fake-client setup.
const prepare = `(async () => {
  const [{sharedFlow}, {workspace}, {setExperiment}] = await Promise.all([
    import('/src/test/shared-flow.ts'), import('/src/lib/workspace.svelte.ts'), import('/src/lib/experiments.ts')]);
  setExperiment('contacts', true);
  const pair = await sharedFlow(); window.__sharedFlow = pair;
  const store = workspace.active;
  store.detach(); store.attach(pair.a); await store.connect(); await store.open(pair.local.id);
  workspace.setView('projects'); store.collapsedProjects = []; store.sidebarOpen = true;
  await pair.a.call('sharedProjects.configure', {sharedProjectId: pair.as.sharedProjectId, board: true});
  await pair.b.call('sharedProjects.configure', {sharedProjectId: pair.bs.sharedProjectId, board: true});
  window.__boiteTest.setTheme('dark');
})()`;

for (const width of [1440, 390]) test(`shared project messages, board ownership and compute consent/results/revoke at ${width}px`, async () => {
  const page = await BrowserPage.launch({url: `${url}/?fake=1&open=recent`, windowSize: {width, height: width === 390 ? 844 : 900}});
  try {
    await page.waitFor(`window.__boiteTest?.workspace.active.connection === 'ready'`);
    await page.evaluate(prepare, 60_000);
    await page.waitFor(`document.querySelectorAll('${id('shared-thread')}').length > 1`, 30_000);
    expect(await page.text(id('shared-local-person'))).toContain('You');
    expect(await page.text(id('shared-project-people'))).toContain('Pat');
    const privateTitles = await page.evaluate<string[]>(`(async () => {const pair = window.__sharedFlow; return (await pair.b.call('threads.list', {})).filter(t => t.projectId !== pair.bp.id).map(t => t.title);})()`);
    const directory = await page.text(id('shared-project-people'));
    for (const title of privateTitles) expect(directory).not.toContain(title);
    await capture(page, `shared-project-${width}.png`);
    expect(await page.evaluate(`(() => {const box = document.querySelector('${id('shared-project-people')}').getBoundingClientRect();return box.left >= 0 && box.right <= innerWidth;})()`)).toBe(true);

    // A foreign ID opens a scoped dialog, leaving the local thread selected.
    const localBefore = await page.evaluate<string>('window.__boiteTest.workspace.active.openThread.id');
    await page.click(id('shared-thread-write'));
    await page.waitFor(`document.querySelector('${id('shared-no-read')}')`);
    expect(await page.evaluate('window.__boiteTest.workspace.active.openThread.id')).toBe(localBefore);
    await page.type(id('shared-human-message'), 'Please check this shared release.');
    await page.click(id('shared-human-send'));
    await page.waitFor(`document.querySelector('${id('shared-human-status')}')`);
    expect(await page.text(id('shared-thread-dialog'))).toContain('It grants no owner approval');
    expect(await page.evaluate(`(async () => {const pair = window.__sharedFlow;const views = await Promise.all((await pair.b.call('threads.list', {projectId: pair.bp.id})).map(t => pair.b.call('collaboration.get', {threadId: t.id}))); return views.flatMap(v => v.messages).find(m => m.text === 'Please check this shared release.')?.origin;})()`)).toBe('contact-human');
    await capture(page, `shared-human-${width}.png`);
    await page.click(id('shared-dialog-close'));

    await page.click(id('shared-open-board'));
    await page.waitFor(`document.querySelector('${id('project-board')}')`);
    await page.click(id('board-add'));
    await page.type(id('board-add-input'), 'Verify the shared release');
    await page.evaluate(`document.querySelector('${id('board-add-input')}').closest('form').requestSubmit()`);
    await page.waitFor(`document.querySelector('${id('board-card')}')`);
    await page.click(id('board-card-menu')); await page.click('[data-value="move:doing"]');
    await page.waitFor(`document.querySelector('${id('board-card-progress')}')`, 15_000);
    expect(await page.text(id('board-card-agent'))).toContain('You');
    expect(await page.text(id('board-card-agent'))).toContain('echo');
    expect(await page.evaluate(`(async () => {const pair = window.__sharedFlow;const board = await pair.b.call('sharedBoard.get', pair.bs);return board.cards[0]?.assignment.worker.project.coreId === pair.aid;})()`)).toBe(true);
    await page.click(id('board-card-text'));
    await page.waitFor(`document.querySelector('${id('goal-checklist-item')}')`);
    await page.waitFor(`document.querySelector('[data-column=review] ${id('board-card')}')`);
    if (width === 390) await page.click('[data-testid=board-page]:nth-child(3)');
    await page.waitFor(`(() => {const box = document.querySelector('${id('board-card')}').getBoundingClientRect();return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;})()`);
    if (width === 390) expect(await page.evaluate(`document.querySelector('${id('board-card')}').draggable`)).toBe(false);
    await capture(page, `shared-board-${width}.png`);
    expect(await page.evaluate(`(() => {const box = document.querySelector('${id('board-card')}').getBoundingClientRect();return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;})()`)).toBe(true);
    await page.click(id('board-card-menu')); await page.click('[data-value="move:done"]');
    await page.waitFor(`document.querySelector('[data-column=done] ${id('board-card')}')`);
    await page.click(id('board-hide'));

    // All host configuration stays behind the owner's existing settings surface.
    await page.evaluate(`window.__boiteTest.workspace.active.sidebarOpen = true`);
    await page.click(id('shared-open-settings'));
    await page.waitFor(`document.querySelector('${id('shared-tab-sharing')}')?.getAttribute('aria-selected') === 'true'`);
    expect(await page.evaluate(`document.querySelector('${id('shared-panel-tasks')}').hidden`)).toBe(true);
    expect(await page.evaluate(`(() => {const body = document.querySelector('${id('shared-project-dialog')} .body'); return body.scrollHeight <= body.clientHeight;})()`)).toBe(true);
    await captureFrench(page, `shared-sharing-fr-${width}.png`);
    await page.click(`${id('shared-host-settings')} > summary`);
    await page.click(id('shared-profile-conversation'));
    await page.waitFor(`!document.querySelector('${id('shared-contribution')}').disabled`);
    await page.choose(id('shared-contribution'), '4');
    await page.waitFor(`!document.querySelector('${id('shared-compute-consent')}').disabled`);
    await page.click(id('shared-compute-consent'));
    await page.waitFor(`document.querySelector('${id('shared-compute-consent')}').checked`);
    await page.click(`${id('shared-host-settings')} > summary`);
    await page.click(id('shared-tab-tasks'));
    await page.waitFor(`document.querySelector('${id('shared-compute-start')}')`);
    expect(await page.text(id('shared-host-contribution'))).toContain('5');
    await page.type(id('shared-compute-base'), 'a'.repeat(40));
    await page.type(id('shared-compute-task'), 'Check the shared release');
    await page.waitFor(`!document.querySelector('${id('shared-compute-start')}').disabled`);
    await page.click(id('shared-compute-start'));
    await page.waitFor(`document.querySelector('${id('shared-job')}')`);
    await page.evaluate(`window.__sharedFlow.b.finishSharedCompute(document.querySelector('${id('shared-job')}').dataset.job, 'Release verified on the contact machine.')`);
    await page.click(id('shared-job-follow'));
    await page.waitFor(`document.querySelector('${id('shared-job-detail')}')?.textContent.includes('Release verified')`);
    await page.click(`${id('shared-job-metadata')} > summary`);
    expect(await page.text(id('shared-job-detail'))).toContain('a'.repeat(40));
    await page.click(`${id('shared-job-metadata')} > summary`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await capture(page, `shared-compute-${width}.png`);
    await captureFrench(page, `shared-tasks-fr-${width}.png`);
    await page.click(id('shared-tab-protection'));
    expect(await page.text(id('shared-protection-state'))).toContain('Secret files blocked by default');
    expect(await page.text(id('shared-review-state'))).toContain('Off');
    await capture(page, `shared-protection-${width}.png`);
    await captureFrench(page, `shared-protection-fr-${width}.png`);
    await page.click(id('shared-tab-tasks'));
    await page.click(id('shared-new-task'));
    await page.type(id('shared-compute-task'), 'A second job'); await page.click(id('shared-compute-start'));
    await page.waitFor(`document.querySelector('${id('shared-job-cancel')}')`);
    await page.click(id('shared-job-cancel'));
    await page.waitFor(`document.querySelector('${id('shared-job')}[data-status=cancelled]')`);
    await page.click(id('shared-tab-sharing'));
    await page.click(id('shared-project-revoke'));
    await page.click(id('shared-revoke-confirm'));
    await page.waitFor(`document.querySelector('${id('shared-project-state')}')?.textContent.includes('Access revoked')`);
    expect(await page.evaluate(`document.querySelector('${id('shared-job-detail')}')`)).toBeNull();
    expect(page.errors()).toEqual([]);
  } finally {
    await page.evaluate('window.__sharedFlow?.close()').catch(() => {});
    await page.close();
  }
}, 90_000);
