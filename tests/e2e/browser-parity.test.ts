import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startBrowserSession } from './lib/browser-session.ts';
import { runCli } from '../../packages/core/src/cli.ts';
import type { BrowserDiagnostics } from '../../packages/contracts/src/index.ts';

const executable = process.env.BOITE_E2E_SHELL_EXE;
test.skipIf(process.platform !== 'win32' || !executable)('native presets, appearance, diagnostics, recording and chat publication work together', async () => {
  const fixture = readFileSync(join(import.meta.dir, 'fixtures/browser-parity.html'), 'utf8');
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(path === '/' ? fixture : 'Missing demo resource', { status: path === '/' ? 200 : 404, headers: { 'content-type': 'text/html;charset=utf-8' } });
  } });
  const session = await startBrowserSession(executable!);
  const { page, command } = session;
  const captures = join(import.meta.dir, '.artifacts'); mkdirSync(captures, { recursive: true });
  try {
    const opened = await command({ kind: 'open', url: site.url.href });
    const id = opened.tabId!;
    expect(id).toStartWith('browser:');
    expect(JSON.stringify(await command({ kind: 'snapshot' }, id))).toContain('ATELIER BOITE');
    await command({ kind: 'preset', preset: 'iphone-15-pro' }, id);
    expect((await command({ kind: 'evaluate', expression: '[innerWidth,innerHeight]' }, id)).value).toEqual([393, 852]);
    await command({ kind: 'preset', preset: 'iphone-15-pro', orientation: 'landscape' }, id);
    expect((await command({ kind: 'evaluate', expression: '[innerWidth,innerHeight]' }, id)).value).toEqual([852, 393]);
    for (const colorScheme of ['dark', 'light'] as const) {
      await command({ kind: 'appearance', colorScheme }, id);
      expect((await command({ kind: 'evaluate', expression: `matchMedia('(prefers-color-scheme: dark)').matches` }, id)).value).toBe(colorScheme === 'dark');
    }
    await command({ kind: 'reset-viewport' }, id);
    await command({ kind: 'appearance', colorScheme: 'system' }, id);
    console.log('Screen presets, orientation, theme and reset passed');
    await command({ kind: 'click', selector: '#diagnostic' }, id);
    await Bun.sleep(150);
    const diagnostics = (await command({ kind: 'diagnostics' }, id)).value as BrowserDiagnostics;
    expect(diagnostics.entries.some(e => e.kind === 'console' && e.text.includes('Diagnostic volontaire'))).toBe(true);
    expect(diagnostics.entries.some(e => e.kind === 'exception' && e.text.includes('Erreur volontaire'))).toBe(true);
    expect(diagnostics.entries.some(e => e.kind === 'network' && e.text.includes('404'))).toBe(true);
    expect(diagnostics.history.some(e => e.action === 'preset' && e.ok)).toBe(true);
    await command({ kind: 'type', selector: '#message', text: 'value-not-for-history' }, id);
    expect(JSON.stringify((await command({ kind: 'diagnostics' }, id)).value)).not.toContain('value-not-for-history');
    await command({ kind: 'diagnostics', clear: true }, id);
    expect((await command({ kind: 'diagnostics' }, id)).value).toEqual({ entries: [], dropped: 0, history: [] });
    console.log('Console, exception, network, history and clear passed');
    await command({ kind: 'recording-start' }, id);
    await expect(command({ kind: 'recording-start' }, id)).rejects.toThrow('already running');
    await command({ kind: 'click', selector: '#forest' }, id);
    await Bun.sleep(650);
    await command({ kind: 'type', selector: '#message', text: 'La vidéo fonctionne dans Boite !' }, id);
    await command({ kind: 'click', selector: '#send' }, id);
    await Bun.sleep(750);
    const lines: string[] = [];
    expect(await runCli(['browser', 'recording-stop', id, '--thread', session.threadId, '--data-dir', session.dataDir, '--json'], {
      cwd: session.projectDir, env: { BOITE_DATA_DIR: session.dataDir }, out: text => lines.push(text), err: text => { throw new Error(text); },
    })).toBe(0);
    const recorded = JSON.parse(lines.join('')) as { path: string; mime: string; bytes: number; durationMs: number };
    expect(recorded.bytes).toBeGreaterThan(1000); expect(recorded.durationMs).toBeGreaterThan(1000);
    // WebView2 encodes H.264 into MP4, which iPhones play; a desktop from before codecs made WebM without it.
    const extension = recorded.mime === 'video/mp4' ? 'mp4' : 'webm';
    expect(recorded.path.endsWith(`.${extension}`)).toBe(true);
    const bytes = readFileSync(recorded.path);
    if (extension === 'mp4') expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    else expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    writeFileSync(join(captures, `browser-parity-native.${extension}`), bytes);
    // A browser decodes the produced container, not just its magic bytes.
    const global = await page.send('Runtime.evaluate', { expression: 'globalThis' }) as { result: { objectId: string } };
    let decoded: { width: number; height: number; duration: number; seeked: number };
    try {
      const playback = await page.send('Runtime.callFunctionOn', {
        objectId: global.result.objectId,
        functionDeclaration: `function(base64, mime) { return new Promise((resolve, reject) => {
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          const video = document.createElement('video'), url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          const cleanup = () => { video.remove(); URL.revokeObjectURL(url); };
          video.onloadeddata = () => {
            video.onseeked = () => { resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration, seeked: video.currentTime }); cleanup(); };
            video.currentTime = video.duration / 2;
          };
          video.onerror = () => { cleanup(); reject(new Error('recording cannot play')); };
          video.src = url; video.load();
        }); }`,
        arguments: [{ value: bytes.toString('base64') }, { value: recorded.mime }],
        awaitPromise: true, returnByValue: true,
      }) as { result: { value: typeof decoded }; exceptionDetails?: unknown };
      expect(playback.exceptionDetails).toBeUndefined();
      decoded = playback.result.value;
    } finally { await page.send('Runtime.releaseObject', { objectId: global.result.objectId }); }
    expect(decoded.width).toBeGreaterThan(200); expect(decoded.height).toBeGreaterThan(200);
    expect(Number.isFinite(decoded.duration)).toBe(true); expect(decoded.seeked).toBeGreaterThan(0);
    console.log(`Native recording decoded: ${recorded.bytes} bytes, ${decoded.width}x${decoded.height}`);
    const turn = await session.client.call('turns.start', { threadId: session.threadId, prompt: 'Vidéo du test du navigateur' });
    for (let i = 0; i < 100; i++) { if ((await session.client.call('threads.get', { threadId: session.threadId })).turns.find(t => t.id === turn.id)?.status === 'done') break; await Bun.sleep(50); }
    expect(await runCli(['attach', recorded.path, '--thread', session.threadId, '--data-dir', session.dataDir, '--json'], { cwd: session.projectDir, env: { BOITE_DATA_DIR: session.dataDir }, out: () => {}, err: text => { throw new Error(text); } })).toBe(0);
    expect(JSON.stringify((await session.client.call('threads.get', { threadId: session.threadId })).messages)).toContain(recorded.mime);
    // Dismiss the review opened on stop, then exercise visible controls.
    await page.evaluate(`document.querySelector('[data-testid=browser-tools-dialog]')?.dispatchEvent(new Event('cancel'));true`);
    await page.click('[data-testid=browser-tools]');
    await page.click('[data-value="preset:ipad-mini"]');
    expect((await command({ kind: 'evaluate', expression: '[innerWidth,innerHeight]' }, id)).value).toEqual([768, 1024]);
    await page.click('[data-testid=browser-tools]'); await page.click('[data-value="appearance:dark"]');
    expect((await command({ kind: 'evaluate', expression: `matchMedia('(prefers-color-scheme: dark)').matches` }, id)).value).toBe(true);
    await page.click('[data-testid=browser-tools]'); await page.click('[data-value="diagnostics"]');
    await page.waitFor("document.querySelector('[data-testid=browser-tools-dialog][open]')");
    await page.screenshot(join(captures, 'browser-parity-diagnostics.png'));
    await page.evaluate(`document.querySelector('[data-testid=browser-tools-dialog]').dispatchEvent(new Event('cancel'));true`);
    await command({ kind: 'reset-viewport' }, id);
    // Closing an active recording must release it and leave a new tab usable.
    await command({ kind: 'recording-start' }, id); await command({ kind: 'close' }, id);
    await command({ kind: 'open', url: site.url.href });
    expect(JSON.stringify(await command({ kind: 'snapshot' }))).toContain('ATELIER BOITE');
    console.log('Visible controls and recording teardown passed');
    // A second conversation must leave the first page and its host available.
    const before = await command({ kind: 'status' });
    const tabId = (before.value as { tabs: { tabId: string }[] }).tabs[0]!.tabId;
    await command({ kind: 'evaluate', expression: 'globalThis.persistenceMarker = "same live page"' }, tabId);
    const original = await session.client.call('threads.get', { threadId: session.threadId });
    const other = await session.client.call('threads.create', { projectId: original.projectId!, providerId: original.providerId, accountId: original.accountId, title: 'Another conversation' });
    await page.waitFor(`document.querySelector('[data-testid=thread-row][data-thread-id="${other.id}"]')`);
    await page.click(`[data-testid=thread-row][data-thread-id="${other.id}"]`);
    await page.waitFor(`document.querySelector('[data-testid=thread-row][data-thread-id="${other.id}"]')?.closest('.thread')?.classList.contains('open')`);
    expect((await command({ kind: 'evaluate', expression: 'globalThis.persistenceMarker' }, tabId)).value).toBe('same live page');
    // Its tab is hidden now: WebView2 renders no frame, so native input would wait out the 15 s deadline.
    expect((await command({ kind: 'evaluate', expression: 'document.visibilityState' }, tabId)).value).toBe('hidden');
    const hiddenStart = Date.now();
    const refs = ((await command({ kind: 'snapshot', interactive: true }, tabId)).value as { text: string }).text;
    const ref = (line: string) => `@${new RegExp(`${line} \\[ref=(e\\d+)\\]`).exec(refs)?.[1]}`;
    await command({ kind: 'fill', selector: ref('textbox "Ton message"'), text: 'Depuis un onglet caché' }, tabId);
    await command({ kind: 'click', selector: ref('button "Afficher"') }, tabId);
    expect((await command({ kind: 'get', what: 'text', selector: '#result' }, tabId)).value).toContain('Depuis un onglet caché');
    expect(Date.now() - hiddenStart).toBeLessThan(5000);
    console.log(`Hidden tab snapshot, fill and click passed in ${Date.now() - hiddenStart} ms`);
    const background = await command({ kind: 'open', url: site.url.href });
    expect(JSON.stringify(await command({ kind: 'snapshot' }, background.tabId))).toContain('ATELIER BOITE');
    await command({ kind: 'close' }, background.tabId);
    await page.click(`[data-testid=thread-row][data-thread-id="${session.threadId}"]`);
    await page.waitFor(`document.querySelector('[data-testid=thread-row][data-thread-id="${session.threadId}"]')?.closest('.thread')?.classList.contains('open')`);
    expect((await command({ kind: 'evaluate', expression: 'globalThis.persistenceMarker' }, tabId)).value).toBe('same live page');
    console.log('Native background open, snapshot, close and live page persistence passed');
  } finally { await session.close(); site.stop(true); }
}, 120_000);
