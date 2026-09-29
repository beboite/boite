import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { startTestCore, echoThread, waitFor } from '../packages/core/test/harness.ts';
import { RECOMMENDED, verifyPluginDownload } from '../packages/core/src/plugins.ts';
import { platformKey } from '../packages/core/src/plugins/manifest.ts';
import { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { wideTasks, type WideTask } from './browser-wide-tasks.ts';
import { gradeWide, type WideObservation } from './browser-wide-grade.ts';
import type { BrowserVideo } from './browser-video.ts';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const mutations = new Set(['click', 'fill', 'select', 'check', 'uncheck']);

/** A separate, frozen suite. Failed trials remain in the denominator and are never silently replaced. */
async function main() {
  if (process.env.BOITE_BENCH_BROWSER !== '1') throw new Error('Set BOITE_BENCH_BROWSER=1 for paid requests on public live sites.');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  const outputRaw = process.env.BOITE_BENCH_OUTPUT;
  if (!binary || !outputRaw || !process.env.TYPESAFE_API_KEY) throw new Error('Required: BOITE_BROWSER_TEST_BINARY, BOITE_BENCH_OUTPUT, TYPESAFE_API_KEY.');
  const repetitions = Number(process.env.BOITE_BENCH_REPETITIONS ?? 3);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('BOITE_BENCH_REPETITIONS must be 1..10.');
  const selected = process.env.BOITE_BENCH_TASKS?.split(',');
  const tasks = selected ? wideTasks.filter(task => selected.includes(task.id)) : wideTasks;
  if (!tasks.length || selected?.some(id => !tasks.some(task => task.id === id))) throw new Error('BOITE_BENCH_TASKS contains an unknown task.');
  const output = resolve(outputRaw);
  const recorded = process.env.BOITE_BENCH_RECORD === '1';
  mkdirSync(output, { recursive: true });
  const manifest = RECOMMENDED.find(item => item.id === 'jev-browser')!;
  verifyPluginDownload(new Uint8Array(await Bun.file(binary).arrayBuffer()), manifest.artifacts[platformKey() as keyof typeof manifest.artifacts]!.sha256);
  const protocol = {
    date: new Date().toISOString(), model: 'jev-1.13.0', driver: 'agent-browser 0.37.1 native JSONL',
    loopSha256: digest(join(import.meta.dir, '../packages/core/src/browser/loop.ts')),
    manifestSha256: digest(join(import.meta.dir, 'browser-wide-tasks.ts')),
    repetitions, tasks, viewport: { width: 1280, height: 800 }, maxSteps: 30, timeoutMs: 120_000,
    recorded, profile: 'fresh logged-out profile for every trial',
  };
  const protocolPath = join(output, 'protocol.json');
  if (existsSync(protocolPath)) throw new Error('Output already contains a protocol; use a fresh output directory.');
  writeFileSync(protocolPath, JSON.stringify(protocol, null, 2), { flag: 'wx' });
  const realCommand = BrowserDaemon.prototype.command;
  const realClose = BrowserDaemon.prototype.close;
  const realFetch = globalThis.fetch;
  let sample: any;
  let activeTask: WideTask;
  let collecting = false;
  let instrumenting = false;
  let video: BrowserVideo | undefined;
  BrowserDaemon.prototype.command = async function(action, args) {
    if (!collecting || instrumenting) return realCommand.call(this, action, args);
    if (action === 'navigate') await realCommand.call(this, 'viewport', protocol.viewport);
    if (mutations.has(action)) {
      const decision = sample.decisions.at(-1);
      const choice = decision?.answers?.action?.choice;
      video?.mark(`Jev: ${String(decision?.criteria?.[choice] ?? action).slice(0, 180)}`);
    }
    const started = performance.now();
    try {
      const result = await realCommand.call(this, action, args);
      if (action === 'evaluate' && result.result && typeof result.result === 'object' && typeof (result.result as any).url === 'string') sample.observations.push(result.result);
      if (action === 'snapshot') sample.snapshots.push({ characters: String(result.snapshot).length, refs: Object.keys(result.refs as object ?? {}).length });
      if (action === 'navigate') {
        sample.startupMs = performance.now() - sample.started;
        if (recorded) {
          instrumenting = true;
          try {
            const { BrowserVideo } = await import('./browser-video.ts');
            video = await BrowserVideo.start(this, join(output, `${sample.task}-${sample.run}.mp4`), activeTask.id);
          } finally { instrumenting = false; }
        }
      }
      sample.commands.push({ action, args, ms: performance.now() - started, success: true });
      return result;
    } catch (error) {
      sample.commands.push({ action, args, ms: performance.now() - started, success: false, error: String(error) });
      throw error;
    }
  };
  BrowserDaemon.prototype.close = async function() {
    if (!collecting) return realClose.call(this);
    sample.totalMs = performance.now() - sample.started;
    sample.executionMs = sample.totalMs - (sample.startupMs ?? 0);
    instrumenting = true;
    try {
      const selectors = activeTask.grader.all.flatMap(predicate => predicate.kind === 'control' ? [predicate.selector] : []);
      const raw = await realCommand.call(this, 'evaluate', { script: `({url:location.href,title:document.title,text:document.body?.innerText??'',controls:Object.fromEntries(${JSON.stringify(selectors)}.map(s=>[s,Array.from(document.querySelectorAll(s)).map(e=>({value:e.value,checked:e.checked,expanded:e.getAttribute('aria-expanded')===null?undefined:e.getAttribute('aria-expanded')==='true'}))]))})` });
      sample.final = raw.result as WideObservation;
      sample.grading = gradeWide(activeTask, sample.final, sample.observations.map((o: any) => o.url), sample.commands.filter((c: any) => c.success && mutations.has(c.action)).length);
      await realCommand.call(this, 'screenshot', { path: join(output, `${sample.task}-${sample.run}.png`) });
    } catch (error) { sample.evidenceError = String(error); }
    finally {
      if (video) {
        try {
          video.mark(sample.grading?.passed ? 'Independent outcome checks passed' : 'Independent outcome checks did not pass');
          await Bun.sleep(1200);
          await video.stop();
        } catch (error) { sample.videoError = String(error); }
        video = undefined;
      }
      const started = performance.now();
      try { await realClose.call(this); }
      finally { sample.cleanupMs = performance.now() - started; instrumenting = false; }
    }
  };
  globalThis.fetch = (async (input, options) => {
    if (!collecting || !String(input).startsWith('https://api.typesafe.ai/')) return realFetch(input, options);
    const started = performance.now();
    const response = await realFetch(input, options);
    let body: any;
    try { body = await response.clone().json(); } catch { body = null; }
    const request = JSON.parse(String(options?.body));
    sample.decisions.push({ ms: performance.now() - started, status: response.status, answers: body?.answers, usage: body?.usage, state: request.state, criteria: request.questions.action.criteria });
    return response;
  }) as typeof fetch;
  const summaries: any[] = [];
  try {
    for (let run = 1; run <= repetitions; run++) for (let offset = 0; offset < tasks.length; offset++) {
      activeTask = tasks[(offset + run - 1) % tasks.length]!;
      const task = activeTask;
      const harness = await startTestCore();
      sample = { task: task.id, site: task.site, category: task.category, run, recorded, date: new Date().toISOString(), started: performance.now(), commands: [], snapshots: [], decisions: [], observations: [], verified: false };
      let taskId: string | undefined;
      try {
        const client = await harness.connect();
        const { threadId } = await echoThread(harness, client);
        const directory = join(harness.dataDir, 'plugins', manifest.id);
        mkdirSync(directory, { recursive: true });
        copyFileSync(binary, join(directory, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'));
        writeFileSync(join(directory, 'installed.json'), JSON.stringify({ schema: 1, origin: 'recommended', source: null, installedAt: Date.now(), manifest }));
        await client.call('browser.configure', { enabled: true, executablePath: findBrowser() });
        sample.started = performance.now(); collecting = true;
        const request = await client.call('browser.start', { url: task.url, goal: task.goal, values: task.values, completion: task.completion, threadId, pluginId: 'jev-browser', maxSteps: 30, timeoutMs: 120_000 });
        taskId = request.id;
        await waitFor(() => harness.core.browser.list(threadId)[0]?.finishedAt != null, 150_000);
        const done = (await client.call('browser.list', { threadId }))[0]!;
        await waitFor(() => harness.core.procs.liveCount(`browser:${taskId}`) === 0, 15_000);
        Object.assign(sample, { status: done.status, message: done.message, steps: done.step, inputTokens: done.inputTokens, processesAfter: harness.core.procs.liveCount(`browser:${taskId}`) });
        sample.verified = done.status === 'succeeded' && sample.grading?.passed === true && sample.processesAfter === 0;
      } catch (error) {
        sample.runnerError = String(error);
        sample.verified = false;
      } finally {
        await harness.stop(); collecting = false;
        if (taskId) sample.processesAfter = harness.core.procs.liveCount(`browser:${taskId}`);
        delete sample.started;
        writeFileSync(join(output, `${task.id}-${run}.json`), JSON.stringify(sample, null, 2), { flag: 'wx' });
      }
      const row = { task: task.id, site: task.site, category: task.category, run, recorded, status: sample.status ?? 'runner-error', verified: sample.verified, grading: sample.grading, message: sample.message, startupMs: sample.startupMs, executionMs: sample.executionMs, totalMs: sample.totalMs, cleanupMs: sample.cleanupMs, calls: sample.decisions.length, inputTokens: sample.inputTokens ?? 0, actions: sample.commands.filter((c: any) => c.success && mutations.has(c.action)).length, finalUrl: sample.final?.url, finalTitle: sample.final?.title, evidenceError: sample.evidenceError, runnerError: sample.runnerError, videoError: sample.videoError, processesAfter: sample.processesAfter };
      summaries.push(row);
      writeFileSync(join(output, 'summary.json'), JSON.stringify(summaries, null, 2));
      console.log(JSON.stringify(row));
    }
  } finally {
    collecting = false;
    BrowserDaemon.prototype.command = realCommand;
    BrowserDaemon.prototype.close = realClose;
    globalThis.fetch = realFetch;
  }
  console.log(JSON.stringify({ completed: summaries.length, passed: summaries.filter(row => row.verified).length, failed: summaries.filter(row => !row.verified).length }));
}

if (import.meta.main) await main();
