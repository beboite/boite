import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadSnapshot } from '../../packages/contracts/src/index';
import { echoThread, startTestCore, waitFor } from '../../packages/core/test/harness';
import { BrowserPage } from './lib/cdp';
import { mintPairing } from './lib/core';
import { mobileAction } from './lib/mobile';
import { ensureProductionUi } from './lib/prod-ui';

test('production desktop and paired phone open compact snapshots and download file bytes only on demand', async () => {
  ensureProductionUi();
  const harness = await startTestCore();
  let page: BrowserPage | undefined;
  try {
    const client = await harness.connect();
    const { threadId, accountId } = await echoThread(harness, client, 'Download attachments');
    const projectId = harness.core.threads.require(threadId).projectId!;
    const other = await client.call('threads.create', { projectId, providerId: 'echo', accountId, title: 'Other conversation' });
    const body = randomBytes(192 * 1024), data = body.toString('base64');
    harness.core.journal.putTurn({ id: 'files-turn', threadId, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null });
    for (const role of ['user', 'assistant'] as const) harness.core.journal.putMessage({
      id: `file-${role}`, threadId, turnId: 'files-turn', role, state: 'complete', createdAt: role === 'user' ? 1 : 2,
      parts: [{ type: 'text', text: role === 'user' ? 'Review the attached document.' : 'The result is ready to download.' },
        { type: 'file', name: `${role}-fixture.bin`, mimeType: 'application/octet-stream', data }]
    });
    const reads: string[] = [], snapshots: ThreadSnapshot[] = [];
    const dispatch = harness.core.router.dispatch.bind(harness.core.router);
    harness.core.router.dispatch = async (method, params, context) => {
      if ((params as { threadId?: string }).threadId === threadId) reads.push(method);
      const result = await dispatch(method, params, context);
      if (method === 'threads.get' && (params as { threadId: string }).threadId === threadId) snapshots.push(result as ThreadSnapshot);
      return result;
    };
    for (const phone of [false, true]) {
      const downloads = join(harness.dataDir, phone ? 'phone-downloads' : 'desktop-downloads');
      mkdirSync(downloads);
      page = await BrowserPage.launch({ url: phone ? await mintPairing(harness) : `${harness.url}/?token=${harness.token}`,
        windowSize: { width: phone ? 390 : 1280, height: phone ? 844 : 900 } });
      await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      const open = async (id: string) => {
        if (phone) await mobileAction(page!, 'mobile-conversations');
        await page!.click(phone ? `[data-testid="mobile-thread-${id}"]` : `[data-thread-id="${id}"]`);
      };
      reads.length = 0;
      await open(threadId);
      await page.waitFor('document.querySelector("[data-testid=artifact-download]") && document.querySelector("[data-testid=file-part]")');
      expect(reads.filter(method => ['threads.get', 'threads.subscribe', 'permissions.list', 'questions.list', 'messages.attachment'].includes(method))).toEqual(['threads.get']);
      expect(snapshots.at(-1)!.messages.flatMap(message => message.parts).filter(part => part.type === 'file').every(part => part.type === 'file' && part.data === '' && part.bytes === body.length)).toBe(true);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-loading-${phone ? 'phone' : 'desktop'}.png`));
      for (const role of ['user', 'assistant']) {
        await page.click(role === 'user' ? '[data-testid=file-part]' : '[data-testid=artifact-download]');
        const path = join(downloads, `${role}-fixture.bin`);
        await waitFor(() => existsSync(path) && statSync(path).size === body.length, 10_000);
        expect(readFileSync(path).equals(body)).toBe(true);
      }
      expect(reads.filter(method => method === 'messages.attachment')).toHaveLength(2);
      await open(other.id);
      await page.waitFor(`document.querySelector('[data-testid=thread-title]')?.textContent.includes('Other conversation')`);
      reads.length = 0;
      await open(threadId);
      await waitFor(() => snapshots.at(-1)?.messagesUnchanged === true);
      expect(reads.filter(method => ['threads.get', 'threads.subscribe', 'permissions.list', 'questions.list', 'messages.attachment'].includes(method))).toEqual(['threads.get']);
      expect(snapshots.at(-1)!.messages).toEqual([]);
      await page.waitFor('document.querySelector("[data-testid=file-part]") && document.querySelector("[data-testid=artifact-download]")');
      expect(page.errors()).toEqual([]);
      await page.close(); page = undefined;
    }
  } finally { await page?.close(); await harness.stop(); }
}, 90_000);
