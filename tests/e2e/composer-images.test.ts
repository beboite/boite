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
    const tab = page;
    const pointIn = (selector: string) => tab.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 }; })()`);
    const press = async (point: { x: number; y: number }) => {
      await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
    for (const mobile of [false, true]) {
      if (mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.waitFor('document.querySelector("[data-testid=composer-input]").scrollHeight <= document.querySelector("[data-testid=composer-input]").clientHeight');
      await page.waitFor('document.querySelector("[data-testid=composer-highlight]").getBoundingClientRect().width === document.querySelector("[data-testid=composer-input]").getBoundingClientRect().width - parseFloat(document.querySelector("[data-testid=composer-highlight]").style.right)');
      const point = await page.evaluate<{ x: number; y: number }>('(() => { const r = document.querySelector("[data-testid=composer-image-reference]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await page.waitFor('document.querySelector("[data-testid=composer-attachment]").classList.contains("highlighted")');
      expect(await page.evaluate('document.querySelectorAll("[data-testid=composer-attachment].highlighted").length')).toBe(1);
      expect(await page.evaluate('(() => { const preview = document.querySelector("[data-testid=composer-image-preview]").getBoundingClientRect(); const input = document.querySelector("[data-testid=composer-input]").getBoundingClientRect(); return preview.bottom <= input.top && input.bottom < innerHeight && preview.width <= innerWidth; })()')).toBe(true);
      await capture(`composer-images-${mobile ? 'phone' : 'desktop'}.png`);
      // Typing room keeps the preview open.
      await press(await pointIn('[data-testid=composer-input]'));
      expect(await page.evaluate('document.querySelector("[data-testid=composer-image-preview]") !== null')).toBe(true);
      // The press outside lands in the thread's last answers only while the list keeps to its bottom.
      const outside = { x: mobile ? 190 : 800, y: 160 };
      expect(await page.evaluate(`(() => {
        const list = document.querySelector('[data-testid=timeline]'), target = document.elementFromPoint(${outside.x}, ${outside.y});
        return { gap: list.scrollHeight - list.clientHeight - list.scrollTop <= 1 ? 0 : [list.scrollHeight, list.clientHeight, list.scrollTop],
          jump: !!document.querySelector('[data-testid=jump-to-latest]'),
          target: list.contains(target) && !target.closest('button, a, [tabindex], [data-role=user]') ? 'inert' : target?.outerHTML.slice(0, 120) };
      })()`)).toEqual({ gap: 0, jump: false, target: 'inert' });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...outside });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...outside });
      await page.waitFor('!document.querySelector("[data-testid=composer-image-preview]")');
      expect(await page.evaluate('document.querySelector("[data-testid=composer-input]").value')).toContain('Check the save button.');
      await page.click('[data-testid=composer-image-open]');
      await page.waitFor('document.querySelector("[data-testid=composer-image-preview]")');
    }
    // The enlarged picture puts itself away on a click, the way its tile opened it.
    await press(await pointIn('[data-testid=composer-image-preview] img'));
    await page.waitFor('!document.querySelector("[data-testid=composer-image-preview]")');
    await page.click('[data-testid=composer-image-open]');
    await page.waitFor('document.querySelector("[data-testid=composer-image-preview]")');
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

test('the list keeps to its bottom when the image preview closes and opens again before the next frame', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
      canvas.getContext('2d').fillRect(0, 0, 960, 540);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'screen.png', { type: 'image/png' }));
      document.querySelector('[data-testid=composer-input]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    })()`);
    await page.waitFor('document.querySelector("[data-testid=composer-attachment]")');
    const bottom = 'document.querySelector("[data-testid=timeline]").scrollHeight - document.querySelector("[data-testid=timeline]").clientHeight - document.querySelector("[data-testid=timeline]").scrollTop';
    await page.click('[data-testid=composer-image-open]');
    await page.waitFor(`document.querySelector("[data-testid=composer-image-preview] img")?.naturalWidth === 960 && document.querySelector("[data-testid=timeline]").scrollTop > 0 && ${bottom} <= 1`);
    // The preview leaves at the end of its animation, the taller list clamps its scroll in that frame's layout and
    // follows it there; the reopen lands before the next frame delivers the clamp's scroll event, as a test's next
    // command or a click near the animation's end can.
    const reopened = await page.evaluate<number>(`new Promise(resolve => {
      const list = document.querySelector('[data-testid=timeline]');
      const grown = new ResizeObserver(() => {
        if (document.querySelector('[data-testid=composer-image-preview]')) return;
        grown.disconnect();
        const clamped = list.scrollTop;
        document.querySelector('[data-testid=composer-image-open]').click();
        resolve(clamped);
      });
      grown.observe(list);
      document.querySelector('[data-testid=composer-image-close]').click();
    })`);
    expect(reopened).toBe(0);
    await page.waitFor('document.querySelector("[data-testid=composer-image-preview]")');
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    expect(await page.evaluate(`({ bottom: ${bottom} <= 1, jump: !!document.querySelector('[data-testid=jump-to-latest]') })`)).toEqual({ bottom: true, jump: false });
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close();
    await server.close();
  }
}, 60_000);

test('the paint layer breaks lines where the box does at a fractional width', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    // A command keeps the paint layer over the box, as an image reference does.
    await page.type('[data-testid=composer-input]', '/goal');
    await page.waitFor('document.querySelector("[data-testid=composer-highlight]")');
    // A line exactly as wide as the box's text area, the box a fraction of a pixel past a whole one.
    // A paint layer given the box's clientWidth, rounded down, broke that line and the caret trailed the painted text.
    const lines = await page.evaluate<{ widths: number[]; box: number; paint: number; paintWidth: number; boxWidth: number }>(`(async () => {
      const box = document.querySelector('[data-testid=composer-input]'), wrap = box.parentElement, paint = document.querySelector('.input-paint');
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const style = getComputedStyle(box), padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const write = async (value) => { box.value = value; box.dispatchEvent(new Event('input', { bubbles: true })); await frame(); };
      const count = (height) => Math.round((height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight));
      const words = 'qui est en retard parfois quand on écrit et que ça descend à la ligne'.split(' ');
      const widths = [];
      for (let used = 3; used <= words.length; used++) {
        await write('/goal ' + words.slice(0, used).join(' '));
        const range = document.createRange(); range.selectNodeContents(paint);
        const right = Math.max(...Array.from(range.getClientRects(), rect => rect.right));
        const needed = right - paint.getBoundingClientRect().left + parseFloat(style.paddingRight);
        widths.push(needed);
        if (needed % 1 < 0.05 || needed % 1 > 0.4) continue;
        wrap.style.width = (needed + 0.05) + 'px';
        await frame();
        return { widths, box: count(box.scrollHeight), paint: count(paint.offsetHeight), paintWidth: paint.getBoundingClientRect().width, boxWidth: box.getBoundingClientRect().width - (box.offsetWidth - box.clientWidth) };
      }
      return { widths, box: 0, paint: 0, paintWidth: 0, boxWidth: 0 };
    })()`);
    expect(lines.box, `no line ended in the first half of a pixel: ${lines.widths.join(', ')}`).toBe(1);
    expect(lines.paint).toBe(1);
    expect(lines.paintWidth).toBe(lines.boxWidth);
  } finally { await page?.close(); await server.close(); }
}, 60_000);

test('a full attachment strip stays one row and folds the rest behind a +N tile', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.evaluate(`(async () => {
      const transfer = new DataTransfer();
      for (let at = 0; at < 8; at++) {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'hsl(' + at * 40 + ' 55% 45%)'; ctx.fillRect(0, 0, 320, 200);
        ctx.fillStyle = '#ffffff'; ctx.font = '96px sans-serif'; ctx.fillText(String(at + 1), 130, 135);
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        transfer.items.add(new File([blob], 'shot-' + (at + 1) + '.png', { type: 'image/png' }));
      }
      document.querySelector('[data-testid=composer-input]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    })()`);
    const tiles = '[data-testid=composer-attachment], [data-testid=composer-attachments-more], [data-testid=composer-attachments-less]';
    const rows = `new Set(Array.from(document.querySelectorAll('${tiles}'), el => el.offsetTop)).size`;
    const capture = async (name: string) => {
      await page!.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
      await page!.screenshot(join(import.meta.dir, '.artifacts', name));
    };
    await page.waitFor('document.querySelectorAll("[data-testid=composer-attachment]").length === 8');
    expect(await page.evaluate(rows)).toBe(1);
    expect(await page.evaluate('document.querySelector("[data-testid=composer-attachments-more]")')).toBeNull();
    await capture('composer-strip-desktop.png');

    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.waitFor('document.querySelector("[data-testid=composer-attachments-more]")');
    const shown = await page.evaluate<number>('document.querySelectorAll("[data-testid=composer-attachment]").length');
    expect(shown).toBeLessThan(8);
    expect(await page.evaluate('document.querySelector("[data-testid=composer-attachments-more]").textContent.trim()')).toBe(`+${8 - shown}`);
    expect(await page.evaluate(rows)).toBe(1);
    await capture('composer-strip-phone.png');
    expect(await page.evaluate('(() => { const strip = document.querySelector("[data-testid=composer-attachments]").getBoundingClientRect(); const more = document.querySelector("[data-testid=composer-attachments-more]").getBoundingClientRect(); return more.right <= strip.right; })()')).toBe(true);

    await page.click('[data-testid=composer-attachments-more]');
    await page.waitFor('document.querySelectorAll("[data-testid=composer-attachment]").length === 8');
    expect(await page.evaluate(rows)).toBeGreaterThan(1);
    await capture('composer-strip-phone-open.png');
    await page.click('[data-testid=composer-attachments-less]');
    await page.waitFor(`document.querySelectorAll("[data-testid=composer-attachment]").length === ${shown}`);

    // Sent, the eight keep to one row of thumbnails in the bubble, the rest behind a +N over the last one.
    await page.type('[data-testid=composer-input]', 'Eight screens');
    await page.click('[data-testid=composer-send]');
    const bubble = 'Array.from(document.querySelectorAll("[data-testid=message-images]")).at(-1)';
    // The rows a reader sees: the live thumbnails and the one dimmed under the +N.
    const sentRows = `(() => {
      const row = ${bubble};
      const more = row.querySelector('[data-testid=message-images-more]');
      const shots = [...row.querySelectorAll('.shot')];
      const covered = (shot) => more && shot.offsetTop === shots[0].offsetTop && shot.offsetLeft === more.offsetLeft;
      return new Set(shots.filter(shot => !shot.inert || covered(shot)).map(shot => shot.offsetTop)).size;
    })()`;
    await page.waitFor(`${bubble}?.querySelectorAll('[data-testid=image-open]').length === 8 && ${bubble}.querySelector('[data-testid=message-images-more]')`);
    await page.evaluate(`${bubble}.scrollIntoView({ block: 'center' })`);
    const sent = await page.evaluate<{ fits: number; more: string; height: number }>(`(() => {
      const row = ${bubble};
      return { fits: row.querySelectorAll('.shot:not([inert])').length, more: row.querySelector('[data-testid=message-images-more]').textContent.trim(), height: row.getBoundingClientRect().height };
    })()`);
    expect(sent.fits).toBeLessThan(8);
    expect(sent.more).toBe(`+${8 - sent.fits}`);
    // The tile under the +N is inert like the wrapped ones, so the keyboard never lands behind the cover.
    expect(await page.evaluate<boolean>(`(() => {
      const row = ${bubble};
      const more = row.querySelector('[data-testid=message-images-more]');
      const shots = [...row.querySelectorAll('.shot')];
      const under = shots.find(shot => shot.offsetTop === shots[0].offsetTop && shot.offsetLeft === more.offsetLeft);
      return !!under && under.inert;
    })()`)).toBe(true);
    expect(sent.height).toBeLessThan(100);
    expect(await page.evaluate(sentRows)).toBe(1);
    await capture('message-images-phone.png');
    await page.click('[data-testid=message-images-more]');
    await page.waitFor(`${bubble}.querySelectorAll('.shot:not([inert])').length === 8 && !${bubble}.querySelector('[data-testid=message-images-more]')`);
    expect(await page.evaluate(sentRows)).toBeGreaterThan(1);
    await capture('message-images-phone-open.png');
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close();
    await server.close();
  }
}, 90_000);

test('fifty pasted screenshots fit one turn, shown on desktop and phone', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.type('[data-testid=composer-input]', 'Fifty problems, one screenshot each ');
    // Phone and desktop captures of a chat, noisy enough to weigh a few MB as PNG, all in one paste.
    await page.evaluate(`(async () => {
      const transfer = new DataTransfer();
      for (let at = 0; at < 50; at++) {
        const phone = at % 2 === 0;
        const canvas = document.createElement('canvas'); canvas.width = phone ? 1170 : 2560; canvas.height = phone ? 2532 : 1440;
        const ctx = canvas.getContext('2d');
        const pixels = ctx.createImageData(canvas.width, canvas.height);
        let state = at + 1;
        for (let i = 0; i < pixels.data.length; i += 4) {
          state = (state * 1103515245 + 12345) & 0x7fffffff;
          const shade = 215 + ((state >> 16) % 20);
          pixels.data[i] = shade - at; pixels.data[i + 1] = shade; pixels.data[i + 2] = shade + 10; pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        ctx.fillStyle = 'hsl(' + (at * 37) % 360 + ' 60% 45%)'; ctx.fillRect(0, 0, canvas.width, 120);
        ctx.fillStyle = '#182534'; ctx.font = '48px sans-serif';
        for (let line = 0; line < 30; line++) ctx.fillText('Problem ' + (at + 1) + ': the list jumps when line ' + line + ' loads', 40, 220 + line * 70);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        transfer.items.add(new File([blob], (phone ? 'IMG_' : 'Screenshot ') + at + '.png', { type: 'image/png' }));
        canvas.width = 0; canvas.height = 0;
      }
      document.querySelector('[data-testid=composer-input]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    })()`, 180_000);
    const heldNow = `import('/src/lib/store.svelte.ts').then(({ store }) => {
      const state = Object.values(store.composerStates).find(one => one.attachments.length > 0);
      return { count: state?.attachments.length ?? 0, total: state?.attachments.reduce((sum, one) => sum + Math.floor(one.data.length * 3 / 4), 0) ?? 0, error: store.error };
    })`;
    await page.waitFor(`${heldNow}.then(held => held.count === 50 || held.error)`, 240_000);
    const held = await page.evaluate<{ count: number; total: number; error: string | null }>(heldNow);
    expect(held.error).toBeNull();
    expect(held.count).toBe(50);
    expect(held.total).toBeLessThanOrEqual(10 * 1024 * 1024);
    for (const phone of [false, true]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone });
      // The strip folds past one row; opened, it shows all fifty.
      if (await page.evaluate('!!document.querySelector("[data-testid=composer-attachments-more]")')) await page.click('[data-testid=composer-attachments-more]');
      await page.waitFor('document.querySelectorAll("[data-testid=composer-attachment]").length === 50');
      // Opened, fifty tiles scroll in the strip: the box and the bar stay on screen.
      expect(await page.evaluate<boolean>('document.querySelector("[data-testid=composer-send]").getBoundingClientRect().bottom <= innerHeight')).toBe(true);
      await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
      await page.screenshot(join(import.meta.dir, '.artifacts', `fifty-images-${phone ? 'phone' : 'desktop'}.png`));
    }
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); await server.close(); }
}, 600_000);
