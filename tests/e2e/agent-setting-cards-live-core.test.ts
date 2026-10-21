import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { echoThread, startTestCore, waitFor } from '../../packages/core/test/harness.ts';
import { setDriver } from '../../packages/core/src/drivers/index.ts';
import { BrowserPage } from './lib/cdp.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

test('a real agent conversation receives new setting cards and removes settled cards on desktop and phone', async () => {
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
    let agent = await owner.call('agents.profile.save', { value: {
      name: 'Mira', domain: 'Builds', instructions: '', avatar: '', status: 'active', tools: [], projectIds: [],
      selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' }
    } });
    agent = await owner.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision,
      config: { ...harness.core.workforce.resident.config(agent.id), autoMemory: false } });
    await owner.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text: 'Ready for builds', requestId: 'card-browser-hello' });
    await waitFor(() => harness.core.workforce.records.list('work').some(work => work.status === 'done'));
    const threadId = harness.core.workforce.records.sessionFor(agent.id, { kind: 'agent', id: agent.id })!.threadId;
    page = await BrowserPage.launch({ url: `${harness.url}/?token=${harness.token}`, experiments: ['resident-agents'], windowSize: { width: 1440, height: 900 } });
    await page.click('[data-testid=view-agents]');
    await page.click(`[data-testid="agent-entry-${agent.id}"]`);
    await page.waitFor('!!document.querySelector("[data-testid=agent-transcript]")');

    for (const phone of [false, true]) {
      if (phone) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const minutes = phone ? 40 : 30;
      await owner.call('agents.settings.request', { threadId, key: 'maxRunMinutes', value: minutes, reason: 'Allow enough time to finish builds.' });
      await page.waitFor('!!document.querySelector("[data-testid=agent-setting-apply]")');
      await page.evaluate('document.querySelector("[data-testid=agent-setting-card]").scrollIntoView({ block: "center" })');
      await page.settleAnimations();
      await page.screenshot(join(import.meta.dir, '.artifacts', `agent-setting-card-${phone ? 'phone' : 'desktop'}.png`));
      await page.click('[data-testid=agent-setting-apply]');
      await page.waitFor('!document.querySelector("[data-testid=agent-setting-card]")');
      expect(harness.core.workforce.resident.config(agent.id).maxRunMinutes).toBe(minutes);

      // A change in another client removes the card before its old Apply can be clicked.
      await owner.call('agents.settings.request', { threadId, key: 'maxRunMinutes', value: minutes + 1, reason: 'One extra minute for the build.' });
      await page.waitFor('!!document.querySelector("[data-testid=agent-setting-apply]")');
      const profile = harness.core.workforce.records.get('profile', agent.id);
      await owner.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile.revision,
        config: { ...harness.core.workforce.resident.config(agent.id), maxRunMinutes: minutes + 1 } });
      await page.waitFor('!document.querySelector("[data-testid=agent-setting-card]")');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.settleAnimations();
      await page.screenshot(join(import.meta.dir, '.artifacts', `agent-setting-settled-${phone ? 'phone' : 'desktop'}.png`));
    }
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); await harness.stop(); restore(); }
}, 60_000);
