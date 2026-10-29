import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { echoThread, quietAgent, startTestCore, waitFor } from '../../packages/core/test/harness.ts';
import { setDriver } from '../../packages/core/src/drivers/index.ts';
import { BrowserPage } from './lib/cdp.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

test('a real agent thread receives new setting cards and removes settled cards on desktop and phone', async () => {
  ensureProductionUi();
  const restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: 'Build settings are ready.' });
    ctx.emit.complete(id, 'complete');
    return { done: Promise.resolve({ status: 'done', sessionId: 'card-browser', usage: null }), stop() {} };
  } });
  const harness = await startTestCore();
  let page: BrowserPage | undefined;
  try {
    const owner = await harness.connect();
    const { accountId } = await echoThread(harness, owner);
    const agent = await quietAgent(owner, await owner.call('agents.profile.save', { value: {
      name: 'Mira', domain: 'Builds', instructions: '', avatar: '', status: 'active', projectIds: [],
      selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' }
    } }));
    // Its thread opens with its introduction; the cards land in that thread.
    const { threadId } = await owner.call('agents.open', { agentId: agent.id });
    await waitFor(() => harness.core.journal.listTurns(threadId).some(turn => turn.status === 'done'), 10_000);
    page = await BrowserPage.launch({ url: `${harness.url}/?token=${harness.token}`, experiments: ['resident-agents'], windowSize: { width: 1440, height: 900 } });
    await page.click('[data-testid=view-agents]');
    await page.click(`[data-testid="agent-entry-${agent.id}"]`);
    await page.waitFor('document.querySelector(".agents-main [data-testid=agent-header]")?.textContent.includes("Mira")');

    // A pending card waits for the user; once settled, the thread keeps one row saying how it ended.
    const pending = '.agents-main [data-testid=agent-setting-card][data-state=pending]';
    for (const phone of [false, true]) {
      if (phone) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const budget = phone ? 10 : 3;
      await owner.call('agents.settings.request', { threadId, key: 'dailyBudget', value: budget, reason: 'Enough for a few builds a day.' });
      await page.waitFor(`!!document.querySelector('${pending} [data-testid=agent-setting-apply]')`);
      await page.evaluate(`document.querySelector('${pending}').scrollIntoView({ block: "center" })`);
      await page.settleAnimations();
      await page.screenshot(join(import.meta.dir, '.artifacts', `agent-setting-card-${phone ? 'phone' : 'desktop'}.png`));
      await page.click(`${pending} [data-testid=agent-setting-apply]`);
      await page.waitFor(`!document.querySelector('${pending}')`);
      expect(harness.core.workforce.resident.config(agent.id).dailyBudgetUsd).toBe(budget);

      // A change in another client removes the card before its old Apply can be clicked.
      await owner.call('agents.settings.request', { threadId, key: 'dailyBudget', value: budget + 1, reason: 'One more build today.' });
      await page.waitFor(`!!document.querySelector('${pending} [data-testid=agent-setting-apply]')`);
      const profile = harness.core.workforce.records.get('profile', agent.id);
      await owner.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile.revision,
        config: { ...harness.core.workforce.resident.config(agent.id), dailyBudgetUsd: budget + 1 } });
      await page.waitFor(`!document.querySelector('${pending}')`);
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.settleAnimations();
      await page.screenshot(join(import.meta.dir, '.artifacts', `agent-setting-settled-${phone ? 'phone' : 'desktop'}.png`));
    }
    // The value moved where each card asked, from Apply or from the settings: all four read applied.
    expect(await page.evaluate(`[...document.querySelectorAll('.agents-main [data-testid=agent-setting-card][data-outcome]')].map(card => card.dataset.outcome)`)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); await harness.stop(); restore(); }
}, 60_000);
