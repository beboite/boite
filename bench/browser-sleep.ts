// What an agent tab left open costs while nobody drives or watches it, end to
// end through a scratch core: the core starts its own headless browser, the
// owner opens a page that animates every frame and runs a timer every 10 ms,
// as an agent would, then leaves it. The first window is measured while the
// tab is still within its wait (`SLEEP_AFTER_MS`, awake as every tab was
// before tabs slept), the second once that wait has passed. Each row gives the
// CPU of the core's browser renderers and GPU process, and the time an agent
// command takes on the tab right after.
//
//   bun bench/browser-sleep.ts [--seconds 20]
//
// CPU is read from /proc on Linux and from Win32_Process on Windows, for the
// processes whose command line names this run's data directory.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from '../packages/core/src/client.ts';
import { SLEEP_AFTER_MS } from '../packages/core/src/browser/sleep.ts';

const root = join(import.meta.dir, '..');
const { values } = parseArgs({ options: { seconds: { type: 'string', default: '20' } } });
const seconds = Number(values.seconds);

const page = `<!doctype html><title>bench</title><canvas id=c width=1200 height=700></canvas><script>
const g=c.getContext('2d');let ticks=0;
function draw(t){for(let i=0;i<400;i++){g.fillStyle='hsl('+((t/10+i)%360)+',80%,50%)';g.fillRect((i*37+t/3)%1200,(i*53)%700,40,40)}requestAnimationFrame(draw)}
requestAnimationFrame(draw);setInterval(()=>{ticks++;let s=0;for(let i=0;i<2e4;i++)s+=Math.sqrt(i);window.s=s},10);
</script>`;

const dataDir = mkdtempSync(join(tmpdir(), 'boite-browser-sleep-'));

/** CPU seconds used so far by this run's browser processes, by kind: renderer, gpu, other. */
async function browserCpu(): Promise<Record<string, number>> {
  const kind = (cmd: string) => /--type=renderer/.test(cmd) ? 'renderer' : /--type=gpu-process/.test(cmd) ? 'gpu' : 'other';
  const total: Record<string, number> = { renderer: 0, gpu: 0, other: 0 };
  if (existsSync('/proc/self/stat')) {
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
        if (!cmd.includes(dataDir)) continue;
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
        total[kind(cmd)]! += (Number(fields[11]) + Number(fields[12])) / 100;
      } catch { /* the process ended */ }
    }
    return total;
  }
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dataDir.replaceAll("'", "''")}') } | ForEach-Object { '{0}\t{1}' -f ($_.KernelModeTime + $_.UserModeTime), $_.CommandLine }`;
  const out = Bun.spawnSync(['pwsh', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).stdout.toString();
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [time, cmd = ''] = line.split('\t');
    total[kind(cmd)]! += Number(time) / 1e7;
  }
  return total;
}

const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(page, { headers: { 'content-type': 'text/html' } }) });
const core = Bun.spawn([process.execPath, join(root, 'packages/core/src/main.ts'), '--port', '0', '--data-dir', dataDir], { stdout: 'ignore', stderr: 'ignore', windowsHide: true, env: { ...process.env, BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_CORE_RESIDENT: '0', BOITE_TELEMETRY_URL: '' } });
let owner: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 200 && !owner; i++) {
    try { const state = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')); owner = await connect(`http://127.0.0.1:${state.port}`, state.token); }
    catch { await Bun.sleep(100); }
  }
  if (!owner) throw new Error('the scratch core did not start');
  const project = await owner.call('projects.add', { path: dataDir, name: 'bench' });
  const account = (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const thread = await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'bench' });
  const threadId = thread.id;
  let lastUse = 0;
  const command = async () => {
    const at = performance.now();
    await owner!.call('browser.command', { threadId, action: { kind: 'evaluate', expression: 'ticks' } });
    lastUse = performance.now();
    return Math.round(lastUse - at);
  };
  const measure = async (name: string) => {
    const before = await browserCpu(), began = performance.now();
    await Bun.sleep(seconds * 1000);
    const after = await browserCpu(), elapsed = (performance.now() - began) / 1000;
    const share = (key: string) => `${((after[key]! - before[key]!) / elapsed * 100).toFixed(1)} %`;
    console.log(`${name.padEnd(7)}: renderer ${share('renderer')}, GPU ${share('gpu')}, other browser processes ${share('other')} of a core; the next command took ${await command()} ms`);
  };
  console.log(`browser-sleep ${new Date().toISOString()} Bun ${Bun.version} on ${process.platform}, ${seconds} s windows, tabs sleep ${SLEEP_AFTER_MS / 1000} s after their last use`);
  await owner.call('browser.command', { threadId, action: { kind: 'open', url: site.url.href } });
  await Bun.sleep(2000);
  await measure('awake');
  // Past the wait after the last command.
  await Bun.sleep(Math.max(0, lastUse + SLEEP_AFTER_MS + 3000 - performance.now()));
  await measure('asleep');
} finally {
  try { owner?.close(); } catch {}
  core.kill(); await core.exited; site.stop(true);
  // The browser's helpers release the profile a moment after the core ends.
  for (let i = 0; i < 20; i++) { try { rmSync(dataDir, { recursive: true, force: true }); break; } catch { await Bun.sleep(500); } }
}
