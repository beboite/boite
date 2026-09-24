import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startTestCore } from '../packages/core/test/harness.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { BrowserLabCodex, type BrowserContentItem } from './browser-lab-codex.ts';
import type { BrowserLabEngine } from './browser-lab-engine.ts';
import { createBrowserLabEngineTransportFix as createBrowserLabEngine } from './browser-lab-transport-fix.ts';
import { createLabContext } from './browser-lab-isolation.ts';
import { LabPage, labTool } from './browser-lab-page.ts';
import { labTasks } from './browser-lab-tasks.ts';
import { compactObservation, memoryPlannerInstruction, parseBrowserDecision } from './browser-lab-memory.ts';
import { BrowserLabRecording } from './browser-lab-recording.ts';
import { useDirectCapture } from './browser-lab-capture.ts';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const clean = (_key: string, value: unknown) => typeof value === 'string' && value.startsWith('data:image/')
  ? { omittedImage: true, length: value.length, sha256: createHash('sha256').update(value).digest('hex') } : value;

async function main() {
  if (process.env.BOITE_BENCH_EFFICIENT !== '1') throw new Error('Set BOITE_BENCH_EFFICIENT=1 for this live subscription experiment.');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY, codex = process.env.BOITE_BENCH_CODEX_BINARY;
  if (!binary || !codex || !process.env.BOITE_BENCH_OUTPUT) throw new Error('Browser/Codex binaries and a fresh output directory required.');
  const output = resolve(process.env.BOITE_BENCH_OUTPUT);
  if (existsSync(output)) throw new Error('Use a fresh output directory.');
  const tasks = process.env.BOITE_BENCH_TASKS ? process.env.BOITE_BENCH_TASKS.split(',').map(id => {
    const task = labTasks.find(task => task.id === id); if (!task) throw new Error('Unknown task: ' + id); return task;
  }) : labTasks;
  const kind = process.env.BOITE_BENCH_ENGINE ?? 'playwright';
  if (kind !== 'playwright' && kind !== 'agent-browser') throw new Error('Invalid engine.');
  const nativeDownloadCorrection = process.env.BOITE_BENCH_NATIVE_DOWNLOAD_FIX === '1';
  if (nativeDownloadCorrection && kind !== 'agent-browser') throw new Error('Native download correction requires the native engine.');
  const timeoutMs = Number(process.env.BOITE_BENCH_TIMEOUT_MS ?? 180000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30000 || timeoutMs > 600000) throw new Error('Invalid deadline.');
  const mode = `memory-${kind}-vision`;
  mkdirSync(output, { recursive: true });
  const workspace = join(output, 'workspace'); mkdirSync(workspace);
  const sources = ['browser-lab.ts', 'browser-lab-page.ts', 'browser-lab-tasks.ts', 'browser-lab-codex.ts', 'browser-lab-engine.ts', 'browser-lab-isolation.ts', 'browser-lab-recording.ts', 'browser-lab-efficient.ts', 'browser-lab-memory.ts', 'browser-lab-capture.ts', 'browser-lab-transport-fix.ts'];
  if (nativeDownloadCorrection) sources.push('browser-lab-download.ts');
  const protocol = { date: new Date().toISOString(), tasks, modes: [mode], repetitions: 1, timeoutMs, maxActions: 60, maxDecisions: 40,
    model: process.env.BOITE_BENCH_MODEL ?? 'gpt-6-luna', effort: 'max', tier: 'priority', isolatedContext: true,
    cadence: 'Fresh ephemeral thread per JSON decision; latest observation plus at most 6000 characters of agent-maintained memory. No growing conversation history.',
    directCapture: true, nativeDownloadCorrection,
    transportCorrection: 'Independent loopback native connection; launch-owner socket retained only for lifecycle.',
    recorded: process.env.BOITE_BENCH_RECORD === '1', campaignLane: 'memory', campaignConcurrency: Number(process.env.BOITE_BENCH_CONCURRENCY ?? 1),
    viewport: { width: 1280, height: 800 }, colorScheme: 'light', binaryHash: sha(binary), sourceHashes: Object.fromEntries(sources.map(file => [file, sha(join(import.meta.dir, file))])) };
  if (protocol.recorded && !process.env.BOITE_BENCH_FFMPEG) throw new Error('Recording requires BOITE_BENCH_FFMPEG.');
  writeFileSync(join(output, 'protocol.json'), JSON.stringify(protocol, null, 2));
  mkdirSync(join(output, 'source')); for (const file of sources) writeFileSync(join(output, 'source', file), readFileSync(join(import.meta.dir, file)));
  const harness = await startTestCore();
  let context: ReturnType<typeof createLabContext>;
  try { context = createLabContext(harness.core, output, true); } catch (error) { await harness.stop(); throw error; }
  let model: BrowserLabCodex;
  try { model = new BrowserLabCodex(context.core, codex, workspace, { model: protocol.model }); }
  catch (error) { try { await harness.stop(); } finally { context.close(); } throw error; }
  const groups = [model.processKey], summaries: any[] = [];
  const cancellation = new AbortController(); let stopReason: string | undefined;
  const stop = (reason: string) => { stopReason ??= reason; cancellation.abort(); void model.close().catch(() => {}); };
  const interrupt = () => stop('signal'); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const watcher = setInterval(() => { if (existsSync(join(output, 'stop.requested'))) stop('stop.requested'); }, 500); watcher.unref();
  try {
    writeFileSync(join(output, 'model.json'), JSON.stringify(await model.initialize(), null, 2));
    for (const task of tasks) {
      if (stopReason) break;
      const id = `${mode}-${task.id}-1`, directory = join(output, id); mkdirSync(directory);
      const started = performance.now(), logs: unknown[] = [], calls: any[] = [];
      const sample: any = { id, mode, task: task.id, run: 1, startedAt: new Date().toISOString(), rubric: task.rubric, decisions: [] };
      let engine: BrowserLabEngine | undefined, page: LabPage | undefined, recording: BrowserLabRecording | undefined;
      try {
        if (!model.isUsable) { await model.close(); model = new BrowserLabCodex(context.core, codex, workspace, { model: protocol.model }); groups.push(model.processKey); await model.initialize(); }
        engine = await createBrowserLabEngine(kind, { core: harness.core, taskId: id, binary, executablePath: findBrowser(), signal: cancellation.signal, log: entry => logs.push(entry) });
        await useDirectCapture(engine, entry => logs.push(entry));
        if (nativeDownloadCorrection) {
          const { useNativeDownload } = await import(pathToFileURL(join(import.meta.dir, 'browser-lab-download.ts')).href);
          await useNativeDownload(engine, (entry: unknown) => logs.push(entry));
        }
        writeFileSync(join(directory, 'owned-processes.json'), JSON.stringify(harness.core.procs.liveOf(engine.processGroup)));
        sample.engine = engine.metadata;
        await engine.command('viewport', protocol.viewport);
        await engine.command('navigate', { url: task.url, waitUntil: 'domcontentloaded' });
        if (protocol.recorded) recording = await BrowserLabRecording.start(engine, { core: harness.core, output: join(directory, 'recording.mp4'), ffmpegPath: process.env.BOITE_BENCH_FFMPEG!, fps: 10 });
        sample.startupMs = performance.now() - started;
        const executionStarted = performance.now(), deadline = executionStarted + timeoutMs;
        page = new LabPage(engine, task, true, directory, deadline, 60);
        const first = await page.observe();
        let observation: any = first.text, imageUrl = first.imageUrl, memory = '', malformed = 0;
        let decisionsStarted = 0;
        for (let step = 1; step <= protocol.maxDecisions && performance.now() < deadline && !page.finished && !stopReason; step++) {
          decisionsStarted++;
          const compact = compactObservation(observation);
          const input: BrowserContentItem[] = [{ type: 'inputText', text: memoryPlannerInstruction + '\nCommand schema:\n' + JSON.stringify(labTool(true).inputSchema)
            + '\nTask:\n' + task.goal + '\nMemory:\n' + memory + '\nCurrent observation:\n' + JSON.stringify(compact) }];
          if (imageUrl) input.push({ type: 'inputImage', imageUrl });
          const result = await model.run(input, [], async () => { throw new Error('Decision service cannot execute tools.'); }, deadline - performance.now());
          calls.push(result);
          writeFileSync(join(directory, `decision-${String(step).padStart(2, '0')}.json`), JSON.stringify(result, clean, 2));
          if (result.turn?.status !== 'completed') break;
          const text = result.events.filter((event: any) => event.method === 'item/completed' && event.params.item.type === 'agentMessage').map((event: any) => event.params.item.text).join('\n');
          let decision: ReturnType<typeof parseBrowserDecision>;
          try { decision = parseBrowserDecision(text); }
          catch (error) { if (++malformed >= 2) throw error; observation = { ...observation, plannerError: String(error) }; continue; }
          memory = decision.memory;
          sample.decisions.push({ step, commands: decision.commands, memory, observationCharacters: JSON.stringify(compact).length, originalCharacters: JSON.stringify(observation).length });
          try {
            const result = await page.execute({ commands: decision.commands });
            observation = JSON.parse(result.contentItems.find(item => item.type === 'inputText')!.text!);
            imageUrl = result.contentItems.find(item => item.type === 'inputImage')?.imageUrl;
          } catch (error) { observation = { error: String(error), instruction: 'Last observation is invalid; observe again before referencing elements.' }; imageUrl = undefined; }
          writeFileSync(join(output, 'progress.json'), JSON.stringify({ id, step, seconds: Math.round((performance.now() - executionStarted) / 1000), actions: page.actionCount }));
        }
        sample.decisionsStarted = decisionsStarted;
        if (!page.finished) sample.stopReason = stopReason ?? (performance.now() >= deadline ? 'deadline' : decisionsStarted >= protocol.maxDecisions ? 'decision-budget' : 'model-incomplete');
        sample.executionMs = performance.now() - executionStarted;
        sample.totalMs = sample.startupMs + sample.executionMs;
      } catch (error) { sample.error = error instanceof Error ? error.stack : String(error); }
      finally {
        if (stopReason) sample.cancelled = stopReason;
        sample.elapsedBeforeCleanupMs = performance.now() - started;
        sample.answer = page?.answer; sample.finished = page?.finished ?? false; sample.actions = page?.actionCount ?? 0;
        sample.attempts = page?.attempts ?? []; sample.visited = page?.visited ?? [];
        sample.observations = page?.history.map(item => ({ id: item.id, url: item.state.url, title: item.state.title, errors: item.errors, observationMs: item.observationMs })) ?? [];
        sample.model = { calls, config: calls.at(-1)?.config, turn: calls.at(-1)?.turn, timedOut: calls.some(call => call.timedOut), events: calls.flatMap(call => call.events) };
        const file = join(directory, 'download.zip'); if (existsSync(file)) sample.download = { bytes: statSync(file).size, headerHex: readFileSync(file).subarray(0, 4).toString('hex'), sha256: sha(file) };
        try { sample.recording = await recording?.stop(); } catch (error) { sample.recordingError = String(error); }
        try { await engine?.close(); } catch (error) { sample.cleanupError = String(error); }
        sample.processesAfter = harness.core.procs.liveCount(`browser:${id}`);
        writeFileSync(join(directory, 'commands.json'), JSON.stringify(logs, null, 2));
        writeFileSync(join(directory, 'result.json'), JSON.stringify(sample, clean, 2));
        const summary = { id, totalMs: sample.totalMs, finished: sample.finished, calls: calls.length, actions: sample.actions, answer: sample.answer, error: sample.error, processesAfter: sample.processesAfter };
        summaries.push(summary); writeFileSync(join(output, 'summary.json'), JSON.stringify(summaries, null, 2)); console.log(JSON.stringify(summary));
      }
    }
  } finally {
    clearInterval(watcher); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    try {
      await model.close();
      writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ stopReason, completedTrials: summaries.length, modelGroups: groups.map(group => ({ group, remaining: harness.core.procs.liveCount(group) })) }));
    } finally { try { await harness.stop(); } finally { context.close(); } }
  }
}
if (import.meta.main) await main();
