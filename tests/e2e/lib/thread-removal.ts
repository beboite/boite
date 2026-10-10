import { expect } from 'bun:test';
import type { BrowserPage } from './cdp';

/** Confirm through the same exact-name field on desktop, phone and archive lists. */
export async function confirmDeletion(page: BrowserPage, threadId: string): Promise<void> {
  await page.waitFor(`document.querySelector('[data-testid=confirm-name]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=confirm-ok]').disabled`)).toBe(true);
  const title = await page.evaluate<string>(`globalThis.__boiteTest.workspace.active.client.call('threads.get', { threadId: ${JSON.stringify(threadId)} }).then(t => t.title)`);
  const required = await page.evaluate<string>(`document.querySelector('[data-testid=confirm-dialog] .required-name').textContent`);
  expect(required.trim().length).toBeGreaterThan(0);
  if (title.trim()) expect(required).toBe(title);
  await page.type('[data-testid=confirm-name]', required);
  await page.waitFor(`!document.querySelector('[data-testid=confirm-ok]').disabled`);
  await page.click('[data-testid=confirm-ok]');
  await page.waitFor(`!document.querySelector('[data-testid=confirm-dialog]')`);
}
