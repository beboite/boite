import { expect, test } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { createBrowserLabEngine } from './browser-lab-engine.ts';
import { BrowserLabRecording } from './browser-lab-recording.ts';

test('recording follow failures preserve both successful and failed action outcomes', async () => {
  const actionError = new Error('Action rejected by the page');
  const recorder = new (BrowserLabRecording as any)({ processGroup: 'recording-regression',
    command: async (_action: string, args: Record<string, unknown>) => {
      if (args.fail) throw actionError;
      return { clicked: true };
    },
  }, { output: 'recording-regression.mp4' });
  recorder.follow = async () => { throw new Error('Recorder lost its target'); };
  expect(await recorder.wrappedCommand('click')).toEqual({ clicked: true });
  await expect(recorder.wrappedCommand('click', { fail: true })).rejects.toBe(actionError);
  expect(recorder.errors).toEqual(['Error: Recorder lost its target', 'Error: Recorder lost its target']);
});

const live = process.env.BOITE_BENCH_RECORDING_SMOKE === '1' ? test : test.skip;
live('continuous recording follows two actual public tabs in both engines and decodes to a filmstrip', async () => {
  const { startTestCore } = await import('../packages/core/test/harness.ts');
  const { findBrowser } = await import('../tests/e2e/lib/cdp.ts');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  const output = process.env.BOITE_BENCH_ENGINE_OUTPUT;
  const ffmpegPath = process.env.BOITE_BENCH_FFMPEG;
  if (!binary || !output || !ffmpegPath) throw new Error('Expected browser binary, output and ffmpeg environment paths.');
  mkdirSync(output, { recursive: true });
  const harness = await startTestCore();
  async function tool(group: string, executable: string, args: string[]) {
    const child = harness.core.procs.spawnPiped(group, executable, args, { cwd: output });
    child.proc.stdin.end();
    const streams = Promise.all([new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
    try { const exit = await child.exited; const [stdout, stderr] = await streams; if (exit) throw new Error(`${executable} exited ${exit}: ${stderr}`); return stdout; }
    finally { await harness.core.procs.stopAndWait(group); }
  }
  try {
    for (const kind of ['agent-browser', 'playwright'] as const) {
      const engine = await createBrowserLabEngine(kind, { core: harness.core, taskId: `recording-smoke-${kind}`, binary, executablePath: findBrowser() });
      let video: BrowserLabRecording | undefined;
      try {
        await engine.command('viewport', { width: 1280, height: 800 });
        await engine.command('navigate', { url: 'https://example.com', waitUntil: 'load' });
        const firstTarget = await engine.activeTargetId();
        const initialTabs = await engine.command('tabs');
        const firstTab = (initialTabs.tabs as any[]).find(tab => tab.active).tabId;
        video = await BrowserLabRecording.start(engine, { core: harness.core, output: join(output, `${kind}.mp4`), ffmpegPath, fps: 10 });
        // Explicit recording dwell, excluded from all performance measurements.
        await Bun.sleep(800);
        await engine.command('tab_new', { url: 'https://www.gov.uk/' });
        expect(await engine.activeTargetId()).not.toBe(firstTarget);
        const snapshot = await engine.command('snapshot', { interactive: true });
        const ref = String(snapshot.snapshot).match(/(?:textbox|searchbox|combobox) [^\n]*?\[[^\]]*ref=((?:f\d+)?e\d+)\]/)?.[1];
        expect(ref).toBeDefined();
        await engine.command('fill', { selector: `@${ref}`, value: 'renew adult passport' });
        await Bun.sleep(1000);
        await engine.command('tab_switch', { tabId: firstTab });
        expect(await engine.activeTargetId()).toBe(firstTarget);
        await Bun.sleep(800);
        const result = await video.stop(); video = undefined;
        expect(result.targetChanges).toBe(3);
        expect(result.capturedFrames).toBeGreaterThan(3);
        expect(result.frames).toBeGreaterThan(20);
        expect(result.bytes).toBeGreaterThan(1000);
        const metadata = JSON.parse(readFileSync(`${result.path}.json`, 'utf8'));
        expect(metadata.errors).toEqual([]);
        const raw = await tool(`${engine.processGroup}:probe`, join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,nb_frames', '-of', 'json', result.path]);
        const probe = JSON.parse(raw);
        expect(Number(probe.streams[0].nb_frames)).toBe(result.frames);
        expect([probe.streams[0].width, probe.streams[0].height]).toEqual([1280, 800]);
        await tool(`${engine.processGroup}:decode`, ffmpegPath, ['-v', 'error', '-y', '-i', result.path, '-vf', `fps=${8 / Number(probe.format.duration)},scale=320:200,tile=4x2`, '-frames:v', '1', '-threads', '2', '-update', '1', join(output, `${kind}-filmstrip.png`)]);
      } finally {
        if (video) await video.stop();
        await engine.close();
        expect(harness.core.procs.liveCount(engine.processGroup)).toBe(0);
      }
    }
  } finally { await harness.stop(); }
}, 90_000);
