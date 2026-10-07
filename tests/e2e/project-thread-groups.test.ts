import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { showThreadView } from './lib/views.ts';
import { mobileAction } from './lib/mobile.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port: number;
const id = (value: string) => `[data-testid="${value}"]`;
beforeAll(async () => { port = await freePort(); server = await startUi(port); }, 60_000);
afterAll(async () => { await server?.close(); });

for (const width of [1280, 390]) {
  test(`visibility options work in both views and preserve manual archives at ${width}px`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`, windowSize: { width, height: width < 720 ? 844 : 900 } });
    try {
      await page.waitFor('globalThis.__boiteTest?.workspace.machines.length === 2');
      const { main, empty, merged } = await page.evaluate<{ main: string; empty: string; merged: string }>(`(async () => {
        const machine = globalThis.__boiteTest.workspace.machines[0], store = machine.store;
        await store.open('t-trace');
        store.threads = store.threads.map(t => t.id === 't-scheduler' ? {...t, status:'running', pinned:false, unread:false} : t);
        const empty = await store.client.call('projects.add', {path:'/workspace/quiet', name:'quiet'});
        const thread = await store.client.call('threads.create', {projectId:'p-boite', providerId:'echo', accountId:'a-echo', title:'Merged visibility fixture', worktree:{branch:'boite/visibility-options'}});
        store.client.setMergedPrFixture(thread.id, {repository:'github.com/example/repo', branch:thread.branch, tip:'a'.repeat(40), clean:true, candidates:[{repository:'github.com/example/repo', branch:thread.branch, sha:'a'.repeat(40), number:407, url:'https://github.com/example/repo/pull/407', mergedAt:'2026-10-02T12:00:00Z', fork:false}]});
        await store.client.sweepMergedPrArchives();
        return {main:machine.id, empty:empty.id, merged:thread.id};
      })()`);
      if (width < 720) await mobileAction(page, 'mobile-conversations');
      const root = width < 720 ? id('mobile-list') : id('sidebar'), prefix = width < 720 ? 'mobile-' : '';
      const menu = id(`${prefix}grouping-options-menu`);
      const row = (thread: string) => `${root} ${width < 720 ? '.row' : id('thread-row')}[data-machine-id="${main}"][data-thread-id="${thread}"]`;
      const revealProject = (thread: string) => page.waitFor(`(() => {
        document.querySelector('${root} ${id(width < 720 ? 'mobile-project-group' : 'project')}[data-machine-id="${main}"][data-project-id="p-boite"]')?.scrollIntoView({block:'center'});
        return !!document.querySelector('${row(thread)}');
      })()`);
      const option = async (key: string) => {
        if (await page.evaluate(`document.querySelector('${id(`${prefix}grouping-options`)}').getAttribute('aria-expanded') !== 'true'`)) await page.click(id(`${prefix}grouping-options`));
        const selector = `${menu} ${key === 'merged' ? '[data-value]:last-child' : `[data-value=${key}]`}`;
        const checked = await page.evaluate(`document.querySelector('${selector}').getAttribute('aria-checked')`);
        await page.click(selector);
        await page.waitFor(`document.querySelector('${selector}')?.getAttribute('aria-checked') === '${checked === 'true' ? 'false' : 'true'}'`);
        expect(await page.evaluate(`document.querySelector('${id(`${prefix}grouping-options`)}').getAttribute('aria-expanded')`)).toBe('true');
      };
      const shot = async (state: string) => {
        await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
        await page.screenshot(join(import.meta.dir, '.artifacts', `visibility-${state}-${width}.png`));
      };
      await showThreadView(page, 'projects', prefix);
      await revealProject('t-scheduler');
      await option('working');
      await page.waitFor(`!document.querySelector('${row('t-scheduler')}')`);
      await showThreadView(page, 'recent', prefix);
      await page.waitFor(`document.querySelector('${root} ${id('recent-working-toggle')}')`);
      expect(await page.evaluate(`!!document.querySelector('${row('t-scheduler')}')`)).toBe(false);
      await option('working');
      await page.waitFor(`document.querySelector('${row('t-scheduler')}')`);
      await showThreadView(page, 'projects', prefix);
      await revealProject('t-scheduler');
      await option('other');
      await page.waitFor(`!document.querySelector('${root} ${id('idle-projects-toggle')}') && document.querySelector('${root} [data-project-id="${empty}"]')`);
      await option('merged');
      await revealProject(merged);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.client.call('threads.get', {threadId:'t-parser'}).then(t=>t.archived)`)).toBe(true);
      await shot('projects-visible');
      await showThreadView(page, 'recent', prefix);
      await page.waitFor(`document.querySelector('${row(merged)}')`);
      await option('merged');
      expect(await page.evaluate('globalThis.__boiteTest.workspace.machines[0].store.client.sweepMergedPrArchives()')).toBe(1);
      await page.waitFor(`!document.querySelector('${row(merged)}')`);
      await page.click(id(`${prefix}project-filter`));
      await page.evaluate(`Array.from(document.querySelectorAll('${id(`${prefix}project-filter-menu`)} [data-value]')).find(e => e.dataset.value === JSON.stringify(['http://builder.test', 'p-boite'])).click()`);
      await option('merged');
      expect(await page.evaluate('globalThis.__boiteTest.workspace.machines.map(m => m.store.projects.find(p => p.id === "p-boite").autoArchiveMergedPr)')).toEqual([true, false]);
      await page.waitFor(`document.querySelector('${menu} [role=menuitemcheckbox]')`);
      await shot('recent-options');
      expect(await page.evaluate(`(() => { const r=document.querySelector('${menu}').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`)).toBe(true);
      await page.reload();
      await page.waitFor('globalThis.__boiteTest?.workspace.machines.length === 2');
      expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.recent.v1'))`)).toEqual({groupWorking:false, groupOtherProjects:false});
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      expect(page.errors()).toEqual([]);
      console.log(`VISIBILITY_OPTIONS_OK width=${width} projects=ok recent=ok manual-archives=preserved owning-machine=ok persistence=ok`);
    } catch (error) {
      await page.screenshot(join(import.meta.dir, '.artifacts', `visibility-failure-${width}.png`)).catch(() => {});
      throw error;
    } finally { await page.close(); }
  }, 60_000);

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
      await showThreadView(page, 'projects', width < 720 ? 'mobile-' : '');
      await page.click(id(width < 720 ? 'mobile-grouping-options' : 'grouping-options'));
      await page.click(`${id(width < 720 ? 'mobile-grouping-options-menu' : 'grouping-options-menu')} [data-value=working]`);
      await page.click(id(width < 720 ? 'mobile-grouping-options' : 'grouping-options'));
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
      expect(await page.evaluate(`document.querySelector('${root} ${id('idle-projects-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
      expect(await page.evaluate(`document.querySelector('${first} ${id('project-working-toggle')}').dataset.count`)).toBe('1');
      // t-parser was archived by hand: it waits under Archived, not Done.
      expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').dataset.count`)).toBe('0');
      expect(await page.evaluate(`document.querySelector('${first} ${id('project-archived-toggle')}').dataset.count`)).toBe('1');
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
      expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').disabled`)).toBe(true);
      await click(`${first} ${id('project-archived-toggle')}`);
      await page.waitFor(`document.querySelector('${first} ${id('project-archived')} ${id('done-thread')}[data-thread-id="t-parser"]')`);
      expect(await page.evaluate(`!document.querySelector('${first} ${id('project-done')} ${id('done-thread')}')`)).toBe(true);
      expect(await page.evaluate(`document.querySelector('${second} ${id('project-archived-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
      expect(await page.evaluate(`!!document.querySelector('${row(first, 't-scheduler')}')`)).toBe(true);
      await shot('expanded');
      if (width < 720) {
        // Phone counters do not inherit a collapsed desktop project.
        await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.toggleProject('p-boite')`);
        await click(`${first} ${id('project-working-toggle')}`);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-working-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
        expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.isCollapsed('p-boite')`)).toBe(true);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-archived-toggle')}').getAttribute('aria-expanded')`)).toBe('true');
        await click(`${first} ${id('project-working-toggle')}`);
        await page.waitFor(`document.querySelector('${row(first, 't-scheduler')}')`);
      }
      const trace = row(first, 't-trace');
      if (width < 720) {
        await click(`${trace} ${id('mobile-thread-menu-t-trace')}`);
        await page.click(`${id('mobile-thread-menu-t-trace-menu')} [data-value=archive]`);
      } else await click(`${trace} ~ ${id('thread-done')}`);
      // Mark done lands in Done; a plain archive lands in Archived.
      const landed = width < 720 ? 'archived' : 'done';
      await page.waitFor(`document.querySelector('${first} ${id(`project-${landed}-toggle`)}').dataset.count === '${width < 720 ? 2 : 1}'`);
      // Done was empty, so its list opens only now.
      if (landed === 'done') await click(`${first} ${id('project-done-toggle')}`);
      await page.waitFor(`document.querySelector('${first} ${id(`project-${landed}`)} ${id('done-thread')}[data-thread-id="t-trace"]')`);
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
        await page.waitFor(`document.querySelector('${root} ${id('idle-projects-toggle')}')`);
      } else {
        // Opening a previously expanded counter also unfolds its collapsed project.
        await click(`${first} ${id('project-row')}`);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
        await click(`${first} ${id('project-done-toggle')}`);
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-row')}').getAttribute('aria-expanded')`)).toBe('true');
        expect(await page.evaluate(`document.querySelector('${first} ${id('project-done-toggle')}').getAttribute('aria-expanded')`)).toBe('true');
      }

      await click(`${root} ${id('idle-projects-toggle')}`);
      // The fold lists idle projects as compact rows, never as project sections.
      const idleRow = (projectId: string) => `${root} ${id('idle-projects')} ${id('idle-project')}[data-machine-id="${main}"][data-project-id="${projectId}"]`;
      expect(await page.evaluate(`!!document.querySelector('${building}:not(.inactive)') && !document.querySelector('${idleRow(busy)}') && !!document.querySelector('${idleRow(empty)}')`)).toBe(true);
      expect(await page.evaluate(`!document.querySelector('${root} ${id('idle-projects')} ${id(width < 720 ? 'mobile-project-group' : 'project')}')`)).toBe(true);
      expect(await page.evaluate(`document.querySelector('${building} ${id('project-working-toggle')}').dataset.count`)).toBe('1');
      await click(`${building} ${id('project-working-toggle')}`);
      await page.waitFor(`document.querySelector('${row(building, 't-building')}')`);
      expect(await page.evaluate(`document.querySelector('${building} ${id('project-done-toggle')}').disabled`)).toBe(true);
      // Queued and background work also keep the project outside Idle projects.
      for (const [index, renderedState] of ['queued', 'monitoring', 'background', 'working'].entries()) {
        await page.evaluate(`(() => {
          const states = [
            { status: 'queued', backgroundWork: null },
            { status: 'idle', backgroundWork: { kinds: ['monitor'], since: 1 } },
            { status: 'idle', backgroundWork: { kinds: ['shell'], since: 1 } },
            { status: 'running', backgroundWork: null }
          ];
          const store = globalThis.__boiteTest.workspace.machines[0].store;
          store.threads = store.threads.map(t => t.id === 't-building' ? {...t, ...states[${index}]} : t);
        })()`);
        await page.waitFor(`document.querySelector('${row(building, 't-building')} ${id('thread-state')}[data-state="${renderedState}"]')`);
        expect(await page.evaluate(`!document.querySelector('${idleRow(busy)}')`)).toBe(true);
      }
      // An idle project keeps its done history one click away, under its row.
      const finished = idleRow('p-notes');
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
      await page.waitFor(`document.querySelector('${project(main, 'p-notes')}:not(.inactive)') && !document.querySelector('${finished}')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.client.call('threads.get', {threadId:'t-descriptors'}).then(t=>t.archived)`)).toBe(false);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines[1].store.client.call('threads.get', {threadId:'t-descriptors'}).then(t=>t.archived)`)).toBe(false);

      // Choosing an idle project starts a draft there, which returns it to the list immediately.
      await click(`${idleRow(empty)} ${id('idle-project-open')}`);
      await page.waitFor(`globalThis.__boiteTest.workspace.machines[0].store.draft?.projectId === ${JSON.stringify(empty)}`);
      if (width < 720) await page.click(id('mobile-back'));
      await page.waitFor(`document.querySelector('${project(main, empty)}:not(.inactive)') && !document.querySelector('${idleRow(empty)}')`);
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
