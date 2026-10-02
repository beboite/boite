import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore } from './lib/core.ts';
import { ensureProductionUi, UI_DIST } from './lib/prod-ui';

const selector = (id: string): string => `[data-testid="${id}"]`;
const artifacts = join(import.meta.dir, '.artifacts');

test('queued prompts keep their thread, and browser project and account actions work', async () => {
  await ensureProductionUi();
  const core = await startCore({ env: { BOITE_UI_DIR: UI_DIST } });
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Queue check' });
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
    const a = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Thread A' });
    const b = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Thread B' });
    page = await BrowserPage.launch({ url: pairingUrlOf(core) });
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    await page.click(`[data-thread-id="${a.id}"]`);
    await page.waitFor('document.querySelector("[data-testid=thread-title]")?.textContent.trim() === "Thread A"');
    await page.type(selector('composer-input'), 'hold here [permission]');
    await page.click(selector('composer-send'));
    await page.waitFor('document.querySelector("[data-testid=permission-card]")');
    await page.type(selector('composer-input'), 'queued only for A');
    await page.evaluate('document.querySelector("[data-testid=composer-input]").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true}))');
    await page.waitFor('document.querySelector("[data-testid=composer-queued]")');
    for (const [index, prompt] of ['second queued for A', 'third queued for A'].entries()) {
      await page.type(selector('composer-input'), prompt);
      await page.waitFor(`document.querySelector('[data-testid="composer-input"]').value === ${JSON.stringify(prompt)}`);
      await page.evaluate('document.querySelector("[data-testid=composer-input]").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true}))');
      await page.waitFor(`document.querySelectorAll('[data-testid="composer-queued"] .queued-bubble').length === ${index + 2}`);
    }
    await page.screenshot(join(artifacts, 'composer-queued.png'));
    await page.click(`[data-thread-id="${b.id}"]`);
    await page.waitFor('document.querySelector("[data-testid=thread-title]")?.textContent.trim() === "Thread B"');
    const permission = (await client.call('permissions.list', { threadId: a.id }))[0]!;
    const firstDone = client.next('turn.finished', (turn) => turn.threadId === a.id);
    const queuedDone = client.next('turn.finished', (turn) => turn.threadId === a.id && turn.id !== permission.turnId);
    await client.call('permissions.answer', { requestId: permission.id, decision: 'allow' });
    await firstDone;
    await queuedDone;
    expect(await page.evaluate('document.querySelector("[data-testid=thread-title]")?.textContent.trim()')).toBe('Thread B');
    await page.screenshot(join(artifacts, 'composer-queue-background.png'));
    expect((await client.call('threads.get', { threadId: b.id })).messages).toHaveLength(0);
    await page.click(`[data-thread-id="${a.id}"]`);
    await page.waitFor('Array.from(document.querySelectorAll("[data-testid=message][data-role=assistant]")).some(el => el.textContent.includes("queued only for A"))');
    await page.waitFor('document.querySelector("[data-testid=thread-header][data-status]")?.dataset.status === "idle"');
    const userMessages = (await client.call('threads.get', { threadId: a.id })).messages.filter(message => message.role === 'user');
    expect(userMessages.map(message => message.parts)).toEqual([
      [{ type: 'text', text: 'hold here [permission]' }],
      [{ type: 'text', text: 'queued only for A\n\nsecond queued for A\n\nthird queued for A' }]
    ]);
    expect(userMessages.at(-1)?.parts).toEqual([{ type: 'text', text: 'queued only for A\n\nsecond queued for A\n\nthird queued for A' }]);
    await page.screenshot(join(artifacts, 'composer-queued-batch.png'));
    expect((await client.call('threads.get', { threadId: b.id })).messages).toHaveLength(0);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
    await page.click(selector('mobile-menu'));
    await page.click(selector('mobile-menu-project'));
    await page.click('[data-value="add-project"]');
    await page.waitFor('document.querySelector("[data-testid=project-path]")');
    await page.screenshot(join(artifacts, 'phone-add-project.png'));
    const directory = join(core.dataDir, 'second-project');
    mkdirSync(directory);
    await page.type(selector('project-path'), directory);
    await page.click(selector('project-add'));
    await page.waitFor('document.querySelector("[data-testid=thread-title]")?.textContent.trim() === "New thread"');
    await page.waitFor('document.querySelector("[data-testid=mobile-draft-project]")?.textContent.includes("second-project")');
    expect(await page.text('[data-testid=mobile-draft-project]')).toContain("second-project");
    expect(await page.evaluate('getComputedStyle(document.querySelector("[data-testid=composer-input]")).visibility')).toBe("visible");
    await page.screenshot(join(artifacts, "phone-added-project-draft.png"));
    expect((await client.call('projects.list', {})).some((entry) => entry.path === directory)).toBe(true);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.waitFor('document.querySelector("[data-testid=draft-row]")');
    const isolated = await client.call('accounts.add', { providerId: 'echo', label: 'Temporary account' });
    await page.click(selector('nav-settings'));
    await page.click(selector('settings-tab-accounts'));
    // Accounts sit behind their provider's chevron.
    await page.waitFor('document.querySelector("[data-provider-id=echo] [data-testid=provider-details-toggle]")');
    await page.click('[data-provider-id=echo] [data-testid=provider-details-toggle]');
    await page.waitFor(`document.querySelector('[data-testid=account-remove][data-account-id="${isolated.id}"]')`);
    await page.screenshot(join(artifacts, 'accounts-remove.png'));
    await page.click(`[data-testid=account-remove][data-account-id="${isolated.id}"]`);
    await page.waitFor('document.querySelector("[data-testid=confirm-dialog]")');
    await page.click(selector('confirm-ok'));
    await page.waitFor(`!document.querySelector('[data-testid=account-row][data-account-id="${isolated.id}"]')`);
    expect((await client.call('accounts.list', {})).some((entry) => entry.id === isolated.id)).toBe(false);
  } finally {
    await page?.close();
    client.close();
    await core.stop();
  }
}, 120_000);
