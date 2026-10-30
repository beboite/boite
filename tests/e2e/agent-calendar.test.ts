import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { makeAgent } from '../../packages/core/test/agent-fixture.ts';
import { startTestCore } from '../../packages/core/test/harness.ts';
import { BrowserPage } from './lib/cdp.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

test('the owner creates and edits monthly, yearly and single-date reminders on desktop and phone', async () => {
  ensureProductionUi();
  const h = await startTestCore();
  let page: BrowserPage | undefined;
  try {
    const owner = await h.connect();
    const accountId = (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!.id;
    const { agent } = await makeAgent(h, owner, { name: 'Mira', instructions: '', selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' } });
    page = await BrowserPage.launch({ url: `${h.url}/?token=${h.token}`, experiments: ['resident-agents'], windowSize: { width: 1440, height: 1000 } });
    const id = (name: string) => `[data-testid="${name}"]`;
    const artifacts = join(import.meta.dir, '.artifacts', 'agent-calendar');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`document.querySelector('${id('view-agents')}')`);
    await page.click(id('view-agents'));
    await page.waitFor(`document.querySelector('${id(`agent-entry-${agent.id}`)}')`);
    await page.click(id(`agent-entry-${agent.id}`));
    await page.waitFor(`document.querySelector('${id('agent-menu')}')`);
    await page.click(id('agent-menu'));
    await page.click('[data-value="settings"]');
    await page.waitFor(`document.querySelector('${id('agent-schedule')}')`);

    for (const kind of ['monthly', 'yearly', 'once'] as const) {
      if (kind !== 'monthly') await page.click(id('routine-add'));
      await page.click(id(`schedule-mode-${kind}`));
      await page.type(id('routine-prompt'), `Review the ${kind} notes`);
      if (kind === 'once') {
        await page.evaluate(`(() => { const input = document.querySelector('${id('schedule-at')}'); input.value = '2030-11-14T09:00'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      } else {
        await page.type(id('schedule-month-day'), '14');
        if (kind === 'yearly') {
          await page.click(id('schedule-month'));
          await page.click('[data-value="11"]');
        }
      }
      await page.waitFor(`document.querySelector('${id('routine-save')}')?.disabled === false`);
      if (kind === 'monthly' || kind === 'yearly') {
        await page.evaluate(`document.querySelector('${id('right-panel')} ${id('panel-close')}')?.click()`);
        await page.waitFor(`!(document.querySelector('${id('right-panel')}')?.getBoundingClientRect().width > 0)`);
        await page.evaluate(`document.querySelector('${id('agent-schedule')}').scrollIntoView({ block: 'start' })`);
        await page.settleAnimations();
        await page.screenshot(join(artifacts, `${kind}-desktop.png`));
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.evaluate(`document.querySelector('${id('agent-schedule')}').scrollIntoView({ block: 'start' })`);
        await page.settleAnimations();
        expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
        for (const choice of ['monthly', 'yearly']) {
          expect(await page.evaluate(`(() => { const el = document.querySelector('${id(`schedule-mode-${choice}`)}'); const b = el.getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= innerWidth && el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); })()`)).toBe(true);
        }
        await page.screenshot(join(artifacts, `${kind}-phone.png`));
      }
      await page.click(id('routine-save'));
      await page.waitFor(`!document.querySelector('${id('agent-schedule')}')`);
      const routine = h.core.workforce.records.list('routine').find(r => r.schedule.kind === kind)!;
      expect(routine.schedule).toMatchObject(kind === 'once' ? { kind } : { kind, day: 14, ...(kind === 'yearly' ? { month: 11 } : {}) });
      expect(routine.nextAt).toBeGreaterThan(Date.now());
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await page.click(`${id(`routine-${routine.id}`)} ${id('routine-edit')}`);
      await page.waitFor(`document.querySelector('${id(`schedule-mode-${kind}`)}')?.getAttribute('aria-checked') === 'true'`);
      if (kind === 'yearly') expect(await page.evaluate(`document.querySelector('${id('schedule-month')}').textContent`)).toContain('November');
      if (kind !== 'once') {
        await page.type(id('schedule-month-day'), '15');
        await page.click(id('routine-save'));
        await page.waitFor(`!document.querySelector('${id('agent-schedule')}')`);
        expect(h.core.workforce.records.get('routine', routine.id).schedule).toMatchObject({ kind, day: 15 });
      } else {
        expect(await page.evaluate(`document.querySelector('${id('schedule-at')}').value`)).toBe('2030-11-14T09:00');
      }
    }
    console.log('[calendar] monthly, yearly and once saved and reopened; desktop and phone captures recorded');
  } finally {
    await page?.close();
    await h.stop();
  }
}, 120_000);
