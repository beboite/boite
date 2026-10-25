import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { echoThread, startTestCore, waitFor } from '../../packages/core/test/harness.ts';
import { readMessageAttachment } from '../../packages/core/src/threads/attachment-read.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf } from './lib/core.ts';
import { mobileAction } from './lib/mobile.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

for (const phone of [false, true]) {
  test(`text and composer remain usable while photo and video requests wait on ${phone ? 'phone' : 'desktop'}`, async () => {
    ensureProductionUi();
    const harness = await startTestCore();
    const client = await harness.connect();
    let page: BrowserPage | undefined;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      const { threadId } = await echoThread(harness, client, 'Review the photo and clip');
      const done = client.next('turn.finished');
      await client.call('turns.start', { threadId, prompt: 'Review the photo and clip.' });
      const turn = await done;
      page = await BrowserPage.launch({ url: phone ? await mintPairing(harness) : pairingUrlOf(harness), windowSize: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      // Canvas supplies the picture; the fixture is a silent VP8 clip with ten 320 by 180 frames.
      const photo = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 640, 360);
        gradient.addColorStop(0, '#443b7c'); gradient.addColorStop(1, '#185c73');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#b8e1e8'; ctx.beginPath(); ctx.arc(130, 130, 60, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = 'white'; ctx.font = '30px sans-serif'; ctx.fillText('Photo and clip', 55, 280);
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      expect(photo.length).toBeGreaterThan(8192);
      harness.core.journal.putMessage({
        id: 'msg_waiting_media', threadId, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: Date.now(),
        parts: [
          { type: 'text', text: 'Photo and clip are ready.' },
          { type: 'file', mimeType: 'image/png', data: photo, name: 'photo.png' },
          { type: 'file', mimeType: 'video/webm', data: readFileSync(join(import.meta.dir, 'fixtures', 'media-loading.webm')).toString('base64'), name: 'clip.webm' },
          { type: 'text', text: 'You can keep writing while the media loads.' },
        ],
      });
      const requested = new Set<number>();
      harness.core.router.register('messages.attachment', async params => {
        requested.add(params.partIndex);
        await pending;
        return readMessageAttachment(harness.core, params);
      });
      // Reopen after seeding, so the browser receives the compact history rather than a full live fixture.
      await page.send('Page.reload', {});
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      if (phone) await mobileAction(page, 'mobile-conversations');
      await page.click(phone ? `[data-testid="mobile-thread-${threadId}"]` : `[data-thread-id="${threadId}"]`);
      await page.waitFor(`document.querySelector('[data-mid="msg_waiting_media"]')?.textContent.includes('You can keep writing')`);
      await waitFor(() => requested.has(1) && requested.has(2));
      expect(await page.evaluate('!!document.querySelector("[data-testid=thread-loading]")')).toBe(false);
      expect(await page.evaluate('document.querySelector("[data-testid=artifact-copy]") === null && document.querySelector("video") === null')).toBe(true);
      await page.type('[data-testid=composer-input]', 'The text is already usable.');
      expect(await page.evaluate('document.querySelector("[data-testid=composer-input]").value')).toBe('The text is already usable.');
      await page.screenshot(join(import.meta.dir, '.artifacts', `media-loading-${phone ? 'phone' : 'desktop'}-waiting.png`));
      release();
      await page.waitFor('document.querySelector("[data-testid=artifact-copy]")?.naturalWidth > 0 && document.querySelector("video")?.videoWidth > 0');
      expect(await page.evaluate('document.querySelector("video").src.startsWith(location.origin + "/file/")')).toBe(true);
      expect(await page.evaluate('document.querySelector("video").paused && document.querySelector("video").preload === "metadata"')).toBe(true);
      await page.evaluate('(() => { const video = document.querySelector("video"); video.muted = true; return video.play(); })()');
      await page.waitFor('document.querySelector("video")?.currentTime > 0.1');
      await page.evaluate('(() => { const video = document.querySelector("video"); video.pause(); video.currentTime = 0.6; })()');
      await page.waitFor('document.querySelector("video")?.readyState >= 2 && !document.querySelector("video").seeking');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot(join(import.meta.dir, '.artifacts', `media-loading-${phone ? 'phone' : 'desktop'}-ready.png`));
      expect(page.errors()).toEqual([]);
    } finally {
      release();
      try { await page?.close(); } finally { await harness.stop(); }
    }
  }, 120_000);
}
