import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startTestCore } from '../packages/core/test/harness.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { createBrowserLabEngine, type BrowserLabEngine } from './browser-lab-engine.ts';
import { BrowserLabCodex, type BrowserContentItem } from './browser-lab-codex.ts';
import { LabPage, labTool, LabInfrastructureError } from './browser-lab-page.ts';
import { labTasks } from './browser-lab-tasks.ts';
import { BrowserLabRecording } from './browser-lab-recording.ts';
import { createLabContext } from './browser-lab-isolation.ts';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const arms = ['agent-browser-dom', 'playwright-dom', 'agent-browser-vision', 'playwright-vision'] as const;

async function main() {
  if (process.env.BOITE_BENCH_LAB !== '1') throw new Error('Set BOITE_BENCH_LAB=1 for live subscription-backed public-site experiments.');
  const output = resolve(process.env.BOITE_BENCH_OUTPUT ?? '');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY, codexBinary = process.env.BOITE_BENCH_CODEX_BINARY;
  if (!binary || !codexBinary || !process.env.BOITE_BENCH_OUTPUT) throw new Error('Browser binary, Codex binary and fresh output directory required.');
  if (existsSync(join(output, 'protocol.json'))) throw new Error('Use a fresh campaign directory.');
  const selected = process.env.BOITE_BENCH_TASKS?.split(',');
  const tasks = selected ? selected.map(id => { const task = labTasks.find(t => t.id === id); if (!task) throw new Error('Unknown task ' + id); return task; }) : labTasks;
  const modes = process.env.BOITE_BENCH_MODES?.split(',') ?? [...arms];
  if (modes.some(mode => !arms.includes(mode as any))) throw new Error('Unknown comparison mode.');
  const repetitions = Number(process.env.BOITE_BENCH_REPETITIONS ?? 2);
  const timeoutMs = Number(process.env.BOITE_BENCH_TIMEOUT_MS ?? 180_000);
  const recorded = process.env.BOITE_BENCH_RECORD === '1';
  const isolatedContext = process.env.BOITE_BENCH_ISOLATED_CONTEXT === '1';
  const ffmpegPath = process.env.BOITE_BENCH_FFMPEG;
  if (recorded && !ffmpegPath) throw new Error('BOITE_BENCH_FFMPEG is required for recording.');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3 || timeoutMs < 30_000 || timeoutMs > 360_000) throw new Error('Invalid campaign limits.');
  mkdirSync(output, { recursive: true });
  const workspace = join(output, 'workspace'); mkdirSync(workspace);
  const protocol = { date: new Date().toISOString(), tasks, modes, repetitions, timeoutMs, recorded, isolatedContext, campaignLane: process.env.BOITE_BENCH_LANE ?? 'serial', campaignConcurrency: Number(process.env.BOITE_BENCH_CONCURRENCY ?? 1), maxActions: 60, model: process.env.BOITE_BENCH_MODEL ?? 'gpt-6-luna', effort: 'max', tier: 'priority',
    resultDelivery: 'steer for both DOM and vision; dynamic image output was not visible to Luna in two probes', profiles: 'fresh isolated logged-out browser per attempt', viewport: { width: 1280, height: 800 }, colorScheme: 'light',
    grading: 'Independent review of all rubric requirements using saved per-action state, screenshot, tabs, downloaded files and final answer. Self-reported completion is not a pass.',
    limitations: ['Both action engines share agent-browser-owned browser launch.', 'This compares action and observation stacks together; installed engine versions and snapshot APIs are recorded per attempt.', 'Screenshots are captured in both arms for independent evidence; only vision arms receive them.', 'No CAPTCHA solving, account mutation, purchases or public messages.'],
    sourceHashes: Object.fromEntries(['browser-lab.ts', 'browser-lab-page.ts', 'browser-lab-tasks.ts', 'browser-lab-codex.ts', 'browser-lab-engine.ts', 'browser-lab-native.ts', 'browser-lab-isolation.ts', 'browser-lab-recording.ts'].map(file => [file, sha(join(import.meta.dir, file))])),
    binaryHash: sha(binary),
  };
  writeFileSync(join(output, 'protocol.json'), JSON.stringify(protocol, null, 2));
  mkdirSync(join(output, 'source'));
  for (const file of Object.keys(protocol.sourceHashes)) writeFileSync(join(output, 'source', file), readFileSync(join(import.meta.dir, file)));
  const harness = await startTestCore();
  let context: ReturnType<typeof createLabContext>;
  try { context = createLabContext(harness.core, output, isolatedContext); }
  catch (error) { await harness.stop(); throw error; }
  writeFileSync(join(output, 'context.json'), JSON.stringify(context.metadata, null, 2));
  let model: BrowserLabCodex;
  try { model = new BrowserLabCodex(context.core, codexBinary, workspace, { model: protocol.model, resultDelivery: 'steer' }); }
  catch (error) { try { await harness.stop(); } finally { context.close(); } throw error; }
  const modelGroups = [model.processKey];
  const summaries: any[] = [];
  const cancellation = new AbortController();
  let stopReason: string | undefined;
  const stop = (reason: string) => {
    if (stopReason) return;
    stopReason = reason;
    cancellation.abort(new Error(reason));
    void model.close().catch(() => {});
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  const stopWatcher = setInterval(() => { if (existsSync(join(output, 'stop.requested'))) stop('stop.requested'); }, 500);
  stopWatcher.unref();
  const owned = () => writeFileSync(join(output, 'owned-processes.json'), JSON.stringify({ runnerPid: process.pid, parentPid: process.ppid, coreDataDir: harness.dataDir,
    model: modelGroups.flatMap(group => harness.core.procs.liveOf(group)),
    browsers: summaries.map(sample => sample.id),
  }, null, 2));
  owned();
  try {
    writeFileSync(join(output, 'model.json'), JSON.stringify(await model.initialize(), null, 2));
    campaign: for (let run = 1; run <= repetitions; run++) for (let offset = 0; offset < tasks.length; offset++) {
      const task = tasks[(offset + run - 1) % tasks.length]!;
      // Counterbalance mode order by both task and repetition.
      const order = modes.map((_, i) => modes[(i + offset + run - 1) % modes.length]!);
      for (const mode of order) {
        if (stopReason) break campaign;
        const id = `${mode}-${task.id}-${run}`, directory = join(output, id);
        mkdirSync(directory);
        const start = performance.now(), logs: unknown[] = [];
        const sample: any = { id, mode, task: task.id, run, startedAt: new Date().toISOString(), rubric: task.rubric, grading: 'pending-independent-review' };
        let engine: BrowserLabEngine | undefined, page: LabPage | undefined, recording: BrowserLabRecording | undefined;
        writeFileSync(join(output, 'progress.json'), JSON.stringify({ id, phase: 'startup' }));
        try {
          if (!model.isUsable) {
            await model.close();
            model = new BrowserLabCodex(context.core, codexBinary, workspace, { model: protocol.model, resultDelivery: 'steer' });
            modelGroups.push(model.processKey);
            writeFileSync(join(output, `model-${modelGroups.length}.json`), JSON.stringify(await model.initialize(), null, 2));
          }
          engine = await createBrowserLabEngine(mode.startsWith('playwright') ? 'playwright' : 'agent-browser', { core: harness.core, taskId: id, binary, executablePath: findBrowser(), signal: cancellation.signal, log: entry => logs.push(entry) });
          owned();
          writeFileSync(join(directory, 'owned-processes.json'), JSON.stringify(harness.core.procs.liveOf(engine.processGroup), null, 2));
          sample.engine = engine.metadata;
          await engine.command('viewport', protocol.viewport);
          await engine.command('navigate', { url: task.url, waitUntil: 'domcontentloaded' });
          if (recorded) recording = await BrowserLabRecording.start(engine, { core: harness.core, output: join(directory, 'recording.mp4'), ffmpegPath: ffmpegPath!, fps: 10 });
          sample.startupMs = performance.now() - start;
          const executionStart = performance.now();
          const deadline = executionStart + timeoutMs;
          page = new LabPage(engine, task, mode.endsWith('vision'), directory, deadline, protocol.maxActions);
          const observation = await page.observe();
          const input: BrowserContentItem[] = [{ type: 'inputText', text: JSON.stringify({ goal: task.goal, observation: observation.text, instruction: 'Complete every requested requirement, then use finish with the extracted facts and any unmet requirement. Do not guess facts. Search observations with query when truncated. Dismiss obstructing consent or sign-in prompts. An action error is recoverable: inspect the actual current page before deciding what to do.' }) }];
          if (observation.imageUrl) input.push({ type: 'inputImage', imageUrl: observation.imageUrl });
          sample.model = await model.run(input, [labTool(page.vision)], async (name, args) => {
            if (name !== 'browser') throw new Error('Unexpected tool ' + name);
            let result;
            try { result = await page!.execute(args); }
            catch (error) { if (error instanceof LabInfrastructureError && error.invalidatesCampaign) stop(error.message); throw error; }
            writeFileSync(join(output, 'progress.json'), JSON.stringify({ id, phase: 'model', seconds: Math.round((performance.now() - executionStart) / 1000), actions: page!.actionCount, last: args }));
            return result;
          }, Math.max(1, deadline - performance.now()));
          sample.executionMs = performance.now() - executionStart;
          sample.totalMs = sample.startupMs + sample.executionMs;
        } catch (error) { sample.error = error instanceof Error ? error.stack : String(error); if (error instanceof LabInfrastructureError && error.invalidatesCampaign) stop(error.message); }
        finally {
          if (stopReason) sample.cancelled = stopReason;
          sample.elapsedBeforeCleanupMs = performance.now() - start;
          sample.answer = page?.answer;
          sample.finished = page?.finished ?? false;
          sample.actions = page?.actionCount ?? 0;
          sample.attempts = page?.attempts ?? [];
          sample.visited = page?.visited ?? [];
          sample.observations = page?.history.map(item => ({ id: item.id, url: item.state.url, title: item.state.title, errors: item.errors, observationMs: item.observationMs })) ?? [];
          if (existsSync(join(directory, 'download.zip'))) {
            const file = join(directory, 'download.zip'); sample.download = { bytes: statSync(file).size, headerHex: readFileSync(file).subarray(0, 4).toString('hex'), sha256: sha(file) };
          }
          try { sample.recording = await recording?.stop(); } catch (error) { sample.recordingError = String(error); }
          try { await engine?.close(); } catch (error) { sample.cleanupError = String(error); }
          sample.processesAfter = harness.core.procs.liveCount(`browser:${id}`);
          writeFileSync(join(directory, 'commands.json'), JSON.stringify(logs, null, 2));
          writeFileSync(join(directory, 'result.json'), JSON.stringify(sample, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? { omittedImage: true, length: value.length, sha256: createHash('sha256').update(value).digest('hex') } : value, 2));
          const summary = { id, totalMs: sample.totalMs, elapsedBeforeCleanupMs: sample.elapsedBeforeCleanupMs, finished: sample.finished, actions: sample.actions, error: sample.error, timedOut: sample.model?.timedOut, answer: sample.answer, processesAfter: sample.processesAfter };
          summaries.push(summary); writeFileSync(join(output, 'summary.json'), JSON.stringify(summaries, null, 2));
          console.log(JSON.stringify(summary));
        }
      }
    }
  } finally {
    clearInterval(stopWatcher);
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    await model.close();
    writeFileSync(join(output, 'model-diagnostics.log'), model.diagnostics.join(''));
    writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ stopReason, completedTrials: summaries.length, modelGroups: modelGroups.map(group => ({ group, remaining: harness.core.procs.liveCount(group) })) }));
    try { await harness.stop(); } finally { context.close(); }
  }
}
await main();
