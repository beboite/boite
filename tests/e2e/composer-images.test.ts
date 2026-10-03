import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

test('goals and loops accept pasted images in existing threads and drafts on desktop and phone', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    for (const [kind, phone, draft] of [['goal', false, false], ['goal', true, true], ['loop', true, false], ['loop', false, true]] as const) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone });
      await page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({store}) => {
        store.error = null;
        ${draft ? 'store.startDraft(store.projects[0].id);' : "await store.open('t-trace');"}
      })`);
      await page.waitFor('document.querySelector("[data-testid=composer-input]")');
      const prompt = kind === 'goal' ? '/goal Match the reference' : '/loop 2 Check the reference';
      await page.type('[data-testid=composer-input]', prompt);
      await page.evaluate(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
        const ctx = canvas.getContext('2d');
        const style = getComputedStyle(document.body);
        ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 240, 120);
        ctx.fillStyle = style.color; ctx.font = '24px sans-serif'; ctx.fillText('Reference image', 20, 68);
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'reference.png', {type:'image/png'}));
        document.querySelector('[data-testid=composer-input]').dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:transfer}));
      })()`);
      await page.waitFor('document.querySelector("[data-testid=composer-attachment]")');
      await page.click('[data-testid=composer-send]');
      await page.waitFor(`import('/src/lib/store.svelte.ts').then(({store}) => store.openThread?.activity?.${kind}?.status === 'complete')`);
      expect(await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => store.error)`)).toBeNull();
      const parts = await page.evaluate<unknown[][]>(`import('/src/lib/store.svelte.ts').then(({store}) => store.openThread.messages.filter(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text.includes('the reference') && p.activity?.kind === '${kind}')).map(m => m.parts.filter(p => p.type === 'image')))`);
      expect(parts).toHaveLength(kind === 'goal' ? 1 : 2);
      expect(parts[0]).toHaveLength(1);
      if (kind === 'loop') expect(parts[1]).toHaveLength(0);
      await page.waitFor('Array.from(document.querySelectorAll("[data-testid=image-part]")).some(img => img.naturalWidth === 240)');
      await page.evaluate('Array.from(document.querySelectorAll("[data-testid=image-part]")).at(-1).closest(".bubble").scrollIntoView({block:"start"})');
      await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
      await page.screenshot(join(import.meta.dir, '.artifacts', `image-${kind}-${phone ? 'phone' : 'desktop'}.png`));
    }
  } finally { await page?.close(); await server.close(); }
}, 60_000);

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
    expect(await page.evaluate('document.querySelector("[data-testid=composer-image-open]").textContent.trim()')).toBe('');
    expect(await page.evaluate('document.querySelector("[data-testid=composer-attachment]").title')).toContain('[Image 1]');
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
      const insidePoints = await page.evaluate<Array<{ x: number; y: number }>>(`Array.from(document.querySelectorAll('[data-testid=composer-input], [data-testid=composer-image-preview] img'), el => { const r = el.getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 }; })`);
      expect(insidePoints).toHaveLength(2);
      for (const inside of insidePoints) {
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
