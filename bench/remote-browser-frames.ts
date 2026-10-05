// Frames a second a viewer gets from the agent's browser, end to end through a
// scratch core: the core starts its own headless Chromium for the
// conversation, the owner opens a moving page in it as the agent would, and a
// paired phone asks `browser.remoteFrame` on the viewer's schedule. Latency is
// added on the phone's side, half before and half after each call; bandwidth
// is not limited. The page animates, so no frame is unchanged.
//
//   bun bench/remote-browser-frames.ts [--seconds 8] [--rtt 0,80,200]
//
// "before" is the viewer's schedule up to 2026-10-03: a fixed 300 ms pause
// after each frame. "after" is nextPollDelay from remote-browser-view.ts.
// Until 2026-10-05 the frames came from the desktop shell's tab through the
// core (results/2026-10-03-remote-browser-frames.md); they now come from the
// core's own browser, so those numbers do not compare with new runs.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
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

const words = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua '.repeat(6);
const page = `<!doctype html><meta charset=utf-8><title>bench</title><style>body{font:16px system-ui;margin:0;padding:24px;background:#fafafa;color:#222}
.hero{height:320px;background:radial-gradient(circle at 30% 40%,#f7c,#38f 40%,#123 80%);border-radius:12px}
.card{display:inline-block;width:340px;margin:10px;padding:12px;background:white;box-shadow:0 2px 8px #0002;vertical-align:top}
.spin{width:80px;height:80px;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(1turn)}}</style>
<div class=hero></div><div class=spin></div><h1>Résultats de recherche</h1>${Array.from({ length: 12 }, (_, i) => `<div class=card><h3>Carte ${i}</h3><p>${words}</p><input placeholder="Champ ${i}"><button>Valider</button></div>`).join('')}`;

const dataDir = mkdtempSync(join(tmpdir(), 'boite-remote-frames-'));
const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(page, { headers: { 'content-type': 'text/html;charset=utf-8' } }) });
const core = Bun.spawn([process.execPath, join(root, 'packages/core/src/main.ts'), '--port', '0', '--data-dir', dataDir], { stdout: 'ignore', stderr: 'ignore', windowsHide: true, env: { ...process.env, BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_CORE_RESIDENT: '0', BOITE_TELEMETRY_URL: '' } });
const closers: (() => void)[] = [];
try {
  let owner: Awaited<ReturnType<typeof connect>> | undefined;
  for (let i = 0; i < 200 && !owner; i++) {
    try { const state = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')); owner = await connect(`http://127.0.0.1:${state.port}`, state.token); }
    catch { await Bun.sleep(100); }
  }
  if (!owner) throw new Error('the scratch core did not start');
  const agent = owner, url = `http://127.0.0.1:${JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).port}`;
  closers.push(() => agent.close());
  const project = await agent.call('projects.add', { path: dataDir, name: 'bench' });
  const account = (await agent.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const thread = await agent.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'bench' });
  await agent.call('threads.subscribe', { threadId: thread.id });
  // The agent's page, in the browser the core starts for this conversation.
  await agent.call('browser.command', { threadId: thread.id, action: { kind: 'open', url: site.url.href } });
  await agent.call('browser.command', { threadId: thread.id, action: { kind: 'resize', width: 1200, height: 1300 } });

  const { grant } = await agent.call('pairing.grant', {});
  const phone = await connect(url, '', { grant, client: { name: 'pwa', version: 'bench' } });
  closers.push(() => phone.close());
  await phone.call('threads.subscribe', { threadId: thread.id });

  const median = (a: number[]) => a.length ? Math.round([...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!) : 0;
  console.log(`remote-browser-frames ${new Date().toISOString()} Bun ${Bun.version}, the core's headless browser at 1200x1300, frames shrunk to 780 px, ${seconds} s per run`);
  for (const rtt of rtts) {
    for (const [name, schedule] of [['before', before], ['after', nextPollDelay]] as const) {
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
      console.log(`rtt ${String(rtt).padStart(3)} ms ${name.padEnd(6)}: ${(trips.length / seconds).toFixed(1)} frames/s, trip ${median(trips)} ms, ${Math.round(median(sizes) / 1024)} KiB base64 a frame, ${refused} early refusals`);
    }
  }
} finally {
  for (const close of closers.reverse()) try { close(); } catch {}
  core.kill(); await core.exited; site.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
}
