import { test, expect } from 'bun:test';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { startBrowserSession } from './lib/browser-session.ts';
import { runCli } from '../../packages/core/src/cli.ts';
import type { BrowserPreset } from '../../packages/contracts/src/index.ts';

/**
 * Records an animated page through the agent CLI and measures the file the
 * agent receives: frames per second, bytes per minute and the CPU the shell's
 * process tree spent meanwhile. ffprobe, when on PATH, counts the frames and
 * ffmpeg decodes the whole file. The video is then played in the desktop's
 * review dialog and in the chat.
 * `BOITE_RECORDING_SECONDS` lengthens the take, `BOITE_RECORDING_FPS=60` and
 * `BOITE_RECORDING_CODEC=av1` are passed to `recording-start`,
 * `BOITE_RECORDING_PRESET` sizes the page, `BOITE_RECORDING_NOISE=1` animates
 * noise no encoder compresses, to reach the size cap, `BOITE_RECORDING_PLAY`
 * lists other videos (`;`-separated) to play in the chat and
 * `BOITE_RECORDING_KEEP` copies the video there.
 */
const executable = process.env.BOITE_E2E_SHELL_EXE;
const seconds = Number(process.env.BOITE_RECORDING_SECONDS ?? 10);
const frameRate = process.env.BOITE_RECORDING_FPS;
const codec = process.env.BOITE_RECORDING_CODEC;
const preset = process.env.BOITE_RECORDING_PRESET as BrowserPreset | undefined;
const others = (process.env.BOITE_RECORDING_PLAY ?? '').split(';').filter(Boolean);
const ANIMATED = `<!doctype html><meta charset="utf-8"><title>Recording cadence</title>
<style>html,body{margin:0;height:100%;background:#123;overflow:hidden;font:600 48px system-ui;color:#fff}
#box{position:absolute;top:30%;width:160px;height:160px;border-radius:24px;background:linear-gradient(135deg,#f80,#08f)}
#count{position:absolute;left:24px;top:24px}</style>
<div id="box"></div><div id="count">0</div>
<script>let n=0;const box=document.getElementById('box'),count=document.getElementById('count');
(function tick(t){n++;box.style.left=(Math.sin(t/600)*0.4+0.45)*innerWidth+'px';box.style.transform='rotate('+(t/8)+'deg)';
count.textContent=n;document.body.style.background='hsl('+(t/40%360)+' 40% 20%)';requestAnimationFrame(tick)})(0)</script>`;
const NOISE = `<!doctype html><meta charset="utf-8"><title>Recording noise</title>
<style>html,body{margin:0;height:100%;overflow:hidden}canvas{width:100%;height:100%;image-rendering:pixelated}</style><canvas width="480" height="270"></canvas>
<script>const c=document.querySelector('canvas').getContext('2d'),img=c.createImageData(480,270),px=new Uint32Array(img.data.buffer);
(function tick(){for(let i=0;i<px.length;i++)px[i]=(Math.random()*0xffffff)|0xff000000;c.putImageData(img,0,0);requestAnimationFrame(tick)})()</script>`;

/** User plus kernel CPU seconds of `root` and every descendant. */
async function treeCpuSeconds(root: number): Promise<number> {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.KernelModeTime + $_.UserModeTime)" }';
  const out = await new Response(Bun.spawn(['powershell', '-NoProfile', '-Command', script], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout).text();
  const rows = out.trim().split(/\r?\n/).map(line => line.trim().split(' ').map(Number));
  const tree = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const [pid, parent] of rows) if (tree.has(parent!) && !tree.has(pid!)) { tree.add(pid!); grew = true; } }
  return rows.filter(([pid]) => tree.has(pid!)).reduce((sum, [, , time]) => sum + (time ?? 0), 0) / 1e7;
}

/** Frames, duration and the gaps between frames in milliseconds, sorted: a smooth video has no long gap. */
function probeFrames(path: string): { frames: number; duration: number; gaps: number[]; codec: string; decode: string } | null {
  if (!Bun.which('ffprobe')) return null;
  const out = Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time:format=duration', '-of', 'json', path], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const json = JSON.parse(out.stdout.toString()) as { packets?: { pts_time?: string }[]; format?: { duration?: string } };
  const times = (json.packets ?? []).map(packet => Number(packet.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = times.slice(1).map((time, index) => (time - times[index]!) * 1000).sort((a, b) => a - b);
  const codec = Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,width,height', '-of', 'csv=p=0', path], { stdout: 'pipe', stderr: 'pipe', windowsHide: true }).stdout.toString().trim();
  // A full decode: a cut or unfinished file reports errors here. The null muxer also
  // warns about the repeated timestamps MediaRecorder writes; those are not decode errors.
  const decode = Bun.which('ffmpeg') ? Bun.spawnSync(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], { stdout: 'pipe', stderr: 'pipe', windowsHide: true }).stderr.toString()
    .split(/\r?\n/).filter(line => line.trim() && !/non monotonically increasing dts|Last message repeated/.test(line)).join('\n') : '';
  return { frames: times.length, duration: Number(json.format?.duration), gaps, codec, decode };
}

/** Plays an attachment in the chat to a decoded frame halfway, or reports the fallback the chat shows instead. */
const chatPlayback = (name: string) => `(async () => {
  const until = performance.now() + 20000;
  while (performance.now() < until) {
    const file = [...document.querySelectorAll('[data-testid=chat-file]')].filter(node => node.textContent.includes(${JSON.stringify(name)}) || node.querySelector('video[aria-label="${name}"]')).at(-1);
    if (file?.querySelector('[data-testid=media-fallback]')) return JSON.stringify({ fallback: file.querySelector('[data-testid=media-fallback]').textContent.trim() });
    const video = file?.querySelector('video');
    if (!video) file?.querySelector('[data-testid=artifact-preview]')?.click();
    else if (video.readyState >= 1 && Number.isFinite(video.duration)) {
      await new Promise(resolve => { video.onseeked = resolve; video.currentTime = video.duration / 2; setTimeout(resolve, 5000); });
      await new Promise(resolve => setTimeout(resolve, 300));
      if (file.querySelector('[data-testid=media-fallback]')) continue;
      return JSON.stringify({ played: video.readyState >= 2, width: video.videoWidth, height: video.videoHeight, at: Number(video.currentTime.toFixed(2)) });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return JSON.stringify({ timeout: true });
})()`;
/** Plays the recording in the desktop's review dialog, or reports its fallback, with the dialog's texts. */
const DIALOG_PLAYBACK = `(async () => {
  for (let i = 0; i < 100 && !document.querySelector('[data-testid=browser-tools-dialog][open]'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
  const summary = () => ({ reason: text('[data-testid=browser-recording-reason]'), fallback: text('[data-testid=browser-recording-unplayable]'), text: text('[data-testid=browser-tools-dialog] .muted') });
  const video = document.querySelector('[data-testid=browser-recording-preview]');
  if (!video) return JSON.stringify({ played: false, ...summary() });
  const loaded = await new Promise(resolve => { if (video.readyState >= 2) resolve(true); video.onloadeddata = () => resolve(true); video.onerror = () => resolve(false); setTimeout(() => resolve(video.readyState >= 2), 10000); });
  if (loaded) await new Promise(resolve => { video.onseeked = resolve; video.currentTime = video.duration / 2; setTimeout(resolve, 5000); });
  await new Promise(resolve => setTimeout(resolve, 300));
  return JSON.stringify({ played: loaded && video.readyState >= 2, width: video.videoWidth, height: video.videoHeight, at: Number(video.currentTime.toFixed(2)), ...summary() });
})()`;

test.skipIf(process.platform !== 'win32' || !executable)('a browser recording keeps its frame rate on an animated page', async () => {
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(process.env.BOITE_RECORDING_NOISE ? NOISE : ANIMATED, { headers: { 'content-type': 'text/html;charset=utf-8' } }) });
  const session = await startBrowserSession(executable!);
  const cli = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await runCli([...args, '--thread', session.threadId, '--data-dir', session.dataDir, '--json'], { cwd: session.projectDir, env: { BOITE_DATA_DIR: session.dataDir }, out: text => out.push(text), err: text => err.push(text) });
    return { code, out: out.join(''), err: err.join('') };
  };
  try {
    const id = (await session.command({ kind: 'open', url: site.url.href })).tabId!;
    if (preset) await session.command({ kind: 'preset', preset }, id);
    await Bun.sleep(1000);
    // The animated page alone, for comparison: what the recording adds is the difference.
    const idleFrom = await treeCpuSeconds(session.shellPid), idleAt = performance.now();
    await Bun.sleep(5000);
    const pageCpu = (await treeCpuSeconds(session.shellPid) - idleFrom) / ((performance.now() - idleAt) / 1000);
    const cpuBefore = await treeCpuSeconds(session.shellPid);
    const startedAt = performance.now();
    const started = await cli(['browser', 'recording-start', id, ...(frameRate ? ['--fps', frameRate] : []), ...(codec ? ['--codec', codec] : [])]);
    if (started.code !== 0) {
      // A codec this desktop cannot encode is refused, and nothing records in another one.
      console.log(`Refused: ${started.err.trim()}`);
      expect(started.err).toContain('not available on this desktop');
      await expect(session.command({ kind: 'recording-stop' }, id)).rejects.toThrow('no browser recording has started');
      return;
    }
    console.log(`Recording started in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
    await Bun.sleep(seconds * 1000);
    // The desktop stops and keeps the video for review; the agent then downloads it.
    const stopAt = performance.now();
    const stopped = (await session.command({ kind: 'recording-stop' }, id)).recording!;
    const wallSeconds = (performance.now() - startedAt) / 1000;
    const cpu = (await treeCpuSeconds(session.shellPid) - cpuBefore) / wallSeconds;
    const dialog = JSON.parse(await session.page.evaluate(DIALOG_PLAYBACK) as string) as { played: boolean; reason: string | null; fallback: string | null; text: string | null };
    const saved = await cli(['browser', 'recording-stop', id]);
    expect(saved.code).toBe(0);
    const stopSeconds = (performance.now() - stopAt) / 1000;
    const recorded = JSON.parse(saved.out) as { path: string; mime: string; bytes: number; durationMs: number; frames?: number; frameRate?: number; codec?: string; reason: string; note?: string };
    expect(recorded.bytes).toBe(stopped.bytes);
    const percentile = (values: number[], p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
    const probe = probeFrames(recorded.path);
    const fps = probe ? probe.frames / probe.duration : (recorded.frames ?? 0) / (recorded.durationMs / 1000);
    const perMinute = recorded.bytes / (recorded.durationMs / 60_000) / 1024 / 1024;
    console.log(`Recording: ${recorded.mime} ${recorded.codec} (ffprobe ${probe?.codec}), ${(recorded.bytes / 1024 / 1024).toFixed(1)} MiB, reason ${recorded.reason}${recorded.note ? ` (${recorded.note})` : ''}, ${(recorded.durationMs / 1000).toFixed(1)} s, ${fps.toFixed(1)} fps measured${probe ? ` by ffprobe (${probe.frames} frames)` : ''}, requested ${recorded.frameRate ?? 'n/a'}${probe ? `, frame gap median ${percentile(probe.gaps, 0.5).toFixed(0)} ms p95 ${percentile(probe.gaps, 0.95).toFixed(0)} ms max ${percentile(probe.gaps, 1).toFixed(0)} ms` : ''}, ${perMinute.toFixed(1)} MiB/min, shell tree ${(cpu * 100).toFixed(0)}% of one core while recording, ${(pageCpu * 100).toFixed(0)}% for the page alone, stopped and downloaded in ${stopSeconds.toFixed(1)} s`);
    console.log(`Full decode: ${probe?.decode || 'no error'}; review dialog: ${JSON.stringify(dialog)}`);
    if (process.env.BOITE_RECORDING_KEEP) { mkdirSync(process.env.BOITE_RECORDING_KEEP, { recursive: true }); copyFileSync(recorded.path, join(process.env.BOITE_RECORDING_KEEP, `recording-${recorded.codec ?? 'h264'}-${recorded.frameRate ?? 30}fps.${recorded.mime === 'video/mp4' ? 'mp4' : 'webm'}`)); }
    expect(statSync(recorded.path).size).toBe(recorded.bytes);
    expect(fps).toBeGreaterThanOrEqual((recorded.frameRate ?? 30) * 0.85);
    if (codec) expect(recorded.codec).toBe(codec);
    if (probe) { expect(probe.decode).toBe(''); expect(probe.codec).toStartWith(({ h264: 'h264', hevc: 'hevc', av1: 'av1' } as Record<string, string>)[recorded.codec ?? 'h264']!); }
    expect(dialog.played || !!dialog.fallback).toBe(true);
    if (recorded.reason === 'size') {
      expect(recorded.note).toContain('100 MB size limit');
      // The dialog speaks the desktop's language: "100 MB" or "100 Mo".
      expect(dialog.reason).toMatch(/\b100 M[Bo]\b/);
    }
    // The chat plays the agent's attachment, or offers its download when it cannot.
    const turn = await session.client.call('turns.start', { threadId: session.threadId, prompt: 'Vidéo du navigateur' });
    for (let i = 0; i < 100; i++) { if ((await session.client.call('threads.get', { threadId: session.threadId })).turns.find(t => t.id === turn.id)?.status === 'done') break; await Bun.sleep(50); }
    // An attachment comes from the thread's working directory.
    const copies = others.map(other => { const copy = join(session.projectDir, basename(other)); copyFileSync(other, copy); return copy; });
    for (const path of [recorded.path, ...copies]) {
      const attached = await cli(['attach', path]);
      expect(attached.code, attached.err).toBe(0);
      const played = JSON.parse(await session.page.evaluate(chatPlayback(basename(path))) as string) as { played?: boolean; fallback?: string };
      console.log(`Chat playback of ${basename(path)}: ${JSON.stringify(played)}`);
      expect(played.played || !!played.fallback).toBe(true);
    }
  } finally { await session.close(); site.stop(true); }
}, 160_000 + seconds * 1000);
