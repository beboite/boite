import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { CoreClient } from '../../packages/core/src/client.ts';
import { startTestCore, waitFor, type TestCore } from '../../packages/core/test/harness.ts';
import { BrowserPage } from './lib/cdp.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

let harness: TestCore;
let owner: CoreClient;
let page: BrowserPage | null = null;

beforeAll(async () => {
  ensureProductionUi();
  harness = await startTestCore();
  owner = await harness.connect();
}, 90_000);
afterAll(async () => { await page?.close(); await harness?.stop(); }, 30_000);

for (const width of [1440, 390]) test(`a bot on a retired provider opens and its default model can be repaired at ${width}px`, async () => {
  // A profile left by an older core: no thread yet and no remaining provider or account.
  const agent = harness.core.workforce.records.create('profile', {
    name: 'B.O.T.S', domain: '', instructions: '', avatar: '', status: 'paused', projectIds: [],
    selection: { providerId: 'antigravity-cli', accountId: 'acc_retired', model: 'retired-model', effort: null, permissionMode: 'default' },
  });
  const config = harness.core.workforce.resident.config(agent.id);
  const available = { ...agent.selection, providerId: 'echo', accountId: (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!.id, model: 'echo' };
  // Other allowed routes must not keep the replacement from saving; valid choices stay.
  harness.core.journal.setSetting(`agents:runtime:${agent.id}`, { ...config, allowedRoutes: [
    ...config.allowedRoutes,
    { ...agent.selection, id: 'retired-alternative', name: 'Retired alternative', model: 'retired-alternative' },
    { ...available, id: 'removed-account', name: 'Removed account', accountId: 'acc_removed' },
    { ...available, id: 'available', name: 'Available' },
  ] });
  try {
    page = await BrowserPage.launch({ url: `${harness.url}/?token=${harness.token}`, experiments: ['resident-agents'], windowSize: { width, height: 900 } });
    await page.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`, 30_000);
    await page.click('[data-testid=view-agents]');
    await page.click(`[data-testid="agent-entry-${agent.id}"]`);
    await page.waitFor(`document.querySelector('[data-testid=agent-header]')?.textContent.includes('B.O.T.S')`);
    expect(await page.text('[data-testid=agent-problem]')).toContain('antigravity-cli');
    expect(harness.core.journal.listTurns(harness.core.workforce.sessionOf(agent.id)!.threadId)).toHaveLength(0);
    await page.settleAnimations();
    await page.screenshot(join(import.meta.dir, '.artifacts', `unavailable-bot-${width}.png`));
    await page.click('[data-testid=agent-problem] button');
    await page.click('[data-testid=agent-runtime] [data-testid=composer-picker]');
    await page.click('[data-provider="echo"]');
    await page.click('[data-model="echo"]');
    await waitFor(() => harness.core.workforce.records.get('profile', agent.id).selection.providerId === 'echo', 10_000);
    const repaired = (await owner.call('agents.runtime.get', { agentId: agent.id })).allowedRoutes;
    expect(repaired.map(route => route.id)).toEqual(['default', 'available']);
    expect(repaired.map(route => route.providerId)).toEqual(['echo', 'echo']);
    await page.waitFor(`document.querySelector('[data-testid=agent-runtime] [data-testid=save-status]')?.dataset.state === 'saved'`);
    await page.evaluate(`document.querySelector('[data-testid=agent-runtime]').scrollIntoView({ block: 'start' })`);
    await page.settleAnimations();
    await page.screenshot(join(import.meta.dir, '.artifacts', `replacement-model-${width}.png`));
    await page.click('[data-testid=agent-sheet-close]');
    await page.waitFor(`!document.querySelector('[data-testid=agent-problem]')`);
    const threadId = harness.core.workforce.sessionOf(agent.id)!.threadId;
    expect((await owner.call('threads.get', { threadId })).providerId).toBe('echo');
    await page.settleAnimations();
    await page.screenshot(join(import.meta.dir, '.artifacts', `repaired-bot-${width}.png`));
    await page.type('.agents-main [data-testid=composer-input]', 'Hello on the repaired model');
    await page.click('.agents-main [data-testid=composer-send]');
    await waitFor(() => harness.core.journal.listTurns(threadId).some(turn => turn.status === 'done'), 10_000);
    await page.waitFor(`document.querySelector('.agents-main')?.textContent.includes('Hello on the repaired model')`);
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close(); page = null;
    await owner.call('agents.profile.save', { id: agent.id, expectedRevision: harness.core.workforce.records.get('profile', agent.id).revision,
      value: { ...harness.core.workforce.records.get('profile', agent.id), selection: { providerId: 'echo', accountId: (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!.id, model: 'echo', effort: null, permissionMode: 'default' }, status: 'archived' } });
  }
}, 60_000);
