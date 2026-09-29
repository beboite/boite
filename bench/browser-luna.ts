import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { startTestCore } from '../packages/core/test/harness.ts';
import { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { runBrowserLoop, jevDecision, validateBrowserRequest } from '../packages/core/src/browser/loop.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { wideTasks } from './browser-wide-tasks.ts';
import { LunaPage, lunaBrowserTool } from './browser-luna-page.ts';
import { LunaCodex } from './browser-luna-codex.ts';
import { BrowserVideo } from './browser-video.ts';
import { LunaCommandGate } from './browser-luna-commands.ts';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const mutations = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'press', 'scroll']);

/** Same public goals and independent graders, two subscription-backed model policies. */
async function main() {
  if (process.env.BOITE_BENCH_LUNA !== '1') throw new Error('Set BOITE_BENCH_LUNA=1 to spend subscription usage on public browser tasks.');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  const codexExecutable = process.env.BOITE_BENCH_CODEX_BINARY;
  if (!binary || !codexExecutable || !process.env.BOITE_BENCH_OUTPUT) throw new Error('Required: BOITE_BROWSER_TEST_BINARY, BOITE_BENCH_CODEX_BINARY, BOITE_BENCH_OUTPUT.');
  const modes = (process.env.BOITE_BENCH_MODES ?? 'luna,hybrid').split(',');
  if (modes.some(mode => !['luna', 'hybrid'].includes(mode))) throw new Error('Modes must be luna and/or hybrid.');
  if (modes.includes('hybrid') && !process.env.TYPESAFE_API_KEY) throw new Error('Hybrid requires TYPESAFE_API_KEY.');
  const repetitions = Number(process.env.BOITE_BENCH_REPETITIONS ?? 3);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Repetitions must be 1..3.');
  const selected = process.env.BOITE_BENCH_TASKS?.split(',');
  const tasks = selected ? wideTasks.filter(task => selected.includes(task.id)) : wideTasks;
  if (!tasks.length || selected?.some(id => !tasks.some(t => t.id === id))) throw new Error('Unknown benchmark task.');
  const output = resolve(process.env.BOITE_BENCH_OUTPUT);
  mkdirSync(output, { recursive: true });
  const workspace = join(output, 'workspace'); mkdirSync(workspace, { recursive: true });
  const recorded = process.env.BOITE_BENCH_RECORD === '1';
  const executable = findBrowser();
  const protocol = {
    date: new Date().toISOString(), model: 'gpt-6-luna', effort: 'max', serviceTier: 'priority',
    modelRoute: 'Codex app-server with existing ChatGPT subscription', modes, repetitions, tasks,
    maxActions: 30, timeoutMs: 120_000, jevPhase: { maxSteps: 10, timeoutMs: 15_000 },
    viewport: { width: 1280, height: 800 }, profile: 'fresh logged-out profile per trial', recorded,
    browserSha256: digest(binary),
    files: Object.fromEntries(['browser-luna.ts', 'browser-luna-commands.ts', 'browser-luna-codex.ts', 'browser-luna-page.ts', 'browser-wide-tasks.ts', 'browser-wide-grade.ts', '../packages/core/src/browser/loop.ts'].map(path => [path, digest(join(import.meta.dir, path))])),
    limits: 'No direct URL navigation, arbitrary scripts, off-origin actions, file access, or external tools. Luna receives richer rendered field metadata than Jev. Hybrid resumes the same browser after needs-agent, error, or phase budget; independent grader is never used to trigger fallback.',
  };
  if (existsSync(join(output, 'protocol.json'))) throw new Error('Use a fresh output directory.');
  writeFileSync(join(output, 'protocol.json'), JSON.stringify(protocol, null, 2));
  const harness = await startTestCore();
  const model = new LunaCodex(harness.core, codexExecutable, workspace);
  const samples: any[] = [];
  try {
    const modelStarted = performance.now();
    const metadata = await model.initialize();
    writeFileSync(join(output, 'model.json'), JSON.stringify({ ...metadata, processStartupMs: performance.now() - modelStarted }, null, 2));
    for (let run = 1; run <= repetitions; run++) for (let offset = 0; offset < tasks.length; offset++) {
      const task = tasks[(offset + run - 1) % tasks.length]!;
      for (const mode of (run % 2 ? modes : [...modes].reverse())) {
        const prefix = `${mode}-${task.id}-${run}`;
        writeFileSync(join(output, 'progress.json'), JSON.stringify({ task: task.id, mode, run, phase: 'starting' }));
        const started = performance.now();
        const sample: any = { task: task.id, mode, run, date: new Date().toISOString(), recorded, verified: false, commands: [], jevDecisions: [], jevUrls: [], fallback: false };
        let daemon: BrowserDaemon | undefined; let video: BrowserVideo | undefined; let heartbeat: ReturnType<typeof setInterval> | undefined;
        let phase = 'startup'; let jevActions = 0; let executionDeadline = Infinity;
        try {
          daemon = await BrowserDaemon.launch(harness.core, prefix, binary, executable, new AbortController().signal);
          const native = daemon.command.bind(daemon);
          const gate = new LunaCommandGate();
          const recordCommand = async (action: string, args: Record<string, unknown> = {}, commandPhase = phase) => {
            if (mutations.has(action) && performance.now() >= executionDeadline) throw new Error('No browser action may start after the execution deadline.');
            const at = performance.now();
            if (phase === 'jev' && mutations.has(action)) jevActions++;
            if (mutations.has(action)) video?.mark(`${phase}: ${action} ${String(args.selector ?? args.key ?? '')}`);
            try {
              const result = await native(action, args);
              if (phase === 'jev' && action === 'evaluate' && result.result && typeof result.result === 'object' && 'url' in result.result) {
                const url = (result.result as any).url;
                if (sample.jevUrls.at(-1) !== url) sample.jevUrls.push(url);
              }
              sample.commands.push({ phase: commandPhase, action, args, ms: performance.now() - at, success: true });
              return result;
            } catch (error) {
              sample.commands.push({ phase: commandPhase, action, args, ms: performance.now() - at, success: false, error: String(error) }); throw error;
            }
          };
          daemon.command = (action, args = {}) => gate.command(() => recordCommand(action, args));
          await daemon.command('viewport', protocol.viewport);
          await daemon.command('navigate', { url: task.url, waitUntil: 'load' });
          sample.startupMs = performance.now() - started;
          if (recorded) video = await BrowserVideo.start(daemon, join(output, `${prefix}.mp4`), `${mode}: ${task.id}`);
          const executionStart = performance.now();
          executionDeadline = executionStart + protocol.timeoutMs;
          heartbeat = setInterval(() => { void gate.heartbeat(() => recordCommand('evaluate', { script: '0' }, 'keepalive')).catch(() => {}); }, 10_000);
          if (mode === 'hybrid') {
            phase = 'jev'; const at = performance.now();
            const signal = AbortSignal.timeout(protocol.jevPhase.timeoutMs);
            const decide = jevDecision(process.env.TYPESAFE_API_KEY!);
            try {
              sample.jevOutcome = await runBrowserLoop(validateBrowserRequest({
                threadId: 'benchmark', pluginId: 'jev-browser', url: task.url, goal: task.goal, values: task.values,
                completion: task.completion, maxSteps: protocol.jevPhase.maxSteps, timeoutMs: protocol.jevPhase.timeoutMs,
              }), daemon, async (state, criteria, abort) => {
                const decisionAt = performance.now();
                const result = await decide(state, criteria, abort);
                sample.jevDecisions.push({ ...result, ms: performance.now() - decisionAt, state, criteria });
                return result;
              }, signal, () => {});
            } catch (error) { sample.jevOutcome = { status: 'error', error: String(error) }; }
            sample.jevMs = performance.now() - at;
            sample.fallback = sample.jevOutcome.status !== 'succeeded';
          }
          const page = new LunaPage(daemon, task, jevActions, sample.jevUrls);
          if (mode === 'luna' || sample.fallback) {
            phase = 'luna';
            const initial = await page.observe();
            const remaining = protocol.timeoutMs - (performance.now() - executionStart);
            if (remaining <= 0) throw new Error('Execution deadline reached before Luna.');
            const result = await model.run(JSON.stringify({
              goal: task.goal, values: task.values, completion: task.completion, observation: initial,
              ...(sample.fallback ? { resume: 'Another browser pilot stopped. Inspect the actual current values and finish the remaining requirements.', priorActions: sample.commands.filter((c: any) => c.phase === 'jev' && mutations.has(c.action)).map((c: any) => ({ action: c.action, args: c.args, success: c.success })) } : {}),
            }), [{ type: 'function', name: lunaBrowserTool.name, description: lunaBrowserTool.description, inputSchema: lunaBrowserTool.parameters }], async (name, args) => {
              if (name !== 'browser') throw new Error(`Unexpected tool ${name}.`);
              if (performance.now() - executionStart >= protocol.timeoutMs) throw new Error('Execution deadline reached. Stop now.');
              const result = await page.executeBatch(args);
              writeFileSync(join(output, 'progress.json'), JSON.stringify({ task: task.id, mode, run, phase: 'luna', executionMs: performance.now() - executionStart, actionCount: page.actionCount, lastCommands: (args as any)?.commands }));
              return result;
            }, remaining);
            sample.model = result;
            sample.toolAttempts = page.attempts;
          }
          sample.executionMs = performance.now() - executionStart;
          sample.totalMs = sample.startupMs + sample.executionMs;
          phase = 'evidence';
          if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
          const evidence = await page.finalEvidence();
          sample.final = evidence.final; sample.grading = evidence.grading;
          sample.actionCount = page.actionCount; sample.urls = page.urls;
          sample.verified = evidence.grading.passed && sample.executionMs < protocol.timeoutMs
            && (!sample.model || sample.model.turn?.status === 'completed') && !sample.model?.timedOut;
          await daemon.command('screenshot', { path: join(output, `${prefix}.png`) });
        } catch (error) { sample.error = String(error); }
        finally {
          if (heartbeat) clearInterval(heartbeat);
          if (video) { try { video.mark(sample.verified ? 'Outcome verified' : 'Outcome not verified'); await Bun.sleep(1200); await video.stop(); } catch (error) { sample.videoError = String(error); } }
          phase = 'cleanup'; const at = performance.now();
          try { await daemon?.close(); } catch (error) { sample.cleanupError = String(error); sample.verified = false; }
          sample.cleanupMs = performance.now() - at;
          sample.processesAfter = harness.core.procs.liveCount(`browser:${prefix}`);
          sample.wallMs = performance.now() - started;
          writeFileSync(join(output, `${prefix}.json`), JSON.stringify(sample, null, 2));
          const summary = { task: task.id, mode, run, verified: sample.verified, fallback: sample.fallback, totalMs: sample.totalMs, executionMs: sample.executionMs, jevMs: sample.jevMs, error: sample.error, processesAfter: sample.processesAfter };
          samples.push(summary); writeFileSync(join(output, 'summary.json'), JSON.stringify(samples, null, 2));
          console.log(JSON.stringify(summary));
        }
      }
    }
  } finally {
    await model.close();
    writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ codexProcessesAfter: harness.core.procs.liveCount('benchmark-luna') }));
    writeFileSync(join(output, 'model-diagnostics.log'), model.diagnostics.join(''));
    await harness.stop();
  }
}
await main();
