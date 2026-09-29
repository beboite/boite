import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

test('pasted images have linked references and a preview that leaves the composer usable', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.type('[data-testid=composer-input]', 'Compare these screens: ');
    for (const title of ['Checkout settings', 'Payment methods']) {
      await page.evaluate(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#edf2f7'; ctx.fillRect(0, 0, 960, 540);
        ctx.fillStyle = '#182534'; ctx.fillRect(0, 0, 220, 540);
        ctx.fillStyle = '#ffffff'; ctx.font = '24px sans-serif'; ctx.fillText('Store settings', 24, 50);
        ctx.font = '18px sans-serif'; ctx.fillText('General', 24, 120); ctx.fillText('Checkout', 24, 170);
        ctx.fillStyle = '#182534'; ctx.font = '32px sans-serif'; ctx.fillText(${JSON.stringify(title)}, 260, 65);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(260, 100, 650, 270);
        ctx.fillStyle = '#40556b'; ctx.font = '22px sans-serif'; ctx.fillText('Customer information', 290, 150);
        ctx.font = '18px sans-serif'; ctx.fillText('Email address', 290, 210); ctx.fillText('Shipping address', 290, 290);
        ctx.fillStyle = '#286dde'; ctx.fillRect(740, 405, 170, 60);
        ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif'; ctx.fillText('Save changes', 758, 442);
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'screen.png', { type: 'image/png' }));
        document.querySelector('[data-testid=composer-input]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      })()`);
      await page.waitFor(`document.querySelectorAll('[data-testid=composer-attachment]').length === ${title === 'Checkout settings' ? 1 : 2}`);
    }
    const capture = async (name: string) => {
      await page!.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
      await page!.screenshot(join(import.meta.dir, '.artifacts', name));
    };
    expect(await page.evaluate('document.querySelector("[data-testid=composer-input]").value')).toContain('[Image 1]');
    expect(await page.evaluate('document.querySelector("[data-testid=composer-input]").value')).toContain('[Image 2]');
    await page.click('[data-testid=composer-image-open]');
    await page.waitFor('document.querySelector("[data-testid=composer-image-preview] img")?.naturalWidth === 960');
    expect(await page.evaluate('document.activeElement === document.querySelector("[data-testid=composer-input]")')).toBe(true);
    await page.send('Input.insertText', { text: ' Check the save button.' });
    expect(await page.evaluate('document.querySelector("[data-testid=composer-input]").value')).toContain('Check the save button.');
    const firstImage = await page.evaluate('document.querySelector("[data-testid=composer-image-preview] img").src');
    await page.click('[data-testid=composer-attachment]:nth-child(2) [data-testid=composer-image-open]');
    await page.waitFor('document.querySelector("[data-testid=composer-image-preview]").textContent.includes("[Image 2]")');
    expect(await page.evaluate('document.querySelector("[data-testid=composer-image-preview] img").src')).not.toBe(firstImage);
    await page.click('[data-testid=composer-image-open]');
    for (const mobile of [false, true]) {
      if (mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.waitFor('document.querySelector("[data-testid=composer-input]").scrollHeight <= document.querySelector("[data-testid=composer-input]").clientHeight');
      await page.waitFor('parseFloat(document.querySelector("[data-testid=composer-highlight]").style.width) === document.querySelector("[data-testid=composer-input]").clientWidth');
      const point = await page.evaluate<{ x: number; y: number }>('(() => { const r = document.querySelector("[data-testid=composer-image-reference]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await page.waitFor('document.querySelector("[data-testid=composer-attachment]").classList.contains("highlighted")');
      expect(await page.evaluate('document.querySelectorAll("[data-testid=composer-attachment].highlighted").length')).toBe(1);
      expect(await page.evaluate('(() => { const preview = document.querySelector("[data-testid=composer-image-preview]").getBoundingClientRect(); const input = document.querySelector("[data-testid=composer-input]").getBoundingClientRect(); return preview.bottom <= input.top && input.bottom < innerHeight && preview.width <= innerWidth; })()')).toBe(true);
      await capture(`composer-images-${mobile ? 'phone' : 'desktop'}.png`);
      for (const selector of ['[data-testid=composer-input]', '[data-testid=composer-image-preview] img']) {
        const inside = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 }; })()`);
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...inside });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...inside });
        expect(await page.evaluate('document.querySelector("[data-testid=composer-image-preview]") !== null')).toBe(true);
      }
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: mobile ? 190 : 800, y: 160 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: mobile ? 190 : 800, y: 160 });
      await page.waitFor('!document.querySelector("[data-testid=composer-image-preview]")');
      expect(await page.evaluate('document.querySelector("[data-testid=composer-input]").value')).toContain('Check the save button.');
      await page.click('[data-testid=composer-image-open]');
      await page.waitFor('document.querySelector("[data-testid=composer-image-preview]")');
    }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await page.waitFor('!document.querySelector("[data-testid=composer-image-preview]")');
    const point = await page.evaluate<{ x: number; y: number }>('(() => { const r = document.querySelector("[data-testid=composer-image-reference]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await page.waitFor('document.querySelector("[data-testid=composer-image-preview]")');
    await page.click('[data-testid=composer-image-close]');
    await page.waitFor('!document.querySelector("[data-testid=composer-image-preview]")');
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close();
    await server.close();
  }
}, 90_000);
