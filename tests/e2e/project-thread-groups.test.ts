import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { mobileAction } from './lib/mobile.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port: number;
const id = (value: string) => `[data-testid="${value}"]`;
beforeAll(async () => { port = await freePort(); server = await startUi(port); }, 60_000);
afterAll(async () => { await server?.close(); });

for (const width of [1280, 390]) {
  test(`project counters fold work and completed history on the owning machine at ${width}px`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`, windowSize: { width, height: width < 720 ? 844 : 900 } });
    try {
      await page.waitFor('globalThis.__boiteTest?.workspace.machines.length === 2');
      const [main, remote, empty, busy] = await page.evaluate<[string, string, string, string]>(`(async () => {
        const [first, second] = globalThis.__boiteTest.workspace.machines;
        // Archive in the background so the finished project has no active draft.
        await first.store.open('t-trace');
        await first.store.archive('t-descriptors', true);
        const empty = await first.store.client.call('projects.add', {path:'/workspace/quiet', name:'quiet'});
        const busy = await first.store.client.call('projects.add', {path:'/workspace/building', name:'building'});
        first.store.threads = first.store.threads.map(t => t.id === 't-scheduler' ? {...t, status:'running', pinned:false, unread:false} : t);
        first.store.threads = [...first.store.threads, {...first.store.threads.find(t => t.id === 't-scheduler'), id:'t-building', projectId:busy.id}];
        return [first.id, second.id, empty.id, busy.id];
      })()`);
      if (width < 720) await mobileAction(page, 'mobile-conversations');
      await page.click(id(width < 720 ? 'mobile-view-projects' : 'view-projects'));
      const root = width < 720 ? id('mobile-list') : id('sidebar');
      const project = (machine: string, projectId: string) => `${root} ${id(width < 720 ? 'mobile-project-group' : 'project')}[data-machine-id="${machine}"][data-project-id="${projectId}"]`;
      const first = project(main, 'p-boite'), second = project(remote, 'p-boite');
      const row = (project: string, thread: string) => `${project} ${width < 720 ? '.row' : id('thread-row')}[data-thread-id="${thread}"]`;
      const click = async (selector: string) => { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); };
      const shot = async (name: string) => {
        await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
        await page.screenshot(join(import.meta.dir, '.artifacts', `project-groups-${name}-${width}.png`));
      };
      await page.waitFor(`document.querySelector('${first}')`);
      expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(project(main, busy))})`)).toBe(true);
      await page.waitFor(`document.querySelectorAll('${root} ${id(width < 720 ? 'mobile-project-group' : 'project')}').length === 4`);
      expect(await page.evaluate(`document.querySelector(${JSON.stringify(project(main, 'p-notes'))}) === null && document.querySelector(${JSON.stringify(project(main, empty))}) === null`)).toBe(true);
      expect(await page.evaluate(`document.querySelector('${root} ${id('other-projects-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
      expect(await page.evaluate(`document.querySelector('${first} ${id('project-working-toggle')}').dataset.count`)).toBe('1');
      expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').dataset.count`)).toBe('1');
      expect(await page.evaluate(`!!document.querySelector('${row(first, 't-bench')}') && !document.querySelector('${row(first, 't-scheduler')}')`)).toBe(true);
      await page.evaluate(`document.querySelector(${JSON.stringify(project(main, busy))}).scrollIntoView({block:'center'})`);
      await shot('folded');

      // A project stays visible while its only conversation starts or finishes work.
      const building = project(main, busy);
      await page.evaluate(`(() => { const store = globalThis.__boiteTest.workspace.machines[0].store; store.threads = store.threads.map(t => t.id === 't-building' ? {...t, status:'idle', unread:true} : t); })()`);
      await page.waitFor(`document.querySelector('${building}:not(.inactive)')`);
      await page.waitFor(`(() => { document.querySelector('${building}')?.scrollIntoView({block:'center'}); return !!document.querySelector('${row(building, 't-building')}'); })()`);
      expect(await page.evaluate(`!!document.querySelector('${row(building, 't-building')}')`)).toBe(true);
      await page.evaluate(`(() => { const store = globalThis.__boiteTest.workspace.machines[0].store; store.threads = store.threads.map(t => t.id === 't-building' ? {...t, status:'running', unread:false} : t); })()`);
      await page.waitFor(`document.querySelector('${building}:not(.inactive)')`);
      expect(await page.evaluate(`document.querySelector('${building} ${id('project-working-toggle')}').dataset.count`)).toBe('1');

      await click(`${first} ${id('project-working-toggle')}`);
      await page.waitFor(`document.querySelector('${row(first, 't-scheduler')}')`);
      await click(`${first} ${id('project-done-toggle')}`);
      await page.waitFor(`document.querySelector('${first} ${id('done-thread')}[data-thread-id="t-parser"]')`);
      expect(await page.evaluate(`document.querySelector('${second} ${id('project-done-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
      expect(await page.evaluate(`!!document.querySelector('${row(first, 't-scheduler')}')`)).toBe(true);
      await shot('expanded');
      if (width < 720) {
        // Phone counters do not inherit a collapsed desktop project.
        await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.toggleProject('p-boite')`);
        await click(`${first} ${id('project-working-toggle')}`);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-working-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
        expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.isCollapsed('p-boite')`)).toBe(true);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').getAttribute('aria-expanded')`)).toBe('true');
        await click(`${first} ${id('project-working-toggle')}`);
        await page.waitFor(`document.querySelector('${row(first, 't-scheduler')}')`);
      }
      const trace = row(first, 't-trace');
      if (width < 720) {
        await click(`${trace} ${id('mobile-thread-menu-t-trace')}`);
        await page.click(`${id('mobile-thread-menu-t-trace-menu')} [data-value=archive]`);
      } else await click(`${trace} ~ ${id('thread-done')}`);
      await page.waitFor(`document.querySelector('${first} ${id('project-done-toggle')}').dataset.count === '2' && document.querySelector('${first} ${id('done-thread')}[data-thread-id="t-trace"]')`);
      expect(await page.evaluate(`!!document.querySelector('${row(project(remote, 'p-boite'), 't-trace')}')`)).toBe(true);
      await click(`${first} ${id('project-working-toggle')}`);
      expect(await page.evaluate(`!document.querySelector('${row(first, 't-scheduler')}') && !!document.querySelector('${first} ${id('done-thread')}')`)).toBe(true);
      await page.evaluate(`(() => { const store = globalThis.__boiteTest.workspace.machines[0].store; store.threads = store.threads.map(t => t.id === 't-scheduler' ? {...t, pinned:true} : t); })()`);
      await page.waitFor(`document.querySelector('${row(first, 't-scheduler')}')`);
      await click(`${first} ${id('project-working-toggle')}`);
      expect(await page.evaluate(`document.querySelectorAll('${row(first, 't-scheduler')}').length`)).toBe(1);
      await click(`${first} ${id('project-working-toggle')}`);
      expect(await page.evaluate(`!!document.querySelector('${row(first, 't-scheduler')}')`)).toBe(true);
      await page.evaluate(`(() => { const store = globalThis.__boiteTest.workspace.machines[0].store; store.threads = store.threads.map(t => t.id === 't-scheduler' ? {...t, pinned:false} : t); })()`);
      await page.waitFor(`!document.querySelector('${row(first, 't-scheduler')}')`);

      if (width < 720) {
        await page.type(id('mobile-search'), 'scheduler');
        await page.waitFor(`document.querySelector('${row(first, 't-scheduler')}')`);
        expect(await page.evaluate(`document.querySelector('${row(first, 't-bench')}') === null`)).toBe(true);
        await page.type(id('mobile-search'), '');
        await page.waitFor(`document.querySelector('${root} ${id('other-projects-toggle')}')`);
      } else {
        // Opening a previously expanded counter also unfolds its collapsed project.
        await click(`${first} ${id('project-row')}`);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
        await click(`${first} ${id('project-done-toggle')}`);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-row')}').getAttribute('aria-expanded')`)).toBe('true');
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').getAttribute('aria-expanded')`)).toBe('true');
      }

      await click(`${root} ${id('other-projects-toggle')}`);
      expect(await page.evaluate(`!!document.querySelector('${building}:not(.inactive)') && !document.querySelector('${root} ${id('other-projects')} ${id(width < 720 ? 'mobile-project-group' : 'project')}[data-project-id="${busy}"]')`)).toBe(true);
      expect(await page.evaluate(`document.querySelector('${building} ${id('project-working-toggle')}').dataset.count`)).toBe('1');
      await click(`${building} ${id('project-working-toggle')}`);
      await page.waitFor(`document.querySelector('${row(building, 't-building')}')`);
      expect(await page.evaluate(`document.querySelector('${building} ${id('project-done-toggle')}').disabled`)).toBe(true);
      // Queued and background work also keep the project outside Other projects.
      for (const state of [
        { status: 'queued', backgroundWork: null },
        { status: 'idle', backgroundWork: { kinds: ['monitor'], since: 1 } },
        { status: 'idle', backgroundWork: { kinds: ['shell'], since: 1 } },
        { status: 'running', backgroundWork: null }
      ]) {
        await page.evaluate(`(() => { const store = globalThis.__boiteTest.workspace.machines[0].store; store.threads = store.threads.map(t => t.id === 't-building' ? {...t, ...${JSON.stringify(state)}} : t); })()`);
        await page.waitFor(`document.querySelector('${building}:not(.inactive) ${id('project-working-toggle')}')?.dataset.count === '1'`);
        expect(await page.evaluate(`!document.querySelector('${root} ${id('other-projects')} [data-project-id="${busy}"]')`)).toBe(true);
      }
      const finished = project(main, 'p-notes');
      await page.waitFor(`document.querySelector('${finished}')`);
      await click(`${finished} ${id('project-done-toggle')}`);
      const done = `${root} ${id('done-thread')}[data-machine-id="${main}"][data-thread-id="t-descriptors"]`;
      const revealDone = () => page.waitFor(`(() => {
        document.querySelector('${finished} ${id('project-done')}')?.scrollIntoView({block:'center'});
        return !!document.querySelector('${done}');
      })()`);
      await revealDone();
      await click(`${done} ${id('done-thread-open')}`);
      await page.waitFor('globalThis.__boiteTest.workspace.active.openThread?.id === "t-descriptors" && globalThis.__boiteTest.workspace.active.openThread.archived === true');
      expect(await page.evaluate(`!document.querySelector('${id('composer-input')}')`)).toBe(true);
      if (width < 720) {
        await page.click(id('mobile-back'));
        await page.waitFor(`document.querySelector('${finished} ${id('project-done')}')`);
        await revealDone();
      }
      await click(`${done} ${id('done-thread-restore')}`);
      await page.waitFor(`document.querySelector('${finished}:not(.inactive)')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.client.call('threads.get', {threadId:'t-descriptors'}).then(t=>t.archived)`)).toBe(false);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines[1].store.client.call('threads.get', {threadId:'t-descriptors'}).then(t=>t.archived)`)).toBe(false);

      // A draft makes an otherwise empty project available immediately.
      await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.startDraft(${JSON.stringify(empty)})`);
      await page.waitFor(`document.querySelector('${project(main, empty)}:not(.inactive)')`);
      expect(await page.evaluate(`document.querySelector('${project(main, empty)} ${id('project-done-toggle')}').disabled && document.querySelector('${project(main, empty)} ${id('project-working-toggle')}').disabled`)).toBe(true);
      if (width < 720) await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
      else await page.evaluate('globalThis.__boiteTest.workspace.active.setSidebarWidth(208)');
      await shot('narrow');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      expect(await page.evaluate(`Array.from(document.querySelectorAll('${root} ${width < 720 ? '.project-heading h2' : '.head .name'}')).every(name => name.getBoundingClientRect().width >= 50)`)).toBe(true);
      expect(page.errors()).toEqual([]);
    } catch (error) {
      await page.screenshot(join(import.meta.dir, '.artifacts', `project-groups-failure-${width}.png`)).catch(() => {});
      throw error;
    } finally { await page.close(); }
  }, 60_000);
}
