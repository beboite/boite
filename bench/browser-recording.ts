// A recording (30 fps by default) of a moving 1920x1080 page in the agent's browser,
// through a scratch core: the frames the video holds, read back with ffprobe,
// and the CPU of the core's Chrome processes during the take (Linux, /proc).
// Before the takes, the page times three ways to turn one screencast frame
// (base64 JPEG of the same page size) into a bitmap: what the recorder's
// helper page does with each frame.
//
//   bun bench/browser-recording.ts [--seconds 10] [--runs 3] [--frame-rate 30] [--ffprobe ffprobe]
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { BrowserRecording } from '../packages/contracts/src/index.ts';
import { connect } from '../packages/core/src/client.ts';

const { values } = parseArgs({ options: { seconds: { type: 'string', default: '10' }, runs: { type: 'string', default: '3' }, ffprobe: { type: 'string', default: 'ffprobe' }, 'frame-rate': { type: 'string', default: '30' } } });
const seconds = Number(values.seconds), runs = Number(values.runs), frameRate = Number(values['frame-rate']);
const root = join(import.meta.dir, '..');

const page = `<!doctype html><meta charset=utf-8><title>bench</title><style>body{font:16px system-ui;margin:0;padding:24px;background:#fafafa;color:#222;overflow:hidden}
.hero{height:420px;background:radial-gradient(circle at 30% 40%,#f7c,#38f 40%,#123 80%);border-radius:12px}
.spin{width:300px;height:300px;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(1turn)}}
p{width:1700px}</style><div class=hero></div><div class=spin></div><p>${'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(30)}</p>`;

/** Mean milliseconds per frame of each decode, in the page: the old per-byte copy, the native decoder when the engine has it, and a data URL fetch. */
const DECODE_TIMING = `(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 4000; i++) { ctx.fillStyle = 'hsl(' + (i * 37 % 360) + ',70%,' + (30 + i % 40) + '%)'; ctx.fillRect((i * 97) % 1920, (i * 53) % 1080, 40 + i % 60, 20 + i % 40); }
  const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  const native = typeof Uint8Array.fromBase64 === 'function';
  const ways = {
    'atob + Uint8Array.from': async b => createImageBitmap(new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))], { type: 'image/jpeg' })),
    ...(native ? { 'Uint8Array.fromBase64': async b => createImageBitmap(new Blob([Uint8Array.fromBase64(b)], { type: 'image/jpeg' })) } : {}),
    'fetch(data:) blob': async b => createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b)).blob()),
  };
  const out = { base64Chars: base64.length };
  for (const [name, bytes] of Object.entries({ 'bytes atob + Uint8Array.from': b => Uint8Array.from(atob(b), c => c.charCodeAt(0)), ...(native ? { 'bytes Uint8Array.fromBase64': b => Uint8Array.fromBase64(b) } : {}) })) {
    bytes(base64);
    const at = performance.now();
    for (let i = 0; i < 20; i++) bytes(base64);
    out[name] = (performance.now() - at) / 20;
  }
  for (const [name, way] of Object.entries(ways)) {
    (await way(base64)).close();
    const at = performance.now();
    for (let i = 0; i < 20; i++) (await way(base64)).close();
    out[name] = (performance.now() - at) / 20;
  }
  return JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v * 100) / 100])));
})()`;

const dataDir = mkdtempSync(join(tmpdir(), 'boite-recording-bench-'));
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
let owner: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 200 && !owner; i++) {
    try { const state = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')); owner = await connect(`http://127.0.0.1:${state.port}`, state.token); }
    catch { await Bun.sleep(100); }
  }
  if (!owner) throw new Error('the scratch core did not start');
  const agent = owner;
  const project = await agent.call('projects.add', { path: dataDir, name: 'bench' });
  const account = (await agent.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const thread = await agent.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'bench' });
  const command = (action: Record<string, unknown>) => agent.call('browser.command', { threadId: thread.id, action: action as never });
  await command({ kind: 'open', url: site.url.href });
  await command({ kind: 'resize', width: 1920, height: 1080 });

  console.log(`browser-recording ${new Date().toISOString()} Bun ${Bun.version}, the core's headless browser at 1920x1080, a moving page, ${seconds} s takes at ${frameRate} fps`);
  console.log(`decode per frame: ${(await command({ kind: 'evaluate', expression: DECODE_TIMING })).value}`);
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  const rates: number[] = [], cpus: number[] = [];
  for (let run = 0; run < runs; run++) {
    await command({ kind: 'recording-start', frameRate });
    const cpu = chromeCpu(), began = performance.now();
    await Bun.sleep(seconds * 1000);
    const used = cpu === null ? null : chromeCpu()! - cpu, elapsed = (performance.now() - began) / 1000;
    const { recording } = await command({ kind: 'recording-stop' }) as unknown as { recording: BrowserRecording };
    const parts: Buffer[] = [];
    for (let offset = 0, done = false; !done;) {
      const chunk = (await command({ kind: 'recording-read', recordingId: recording.id, offset })).value as { base64: string; nextOffset: number; done: boolean };
      parts.push(Buffer.from(chunk.base64, 'base64')); offset = chunk.nextOffset; done = chunk.done;
    }
    await command({ kind: 'recording-discard', recordingId: recording.id });
    const file = join(dataDir, `take-${run}.mp4`);
    writeFileSync(file, Buffer.concat(parts));
    const probe = Bun.spawnSync([values.ffprobe, '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames:format=duration', '-of', 'json', file]);
    const read = JSON.parse(probe.stdout.toString()) as { streams: Array<{ nb_read_frames: string }>; format: { duration: string } };
    const frames = Number(read.streams[0]!.nb_read_frames), duration = Number(read.format.duration);
    rates.push(frames / duration); if (used !== null) cpus.push(used / elapsed * 100);
    console.log(`take ${run + 1}: ffprobe ${frames} frames in ${duration.toFixed(2)} s = ${(frames / duration).toFixed(1)} frames/s, recorder counted ${recording.frames}, ${Math.round(recording.bytes / 1024)} KiB, ${used === null ? 'Chrome CPU unread' : `Chrome ${Math.round(used / elapsed * 100)} % of a core`}`);
  }
  console.log(`median: ${median(rates).toFixed(1)} frames/s${cpus.length ? `, Chrome ${Math.round(median(cpus))} % of a core` : ''}`);
} finally {
  try { owner?.close(); } catch {}
  core.kill(); await core.exited; site.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
}
