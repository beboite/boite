// Frames a second a paired phone gets from the desktop's browser tab, end to
// end through a scratch core: a phone client asks `browser.remoteFrame` on the
// viewer's schedule, the core relays it to a desktop host, which captures a
// moving page in headless Chrome and shrinks it as browser-remote-host.ts does.
// Latency is added on the phone's side, half before and half after each call;
// bandwidth is not limited. The page animates, so no frame is unchanged.
//
//   bun bench/remote-browser-frames.ts [--seconds 8] [--rtt 0,80,200]
//
// "before" is the schedule up to 2026-10-03: a fixed 300 ms pause after each
// frame and a q90 capture before shrinking. "after" is nextPollDelay from
// remote-browser-view.ts and the q75 capture.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findBrowser, freePort } from '../tests/e2e/lib/cdp.ts';
import { connect } from '../packages/core/src/client.ts';
import { nextPollDelay, type PollState } from '../packages/ui/src/lib/remote-browser-view.ts';

const { values } = parseArgs({ options: { seconds: { type: 'string', default: '8' }, rtt: { type: 'string', default: '0,80,200' } } });
const seconds = Number(values.seconds), rtts = values.rtt.split(',').map(Number);
const root = join(import.meta.dir, '..');
const before = ({ roundTrip, unchanged, failures }: PollState) => {
  if (failures > 0) return Math.min(8000, 1200 * 2 ** Math.min(3, failures - 1));
  const base = roundTrip > 600 ? 500 : 300;
  return unchanged >= 10 ? Math.max(base, 1500) : unchanged >= 3 ? Math.max(base, 800) : base;
};

// shrinkFrame as the desktop runs it, taken from its source.
const source = readFileSync(join(root, 'packages/ui/src/lib/browser-remote-host.ts'), 'utf8');
const pick = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)) + end.length);
const shrinkSource = new Bun.Transpiler({ loader: 'ts' }).transformSync(pick('export function remoteWidth', '\n}\n').replace('export ', '') + pick('async function shrinkFrame', '  } finally { bitmap.close(); }\n}\n'));

const words = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua '.repeat(6);
const page = `<!doctype html><meta charset=utf-8><title>bench</title><style>body{font:16px system-ui;margin:0;padding:24px;background:#fafafa;color:#222}
.hero{height:320px;background:radial-gradient(circle at 30% 40%,#f7c,#38f 40%,#123 80%);border-radius:12px}
.card{display:inline-block;width:340px;margin:10px;padding:12px;background:white;box-shadow:0 2px 8px #0002;vertical-align:top}
.spin{width:80px;height:80px;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(1turn)}}</style>
<div class=hero></div><div class=spin></div><h1>Résultats de recherche</h1>${Array.from({ length: 12 }, (_, i) => `<div class=card><h3>Carte ${i}</h3><p>${words}</p><input placeholder="Champ ${i}"><button>Valider</button></div>`).join('')}`;

const dataDir = mkdtempSync(join(tmpdir(), 'boite-remote-frames-'));
const profile = mkdtempSync(join(tmpdir(), 'boite-remote-frames-chrome-'));
const port = await freePort();
const chrome = Bun.spawn([findBrowser(), '--headless=new', '--mute-audio', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--window-size=1200,1300', '--force-device-scale-factor=1.5', 'about:blank'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
const core = Bun.spawn([process.execPath, join(root, 'packages/core/src/main.ts'), '--port', '0', '--data-dir', dataDir], { stdout: 'ignore', stderr: 'ignore', windowsHide: true, env: { ...process.env, BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_CORE_RESIDENT: '0', BOITE_TELEMETRY_URL: '' } });
const closers: (() => void)[] = [];
try {
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 100 && !target; i++) { await Bun.sleep(100); target = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).then((l: { type: string; webSocketDebuggerUrl: string }[]) => l.find(t => t.type === 'page')).catch(() => undefined); }
  const ws = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  closers.push(() => ws.close());
  let id = 0; const waiting = new Map<number, (v: any) => void>();
  ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id) waiting.get(m.id)?.(m.result ?? m.error); });
  const send = (method: string, params: object = {}) => new Promise<any>(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page) });
  await Bun.sleep(800);
  await send('Runtime.evaluate', { expression: `${shrinkSource.replace(/^async function shrinkFrame/m, 'window.shrinkFrame = async function')};true` });

  let owner: Awaited<ReturnType<typeof connect>> | undefined;
  for (let i = 0; i < 200 && !owner; i++) {
    try { const state = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')); owner = await connect(`http://127.0.0.1:${state.port}`, state.token); }
    catch { await Bun.sleep(100); }
  }
  if (!owner) throw new Error('the scratch core did not start');
  const host = owner, url = `http://127.0.0.1:${JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).port}`;
  closers.push(() => host.close());
  const project = await host.call('projects.add', { path: dataDir, name: 'bench' });
  const account = (await host.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const thread = await host.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'bench' });
  await host.call('threads.subscribe', { threadId: thread.id });
  // The desktop renews its 35 s lease, as browser-host.ts does.
  const lease = () => host.call('browser.host', { threadId: thread.id, enabled: true, allowAgentControl: false, remote: true, live: true });
  await lease();
  const renew = setInterval(() => void lease(), 10_000);
  closers.push(() => clearInterval(renew));

  let intermediate = 90; const hostTimes: number[] = [];
  host.on('browser.requested', request => void (async () => {
    const action = request.action as { kind: string; maxWidth?: number; quality?: number };
    if (action.kind !== 'remote-frame') return void host.call('browser.complete', { requestId: request.requestId, error: 'bench host only captures' });
    const started = performance.now(), quality = action.quality ?? 55;
    const info = '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio||1})';
    const shown = (await send('Runtime.evaluate', { expression: info, returnByValue: true })).result.value;
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: intermediate, captureBeyondViewport: false });
    await send('Runtime.evaluate', { expression: info, returnByValue: true });
    const base64 = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `shrinkFrame(${JSON.stringify(shot.data)}, ${action.maxWidth ?? 780}, ${quality})` })).result.value as string;
    hostTimes.push(performance.now() - started);
    await host.call('browser.complete', { requestId: request.requestId, result: { tabId: 'browser:bench', frame: { id: crypto.randomUUID(), tabId: 'browser:bench', title: 'bench', width: shown.width, height: shown.height, base64, at: Date.now() } } });
  })());

  const { grant } = await host.call('pairing.grant', {});
  const phone = await connect(url, '', { grant, client: { name: 'pwa', version: 'bench' } });
  closers.push(() => phone.close());
  await phone.call('threads.subscribe', { threadId: thread.id });

  const median = (a: number[]) => a.length ? Math.round([...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!) : 0;
  console.log(`remote-browser-frames ${new Date().toISOString()} Bun ${Bun.version}, headless Chrome 1200x1300 CSS at dpr 1.5, frames shrunk to 780 px, ${seconds} s per run`);
  for (const rtt of rtts) {
    for (const [name, schedule, q] of [['before', before, 90], ['after', nextPollDelay, 75]] as const) {
      intermediate = q; hostTimes.length = 0;
      const trips: number[] = [], sizes: number[] = [];
      let refused = 0, failures = 0, roundTrip = 0;
      const end = performance.now() + seconds * 1000;
      while (performance.now() < end) {
        const started = performance.now();
        let retry = false;
        try {
          await Bun.sleep(rtt / 2);
          const frame = await phone.call('browser.remoteFrame', { threadId: thread.id, maxWidth: 780 });
          await Bun.sleep(rtt / 2);
          roundTrip = performance.now() - started; failures = 0;
          trips.push(roundTrip); sizes.push(frame.base64.length);
        } catch (error) {
          if (/wait before requesting/.test(String(error))) { refused++; retry = true; } else { failures++; console.error(String(error)); }
        }
        await Bun.sleep(retry ? 250 : schedule({ roundTrip, unchanged: 0, failures }));
      }
      console.log(`rtt ${String(rtt).padStart(3)} ms ${name.padEnd(6)}: ${(trips.length / seconds).toFixed(1)} frames/s, trip ${median(trips)} ms (desktop ${median(hostTimes)} ms), ${Math.round(median(sizes) / 1024)} KiB base64 a frame, ${refused} early refusals`);
    }
  }
} finally {
  for (const close of closers.reverse()) try { close(); } catch {}
  core.kill(); chrome.kill(); await Promise.all([core.exited, chrome.exited]);
  rmSync(dataDir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}
