import { test, expect } from 'bun:test';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startBrowserSession } from './lib/browser-session.ts';
import { runCli } from '../../packages/core/src/cli.ts';

/**
 * Records an animated page through the agent CLI and measures the file the
 * agent receives: frames per second, bytes per minute and the CPU the shell's
 * process tree spent meanwhile. ffprobe, when on PATH, counts the frames.
 * `BOITE_RECORDING_SECONDS` lengthens the take, `BOITE_RECORDING_FPS=60` sets the desktop's
 * rate, `BOITE_RECORDING_KEEP` copies the video there.
 */
const executable = process.env.BOITE_E2E_SHELL_EXE;
const seconds = Number(process.env.BOITE_RECORDING_SECONDS ?? 10);
const frameRate = process.env.BOITE_RECORDING_FPS;
const ANIMATED = `<!doctype html><meta charset="utf-8"><title>Recording cadence</title>
<style>html,body{margin:0;height:100%;background:#123;overflow:hidden;font:600 48px system-ui;color:#fff}
#box{position:absolute;top:30%;width:160px;height:160px;border-radius:24px;background:linear-gradient(135deg,#f80,#08f)}
#count{position:absolute;left:24px;top:24px}</style>
<div id="box"></div><div id="count">0</div>
<script>let n=0;const box=document.getElementById('box'),count=document.getElementById('count');
(function tick(t){n++;box.style.left=(Math.sin(t/600)*0.4+0.45)*innerWidth+'px';box.style.transform='rotate('+(t/8)+'deg)';
count.textContent=n;document.body.style.background='hsl('+(t/40%360)+' 40% 20%)';requestAnimationFrame(tick)})(0)</script>`;

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
function probeFrames(path: string): { frames: number; duration: number; gaps: number[] } | null {
  if (!Bun.which('ffprobe')) return null;
  const out = Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time:format=duration', '-of', 'json', path], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const json = JSON.parse(out.stdout.toString()) as { packets?: { pts_time?: string }[]; format?: { duration?: string } };
  const times = (json.packets ?? []).map(packet => Number(packet.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = times.slice(1).map((time, index) => (time - times[index]!) * 1000).sort((a, b) => a - b);
  return { frames: times.length, duration: Number(json.format?.duration), gaps };
}

test.skipIf(process.platform !== 'win32' || !executable)('a browser recording keeps its frame rate on an animated page', async () => {
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(ANIMATED, { headers: { 'content-type': 'text/html;charset=utf-8' } }) });
  const session = await startBrowserSession(executable!);
  try {
    if (frameRate) await session.page.evaluate(`localStorage.setItem('boite.recording-frame-rate', ${JSON.stringify(frameRate)});true`);
    const id = (await session.command({ kind: 'open', url: site.url.href })).tabId!;
    await Bun.sleep(1000);
    // The animated page alone, for comparison: what the recording adds is the difference.
    const idleFrom = await treeCpuSeconds(session.shellPid), idleAt = performance.now();
    await Bun.sleep(5000);
    const pageCpu = (await treeCpuSeconds(session.shellPid) - idleFrom) / ((performance.now() - idleAt) / 1000);
    const cpuBefore = await treeCpuSeconds(session.shellPid);
    const startedAt = performance.now();
    await session.command({ kind: 'recording-start' }, id);
    await Bun.sleep(seconds * 1000);
    const lines: string[] = [];
    const stopAt = performance.now();
    expect(await runCli(['browser', 'recording-stop', id, '--thread', session.threadId, '--data-dir', session.dataDir, '--json'], {
      cwd: session.projectDir, env: { BOITE_DATA_DIR: session.dataDir }, out: text => lines.push(text), err: text => { throw new Error(text); },
    })).toBe(0);
    const stopSeconds = (performance.now() - stopAt) / 1000;
    const wallSeconds = (performance.now() - startedAt) / 1000;
    const cpu = (await treeCpuSeconds(session.shellPid) - cpuBefore) / wallSeconds;
    const recorded = JSON.parse(lines.join('')) as { path: string; mime: string; bytes: number; durationMs: number; frames?: number; frameRate?: number };
    const percentile = (values: number[], p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
    const probe = probeFrames(recorded.path);
    const fps = probe ? probe.frames / probe.duration : (recorded.frames ?? 0) / (recorded.durationMs / 1000);
    const perMinute = recorded.bytes / (recorded.durationMs / 60_000) / 1024 / 1024;
    console.log(`Recording: ${recorded.mime}, ${(recorded.durationMs / 1000).toFixed(1)} s, ${fps.toFixed(1)} fps measured${probe ? ` by ffprobe (${probe.frames} frames)` : ''}, requested ${recorded.frameRate ?? 'n/a'}${probe ? `, frame gap median ${percentile(probe.gaps, 0.5).toFixed(0)} ms p95 ${percentile(probe.gaps, 0.95).toFixed(0)} ms max ${percentile(probe.gaps, 1).toFixed(0)} ms` : ''}, ${perMinute.toFixed(1)} MiB/min, shell tree ${(cpu * 100).toFixed(0)}% of one core while recording, ${(pageCpu * 100).toFixed(0)}% for the page alone, stopped and downloaded in ${stopSeconds.toFixed(1)} s`);
    if (process.env.BOITE_RECORDING_KEEP) { mkdirSync(process.env.BOITE_RECORDING_KEEP, { recursive: true }); copyFileSync(recorded.path, join(process.env.BOITE_RECORDING_KEEP, `recording-${fps.toFixed(0)}fps.${recorded.mime === 'video/mp4' ? 'mp4' : 'webm'}`)); }
    expect(statSync(recorded.path).size).toBe(recorded.bytes);
    expect(fps).toBeGreaterThanOrEqual((recorded.frameRate ?? 30) * 0.85);
  } finally { await session.close(); site.stop(true); }
}, 130_000 + seconds * 1000);
