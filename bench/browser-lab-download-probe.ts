import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { startTestCore } from '../packages/core/test/harness.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { createBrowserLabEngineTransportFix } from './browser-lab-transport-fix.ts';
import { LabPage } from './browser-lab-page.ts';
import { labTasks } from './browser-lab-tasks.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function connectCdp(url: string, events: any[], calls: any[]) {
  const socket = new WebSocket(url);
  let next = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Probe CDP closed.')); } pending.clear(); };
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method?.includes('download')) events.push({ at: Date.now(), ...message });
    const item = pending.get(message.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    calls.push({ id: message.id, response: message });
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  socket.addEventListener('close', fail);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Probe CDP connect timeout.')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Probe CDP connect failed.')); }, { once: true });
  });
  return {
    send(method: string, params: any, sessionId?: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++next, request = { id, method, params, ...(sessionId ? { sessionId } : {}) };
        calls.push(request);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Probe ${method} timeout.`)); }, 5000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify(request));
      });
    },
    close() { fail(); socket.close(); },
  };
}

export async function runDownloadProbe(output: string, binary: string) {
  if (process.platform !== 'win32') throw new Error('Windows path probe requires Windows.');
  mkdirSync(output, { recursive: true });
  const results: any[] = [];
  let releaseUrl = 'https://github.com/microsoft/playwright/releases/latest';
  for (const route of ['root', 'page'] as const) for (const pathForm of ['ordinary', 'extended'] as const) {
    const id = `${route}-${pathForm}`, directory = join(output, id), downloads = win32.resolve(directory, 'downloads');
    mkdirSync(downloads, { recursive: true });
    if (readdirSync(downloads).length) throw new Error('Fresh empty download directory required: ' + downloads);
    const commands: any[] = [], events: any[] = [], calls: any[] = [];
    const result: any = { id, route, pathForm, downloadPath: pathForm === 'extended' ? win32.toNamespacedPath(downloads) : downloads, concurrency: 'One unrelated model/browser lane may run concurrently; diagnostic only.' };
    const harness = await startTestCore();
    let engine: Awaited<ReturnType<typeof createBrowserLabEngineTransportFix>> | undefined;
    let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
    try {
      engine = await createBrowserLabEngineTransportFix('agent-browser', { core: harness.core, taskId: `download-path-${id}`, binary, executablePath: findBrowser(), log: entry => commands.push(entry) });
      result.engine = engine.metadata;
      await engine.command('evaluate', { script: '0', pinTab: true });
      await engine.command('viewport', { width: 1280, height: 800 });
      await engine.command('navigate', { url: releaseUrl, waitUntil: 'domcontentloaded' });
      const page = new LabPage(engine, labTasks.find(t => t.id === 'github-release-download')!, true, directory, performance.now() + 65_000);
      let zipRef: string | undefined;
      let toggledAssets = false;
      for (let attempt = 0; attempt < 12 && !zipRef; attempt++) {
        await page.observe('Assets');
        const observation = page.history.at(-1), snapshot = String(observation.snapshot.snapshot);
        if (!observation.state.url.includes('/releases/tag/')) throw new Error('Expected resolved release tag.');
        if (releaseUrl.endsWith('/latest')) releaseUrl = observation.state.url;
        result.releaseUrl = observation.state.url;
        if (result.releaseUrl !== releaseUrl) throw new Error('Release changed across variants.');
        zipRef = snapshot.split('\n').find(line => /link "Source code \(zip\)"/.test(line))?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
        if (!zipRef) {
          const assets = snapshot.split('\n').find(line => /button "Assets/.test(line));
          const ref = assets?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
          if (ref && !toggledAssets) {
            await engine.command('click', { selector: '@' + ref });
            if (assets?.includes('expanded=true')) {
              await page.observe('Assets');
              const current = String(page.history.at(-1).snapshot.snapshot).split('\n').find(line => /button "Assets/.test(line));
              const currentRef = current?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
              if (!currentRef) throw new Error('Assets ref vanished after closing.');
              await engine.command('click', { selector: '@' + currentRef });
            }
            toggledAssets = true;
          }
          await delay(250);
        }
      }
      if (!zipRef) throw new Error('Observed ZIP ref unavailable.');
      result.targetBefore = await engine.activeTargetId();
      cdp = await connectCdp(engine.cdpUrl, events, calls);
      // Attach identically in all four variants; only routing and path spelling vary.
      const session = await cdp.send('Target.attachToTarget', { targetId: result.targetBefore, flatten: true });
      result.sessionId = session.sessionId;
      await cdp.send('Page.enable', {}, session.sessionId);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: result.downloadPath, eventsEnabled: true }, route === 'page' ? session.sessionId : undefined);
      result.clickedRef = zipRef;
      await engine.command('click', { selector: '@' + zipRef });
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const begin = events.find(event => event.method.endsWith('downloadWillBegin'));
        const terminal = begin && events.find(event => event.method.endsWith('downloadProgress') && event.params.guid === begin.params.guid && ['completed', 'canceled'].includes(event.params.state));
        if (terminal) { result.begin = begin; result.terminal = terminal; break; }
        await delay(100);
      }
      result.targetAfter = await engine.activeTargetId();
      result.tabsAfter = await engine.command('tabs');
      await page.observe();
      result.finalCapture = page.history.at(-1).screenshot;
      result.files = readdirSync(downloads).map(name => {
        const path = join(downloads, name), bytes = readFileSync(path);
        return { name, bytes: statSync(path).size, header: bytes.subarray(0, 4).toString('hex'), sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      result.savedZip = result.files.some((file: any) => file.name === result.begin?.params.guid && file.bytes > 0 && file.header === '504b0304');
      result.terminalState = result.terminal?.params.state ?? 'no-matched-terminal-event';
    } catch (error) { result.error = error instanceof Error ? error.stack : String(error); }
    finally {
      try { cdp?.close(); await engine?.close(); }
      finally {
        result.processesAfter = engine ? harness.core.procs.liveCount(engine.processGroup) : null;
        try { await harness.stop(); } finally {
          writeFileSync(join(directory, 'commands.json'), JSON.stringify(commands, null, 2));
          writeFileSync(join(directory, 'cdp-calls.json'), JSON.stringify(calls, null, 2));
          writeFileSync(join(directory, 'download-events.json'), JSON.stringify(events, null, 2));
          writeFileSync(join(directory, 'summary.json'), JSON.stringify(result, null, 2));
          results.push(result);
          writeFileSync(join(output, 'summary.json'), JSON.stringify(results, null, 2));
          console.log(JSON.stringify({ id, state: result.terminalState, savedZip: result.savedZip, files: result.files, processesAfter: result.processesAfter, error: result.error }));
        }
      }
    }
  }
  return results;
}

if (import.meta.main) {
  if (process.env.BOITE_BENCH_DOWNLOAD_PROBE !== '1') throw new Error('Opt-in BOITE_BENCH_DOWNLOAD_PROBE=1 required.');
  const [output, binary] = process.argv.slice(2);
  if (!output || !binary) throw new Error('Expected output directory and native browser binary.');
  await runDownloadProbe(output, binary);
}
