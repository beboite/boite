import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startBrowserSession } from './lib/browser-session.ts';
import { runCli } from '../../packages/core/src/cli.ts';
import type { BrowserDiagnostics } from '../../packages/contracts/src/index.ts';

const executable = process.env.BOITE_E2E_SHELL_EXE;
test.skipIf(process.platform !== 'win32' || !executable)('in the desktop app, the agent browser presets, appearance, diagnostics, recording and chat publication work together', async () => {
  const fixture = readFileSync(join(import.meta.dir, 'fixtures/browser-parity.html'), 'utf8');
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(path === '/' ? fixture : 'Missing demo resource', { status: path === '/' ? 200 : 404, headers: { 'content-type': 'text/html;charset=utf-8' } });
  } });
  const session = await startBrowserSession(executable!);
  const { page, command } = session;
  const captures = join(import.meta.dir, '.artifacts'); mkdirSync(captures, { recursive: true });
  // What the core logged, kept for a failure: the hosted tabs run through the app, out of the test's sight.
  const logs: string[] = [];
  const offLogs = session.client.on('core.log', entry => { logs.push(`${new Date(entry.at).toISOString()} ${entry.level} ${entry.message}`); });
  try {
    // The app attaches as the host once it has connected to its core.
    for (let i = 0; i < 200 && !((await command({ kind: 'status' })).value as { hosted?: boolean }).hosted; i++) await Bun.sleep(100);
    // A sign-in the core kept while the app was closed: the first hosted tab hands it to the app's profile.
    const cookieFile = join(session.dataDir, 'browser', 'default', 'boite-cookies.json');
    mkdirSync(dirname(cookieFile), { recursive: true });
    writeFileSync(cookieFile, JSON.stringify([{ name: 'kept', value: 'by-core', domain: '127.0.0.1', path: '/' }]));
    const opened = await command({ kind: 'open', url: site.url.href });
    const id = opened.tabId!;
    expect(id).toStartWith('browser:');
    // The desktop app hosts its own core's agent browser: the tab is one of its webviews.
    const tabs = ((await command({ kind: 'status' })).value as { tabs: { tabId: string; view?: string }[] }).tabs;
    expect(tabs.find(tab => tab.tabId === id)?.view).toStartWith('agent-');
    console.log('The agent tab is a webview of the desktop app');
    expect((await command({ kind: 'evaluate', expression: 'document.cookie' }, id)).value).toContain('kept=by-core');
    await command({ kind: 'evaluate', expression: "document.cookie = 'login=hosted; max-age=3600'" }, id);
    await command({ kind: 'navigate', url: site.url.href }, id);
    const saved = () => { try { return readFileSync(cookieFile, 'utf8'); } catch { return ''; } };
    for (let i = 0; i < 100 && !saved().includes('hosted'); i++) await Bun.sleep(100);
    expect(saved()).toContain('"login"');
    console.log('Saved sign-ins reach the hosted tab, and its own reach the core');
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
    // The core's browser encodes H.264 into MP4, which iPhones play.
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
    console.log(`Recording decoded: ${recorded.bytes} bytes, ${decoded.width}x${decoded.height}`);
    const turn = await session.client.call('turns.start', { threadId: session.threadId, prompt: 'Vidéo du test du navigateur' });
    for (let i = 0; i < 100; i++) { if ((await session.client.call('threads.get', { threadId: session.threadId })).turns.find(t => t.id === turn.id)?.status === 'done') break; await Bun.sleep(50); }
    expect(await runCli(['attach', recorded.path, '--thread', session.threadId, '--data-dir', session.dataDir, '--json'], { cwd: session.projectDir, env: { BOITE_DATA_DIR: session.dataDir }, out: () => {}, err: text => { throw new Error(text); } })).toBe(0);
    expect(JSON.stringify((await session.client.call('threads.get', { threadId: session.threadId })).messages)).toContain(recorded.mime);
    // Closing an active recording must release it and leave a new tab usable.
    await command({ kind: 'recording-start' }, id); await command({ kind: 'close' }, id);
    await command({ kind: 'open', url: site.url.href });
    expect(JSON.stringify(await command({ kind: 'snapshot' }))).toContain('ATELIER BOITE');
    console.log('Recording teardown passed');
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
    const background = await command({ kind: 'open', url: site.url.href });
    expect(JSON.stringify(await command({ kind: 'snapshot' }, background.tabId))).toContain('ATELIER BOITE');
    await command({ kind: 'close' }, background.tabId);
    await page.click(`[data-testid=thread-row][data-thread-id="${session.threadId}"]`);
    await page.waitFor(`document.querySelector('[data-testid=thread-row][data-thread-id="${session.threadId}"]')?.closest('.thread')?.classList.contains('open')`);
    expect((await command({ kind: 'evaluate', expression: 'globalThis.persistenceMarker' }, tabId)).value).toBe('same live page');
    console.log('Background open, snapshot, close and live page persistence passed');
  } catch (error) {
    let shell = '';
    try { shell = readFileSync(join(session.dataDir, 'shell.log'), 'utf8'); } catch { /* no shell output */ }
    writeFileSync(join(captures, 'browser-parity-logs.txt'), `core:\n${logs.join('\n')}\n\nshell:\n${shell}`);
    throw error;
  } finally { offLogs(); await session.close(); site.stop(true); }
}, 120_000);
