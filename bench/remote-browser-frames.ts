// Frames a second a viewer gets from the agent's browser, end to end through a
// scratch core: the core starts its own headless Chromium for the
// conversation, the owner opens a moving page in it as the agent would, and a
// paired phone asks `browser.remoteFrame` on the viewer's schedule, naming the
// frame it shows (`after`) as RemoteBrowser.svelte does. Latency is added on
// the phone's side, half before and half after each call; bandwidth is not
// limited. The page animates; `--still` drops the animation, so a viewer should
// receive next to nothing. Each row gives the pictures and the base64 bytes a
// second, and on Linux the CPU of the core's Chrome processes, read from /proc.
//
//   bun bench/remote-browser-frames.ts [--seconds 8] [--rtt 0,80,200] [--still]
//
// "before" is the viewer's schedule up to 2026-10-03: a fixed 300 ms pause
// after each frame. "after" is nextPollDelay from remote-browser-view.ts.
// Until 2026-10-05 the frames came from the desktop shell's tab through the
// core (results/2026-10-03-remote-browser-frames.md); they now come from the
// core's own browser, so those numbers do not compare with new runs.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { RemoteBrowserFrame, RemoteBrowserUnchanged } from '../packages/contracts/src/index.ts';
import { connect } from '../packages/core/src/client.ts';
import { nextPollDelay, type PollState } from '../packages/ui/src/lib/remote-browser-view.ts';

const { values } = parseArgs({ options: { seconds: { type: 'string', default: '8' }, rtt: { type: 'string', default: '0,80,200' }, still: { type: 'boolean', default: false } } });
const seconds = Number(values.seconds), rtts = values.rtt.split(',').map(Number), still = values.still;
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
.spin{width:80px;height:80px;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);border-radius:50%;${still ? '' : 'animation:s 1s linear infinite'}}@keyframes s{to{transform:rotate(1turn)}}</style>
<div class=hero></div><div class=spin></div><h1>Résultats de recherche</h1>${Array.from({ length: 12 }, (_, i) => `<div class=card><h3>Carte ${i}</h3><p>${words}</p><input placeholder="Champ ${i}"><button>Valider</button></div>`).join('')}`;

const dataDir = mkdtempSync(join(tmpdir(), 'boite-remote-frames-'));
/** CPU seconds used so far by the Chrome processes of this run's profile, or null without /proc. */
const chromeCpu = (): number | null => {
  if (!existsSync('/proc/self/stat')) return null;
  let ticks = 0;
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dataDir) || !/chrom/i.test(readFileSync(`/proc/${pid}/comm`, 'utf8'))) continue;
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
      ticks += Number(fields[11]) + Number(fields[12]);
    } catch { /* the process ended */ }
  }
  return ticks / 100;
};
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
  console.log(`remote-browser-frames ${new Date().toISOString()} Bun ${Bun.version}, the core's headless browser at 1200x1300, ${still ? 'a still page' : 'a moving page'}, frames shrunk to 780 px, ${seconds} s per run`);
  for (const rtt of rtts) {
    for (const [name, schedule] of [['before', before], ['after', nextPollDelay]] as const) {
      const trips: number[] = [], sizes: number[] = [];
      let refused = 0, failures = 0, roundTrip = 0, unchanged = 0, kept = 0, shown: { id: string; base64: string } | null = null;
      const cpu = chromeCpu(), began = performance.now(), end = began + seconds * 1000;
      while (performance.now() < end) {
        const started = performance.now();
        let retry = false;
        try {
          await Bun.sleep(rtt / 2);
          const frame: RemoteBrowserFrame | RemoteBrowserUnchanged = await phone.call('browser.remoteFrame', { threadId: thread.id, maxWidth: 780, ...(shown ? { after: shown.id } : {}) });
          await Bun.sleep(rtt / 2);
          roundTrip = Math.max(0, performance.now() - started - (frame.waitedMs ?? 0)); failures = 0;
          if ('unchanged' in frame) { unchanged++; kept++; }
          else {
            unchanged = shown?.base64 === frame.base64 ? unchanged + 1 : 0;
            shown = frame; trips.push(roundTrip); sizes.push(frame.base64.length);
          }
        } catch (error) {
          if (/wait before requesting/.test(String(error))) { refused++; retry = true; } else { failures++; console.error(String(error)); }
        }
        await Bun.sleep(retry ? 250 : schedule({ roundTrip, unchanged, failures }));
      }
      const elapsed = (performance.now() - began) / 1000, used = cpu === null ? null : chromeCpu()! - cpu;
      const bytes = sizes.reduce((sum, size) => sum + size, 0);
      console.log(`rtt ${String(rtt).padStart(3)} ms ${name.padEnd(6)}: ${(trips.length / elapsed).toFixed(1)} frames/s, ${(kept / elapsed).toFixed(1)} unchanged/s, trip ${median(trips)} ms, ${Math.round(median(sizes) / 1024)} KiB base64 a frame, ${Math.round(bytes / 1024 / elapsed)} KiB/s, ${used === null ? 'Chrome CPU unread' : `Chrome ${Math.round(used / elapsed * 100)} % of a core`}, ${refused} early refusals`);
    }
  }
} finally {
  for (const close of closers.reverse()) try { close(); } catch {}
  core.kill(); await core.exited; site.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
}
