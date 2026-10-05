import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { killProcessTreeAsync, removeDirectory } from './lib/cleanup.ts';
import { connect } from '../../packages/core/src/client.ts';
import { runCli } from '../../packages/core/src/cli.ts';
import type { BrowserAction } from '../../packages/contracts/src/index.ts';
const executable = process.env.BOITE_E2E_SHELL_EXE;
test.skipIf(process.platform !== 'win32' || !executable)('native browser fills its panel and floats inside the app without losing page state', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-e2e-browser-control-'));
  const projectDir = join(dataDir, 'project'); mkdirSync(projectDir);
  const captures = join(import.meta.dir, '.artifacts'); mkdirSync(captures, { recursive: true });
  const port = await freePort();
  const shell = Bun.spawn([executable!], { windowsHide: true, stdout: 'ignore', stderr: Bun.file(join(dataDir, 'shell.log')), env: {
    ...process.env, BOITE_DATA_DIR: dataDir, BOITE_DRAFTS_DIR: join(dataDir, 'drafts'), BOITE_SHELL_HIDDEN: '1', BOITE_CORE_RESIDENT: '0', BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_TELEMETRY_URL: '', BOITE_SHELL_DEBUG_PORT: String(port),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=* --mute-audio --use-angle=d3d11`,
  }});
  writeFileSync(join(dataDir, 'spawn.json'), JSON.stringify({ shell: shell.pid, port }));
  let page: BrowserPage | undefined, client: Awaited<ReturnType<typeof connect>> | undefined;
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Test du navigateur Boite</title><style>body{font:20px system-ui;background:#13252d;color:#eee;padding:48px}button,input{font:inherit;padding:12px;border-radius:10px}h1{color:#84e7c1}.card{padding:25px;border:1px solid #476570;border-radius:18px}</style><h1>Test dans Boite</h1><div class="card"><label for="name">Votre prénom</label> <input id="name" placeholder="Chris"><button id="hello" onclick="document.querySelector('#result').textContent='Bonjour '+document.querySelector('#name').value">Saluer</button><p id="result">Prêt pour le test</p></div></html>`, { headers: { 'content-type': 'text/html;charset=utf-8' } }); } });
  try {
    for (let i = 0; i < 200; i++) { try { const state = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')); client = await connect(`http://127.0.0.1:${state.port}`, state.token); break; } catch { await Bun.sleep(100); } }
    if (!client) throw new Error('core did not start');
    await client.call('telemetry.configure', { mode: 'off' });
    const project = await client.call('projects.add', { path: projectDir, name: 'Browser validation' });
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Browser validation' });
    page = await BrowserPage.attach(port);
    await page.waitFor("typeof window.__TAURI_INTERNALS__?.invoke === 'function'");
    // Switched off on this desktop first: the core must refuse the agent.
    await page.evaluate(`localStorage.setItem('boite.onboarding', JSON.stringify({version:6, at:Date.now()})); localStorage.setItem('boite.features', JSON.stringify({'agent-browser-control': false})); location.reload();`);
    await page.waitFor("document.querySelector('[data-testid=thread-row]')");
    await page.click('[data-testid=thread-row]');
    await page.waitFor("document.querySelector('[data-testid=timeline]')");
    await expect(client.call('browser.command', { threadId: thread.id, action: { kind: 'status' } })).rejects.toThrow('enable Agent browser control');
    // Back to the default, which lets the agent drive the tab.
    await page.evaluate(`localStorage.removeItem('boite.features'); location.reload();`);
    await page.waitFor("document.querySelector('[data-testid=thread-row]')");
    await page.click('[data-testid=thread-row]');
    await page.waitFor("document.querySelector('[data-testid=timeline]')");
    for (let i = 0; i < 120; i++) { try { await client.call('browser.command', { threadId: thread.id, action: { kind: 'status' } }); break; } catch (e) { if (i === 119) throw e; await Bun.sleep(100); } }
    console.log('Host registered');
    const opened = await client.call('browser.command', { threadId: thread.id, action: { kind: 'open', url: site.url.href } });
    const tabId = opened.tabId!;
    const command = (action: BrowserAction) => client!.call('browser.command', { threadId: thread.id, tabId, action });
    const invoke = (name: string, args: unknown) => page!.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
    const slot = () => page!.evaluate<{x: number; y: number; width: number; height: number}>(`document.querySelector('[data-testid=browser-slot]').getBoundingClientRect().toJSON()`);
    const panelRect = () => page!.evaluate<{x: number; y: number; width: number; height: number}>(`document.querySelector('[data-testid=right-panel]').getBoundingClientRect().toJSON()`);
    const center = (selector: string) => page!.evaluate<{x: number; y: number}>(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    const drag = async (selector: string, dx: number, dy: number) => {
      const point = await center(selector);
      await page!.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await page!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + dx, y: point.y + dy, button: 'left', buttons: 1 });
      await page!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + dx, y: point.y + dy, button: 'left', clickCount: 1 });
    };
    const fillsSlot = async () => {
      for (let i = 0; i < 100; i++) {
        const rect = await slot();
        const size = (await command({ kind: 'evaluate', expression: '[innerWidth,innerHeight]' })).value as number[];
        if (Math.abs(size[0]! - rect.width) < 2 && Math.abs(size[1]! - rect.height) < 2) return;
        if (i === 99) throw new Error(`page ${size} does not fill slot ${JSON.stringify(rect)}`);
        await Bun.sleep(40);
      }
    };
    await fillsSlot();
    const snap = (await command({ kind: 'snapshot', interactive: true })).value as { text: string };
    expect(snap.text).toContain('textbox "Votre prénom" [ref=e1]');
    expect(snap.text).toContain('button "Saluer" [ref=e2]');
    await expect(command({ kind: 'click', selector: '.does-not-exist' })).rejects.toThrow('exactly one element');
    await command({ kind: 'fill', selector: '@e1', text: 'Chr' });
    await command({ kind: 'type', selector: '@e1', text: 'is' });
    await command({ kind: 'click', selector: '@e2' });
    if ((await command({ kind: 'evaluate', expression: 'document.querySelector("#result").textContent' })).value !== 'Bonjour Chris') throw new Error('native input failed');
    const screenshot = await command({ kind: 'screenshot' });
    if (!screenshot.screenshot) throw new Error('no screenshot');
    writeFileSync(join(captures, 'native-browser-page.png'), Buffer.from(screenshot.screenshot.base64, 'base64'));
    console.log('Snapshot, native input, click, evaluation and screenshot passed');
    const lines: string[] = [];
    expect(await runCli(['browser', 'screenshot', tabId, '--thread', thread.id, '--data-dir', dataDir, '--json'], {
      cwd: projectDir, env: { BOITE_DATA_DIR: dataDir }, out: text => lines.push(text), err: text => { throw new Error(text); },
    })).toBe(0);
    const saved = JSON.parse(lines.join('')) as { path: string };
    expect(readFileSync(saved.path).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await command({ kind: 'resize', width: 390, height: 844 });
    expect((await command({ kind: 'evaluate', expression: '[innerWidth, innerHeight]' })).value).toEqual([390, 844]);
    await command({ kind: 'resize', width: 1920, height: 1080 });
    await command({ kind: 'evaluate', expression: `(() => { const b=document.createElement('button');b.id='edge';b.textContent='Corner';b.style.cssText='position:fixed;right:0;bottom:0;width:100px;height:50px';b.onclick=()=>document.body.dataset.edge='clicked';document.body.append(b);return true;})()` });
    await command({ kind: 'evaluate', expression: `document.addEventListener('pointerdown', e=>window.lastPointer={x:e.clientX,y:e.clientY,target:e.target.id});true` });
    await command({ kind: 'click', selector: '#edge' });
    const largeCapture = await command({ kind: 'screenshot' });
    writeFileSync(join(captures, 'native-browser-fitted.png'), Buffer.from(largeCapture.screenshot!.base64, 'base64'));
    expect((await command({ kind: 'evaluate', expression: 'document.body.dataset.edge' })).value).toBe('clicked');
    await command({ kind: 'reset-viewport' });
    await fillsSlot();
    const denied = await command({ kind: 'evaluate', expression: `window.__TAURI_INTERNALS__?.invoke ? window.__TAURI_INTERNALS__.invoke('core_endpoint').then(()=>'allowed', e=>String(e)) : 'unavailable'` });
    expect(denied.value).not.toBe('allowed');
    await page.click('[data-testid=browser-detach]');
    await page.waitFor(`document.querySelector('[data-testid=right-panel]').classList.contains('floating')`);
    await fillsSlot();
    expect(await invoke('plugin:window|get_all_windows', {})).toEqual(['main']);
    if ((await command({ kind: 'evaluate', expression: 'document.querySelector("#name").value' })).value !== 'Chris') throw new Error('detach lost form');
    await page.screenshot(join(captures, 'native-browser-floating.png'));
    expect(await page.evaluate(`document.querySelectorAll('[data-testid=panel-maximize],[data-testid=browser-maximize]').length`)).toBe(1);
    await page.click('[data-testid=panel-maximize]');
    await fillsSlot();
    const beforeResize = await slot();
    await page.click('[data-testid=panel-maximize]');
    await fillsSlot();
    expect((await slot()).width).toBeLessThan(beforeResize.width - 100);
    // Drag from the middle of the bar and from a tab label, away from the grip.
    for (const selector of ['[data-testid=panel-titlebar] .spacer', '[data-testid=panel-tab] .name']) {
      const before = await panelRect();
      await drag(selector, -40, 10);
      const after = await panelRect();
      expect(after.x).toBeCloseTo(before.x - 40, 0);
      expect(after.y).toBeCloseTo(before.y + 10, 0);
    }
    // Every edge/corner shrinks and grows while the opposite edges stay put.
    for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      const start = await panelRect();
      const dx = direction.includes('w') ? 24 : direction.includes('e') ? -24 : 0;
      const dy = direction.includes('n') ? 18 : direction.includes('s') ? -18 : 0;
      await drag(`[data-testid=panel-resize-${direction}]`, dx, dy);
      const small = await panelRect();
      expect(small.x).toBeCloseTo(start.x + (direction.includes('w') ? dx : 0), 0);
      expect(small.y).toBeCloseTo(start.y + (direction.includes('n') ? dy : 0), 0);
      expect(small.width).toBeCloseTo(start.width - Math.abs(dx), 0);
      expect(small.height).toBeCloseTo(start.height - Math.abs(dy), 0);
      await fillsSlot();
      await drag(`[data-testid=panel-resize-${direction}]`, -dx, -dy);
      const restored = await panelRect();
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(restored[key]).toBeCloseTo(start[key], 0);
      await fillsSlot();
    }
    // Check the native page's actual visibility as well as menu pointer targets.
    expect((await command({ kind: 'evaluate', expression: 'document.hidden' })).value).toBe(false);
    await page.click('[data-testid=panel-add]');
    await page.waitFor("document.querySelector('[data-testid=browser-overlay-preview]')?.naturalWidth > 0");
    expect((await command({ kind: 'evaluate', expression: 'document.hidden' })).value).toBe(true);
    expect(await page.evaluate(`(() => { const rows=[...document.querySelectorAll('[data-testid=panel-add-menu] [role=menuitem]')]; return rows.length>4 && rows.filter(row=>!row.disabled).every(row=>{const r=row.getBoundingClientRect();return row.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}); })()`)).toBe(true);
    await page.screenshot(join(captures, 'browser-floating-menu.png'));
    // Pick an item below the first row using pointer input, then return to the
    // original browser tab. This also checks that menus don't start a drag.
    const menuItem = await center('[data-testid=panel-add-menu] [data-value=files]');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...menuItem, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...menuItem, button: 'left', clickCount: 1 });
    await page.waitFor("document.querySelector('[data-testid=panel-tab][data-kind=files][aria-selected=true]')");
    await page.click(`[data-surface-id="${tabId}"][role=tab]`);
    await fillsSlot();
    await page.click('[data-testid=panel-add]');
    await page.waitFor("document.querySelector('[data-testid=browser-overlay-preview]')?.naturalWidth > 0");
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor("!document.querySelector('[data-testid=panel-add-menu]') && !document.querySelector('[data-testid=browser-overlay-preview]')");
    await fillsSlot();
    expect((await command({ kind: 'evaluate', expression: 'document.hidden' })).value).toBe(false);
    await drag('[data-testid=panel-titlebar] .spacer', -2000, -2000);
    const moved = await slot();
    expect(moved.x).toBeGreaterThanOrEqual(0); expect(moved.y).toBeGreaterThanOrEqual(0);
    await fillsSlot();
    await page.click('[data-testid=panel-dock]');
    await fillsSlot();
    if ((await command({ kind: 'evaluate', expression: 'document.querySelector("#result").textContent' })).value !== 'Bonjour Chris') throw new Error('dock lost DOM');
    console.log('All eight resize directions, title-bar dragging, native overlay menu, maximize and dock preserve the DOM');
    expect((await command({ kind: 'evaluate', expression: 'document.querySelector("#name").value' })).value).toBe('Chris');
    await page.click('[data-testid=panel-tab][data-kind=files] [data-testid=panel-tab-close]');
    await page.click('[data-testid=browser-detach]');
    await command({ kind: 'close' });
    const status = await client.call('browser.command', { threadId: thread.id, action: { kind: 'status' } });
    expect((status.value as { tabs: unknown[] }).tabs).toEqual([]);
    // The last browser tab can close while the panel remains floating.
    await page.waitFor("document.querySelector('[data-testid=panel-dock]')");
    await page.click('[data-testid=panel-dock]');
    expect(await page.evaluate("document.querySelector('[data-testid=right-panel]').classList.contains('floating')")).toBe(false);
    // Capture the chrome and embedded page together with the shell's fake browser surface.
    // The native webview above has its own compositor and is captured separately.
    await page.evaluate(`location.search='?fake=1&open=recent';true`);
    await page.waitFor("document.querySelector('[data-testid=thread-row]')");
    await page.click('[data-testid=thread-row]');
    await page.waitFor("document.querySelector('[data-testid=timeline]')");
    if (!await page.evaluate("!!document.querySelector('[data-testid=right-panel]')")) await page.click('[data-testid=panel-toggle]');
    await page.waitFor("document.querySelector('[data-testid=launch-browser]')");
    await page.click('[data-testid=launch-browser]');
    await page.waitFor("document.querySelector('iframe[data-browser-id]')");
    await page.evaluate(`document.querySelector('iframe[data-browser-id]').srcdoc=${JSON.stringify(await (await fetch(site.url)).text())};true`);
    await page.click('[data-testid=browser-detach]');
    await page.waitFor("document.querySelector('[data-testid=right-panel]').classList.contains('floating')");
    await Bun.sleep(100);
    await page.screenshot(join(captures, 'browser-floating-desktop.png'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await page.waitFor("innerWidth === 390 && document.querySelector('[data-testid=right-panel]').getBoundingClientRect().width <= 390");
    await Bun.sleep(100);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot(join(captures, 'browser-floating-phone.png'));
    console.log('PASS', dataDir);
  } finally {
    client?.close(); await page?.close(); site.stop(true);
    if (shell.exitCode === null) await killProcessTreeAsync(shell.pid);
    await removeDirectory(dataDir);
  }
}, 60000);
