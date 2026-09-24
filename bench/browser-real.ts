import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startTestCore, echoThread, waitFor } from '../packages/core/test/harness.ts';
import { RECOMMENDED, verifyPluginDownload } from '../packages/core/src/plugins.ts';
import { platformKey } from '../packages/core/src/plugins/manifest.ts';
import { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';

// Paid, live-site benchmark. No fixtures, login state, selector walkthroughs or
// substituted model responses. Keep the shipped loop unchanged for the baseline.
export interface SiteTask { id: string; url: string; goal: string; values: Record<string, string>; completion: { text: string; url: string } }
export const tasks: SiteTask[] = [
  { id: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page',
    goal: 'Use Wikipedia search to find Ada Lovelace, then open her article. Stop when the article describing her work on the Analytical Engine is displayed.',
    values: { search: 'Ada Lovelace' },
    completion: { text: 'Analytical Engine', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } },
  { id: 'github', url: 'https://github.com/vercel-labs/agent-browser',
    goal: 'Find release v0.37.1 of agent-browser using the repository interface. Open that release and expand its assets so the Windows x64 executable is visible. Do not download anything.',
    values: { version: 'v0.37.1' },
    completion: { text: 'agent-browser-win32-x64.exe', url: 'https://github.com/vercel-labs/agent-browser/releases/tag/v0.37.1' } },
  { id: 'govuk', url: 'https://www.gov.uk/',
    goal: 'Search GOV.UK for renewing an adult passport. Open the official Renew or replace your adult passport guide and its Renew section. Stop at the renewal instructions, without starting an application.',
    values: { search: 'renew adult passport' },
    completion: { text: 'Renew online', url: 'https://www.gov.uk/renew-adult-passport/renew' } },
];

if (import.meta.main) {
  if (process.env.BOITE_BENCH_BROWSER !== '1') throw new Error('Set BOITE_BENCH_BROWSER=1 to authorize paid requests to public live sites.');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  const output = process.env.BOITE_BENCH_OUTPUT;
  if (!binary || !output || !process.env.TYPESAFE_API_KEY) throw new Error('Required: BOITE_BROWSER_TEST_BINARY, BOITE_BENCH_OUTPUT, TYPESAFE_API_KEY.');
  const repetitions = Number(process.env.BOITE_BENCH_REPETITIONS ?? 3);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('BOITE_BENCH_REPETITIONS must be from 1 to 10.');
  mkdirSync(output, { recursive: true });
  const manifest = RECOMMENDED.find(item => item.id === 'jev-browser')!;
  verifyPluginDownload(new Uint8Array(await Bun.file(binary).arrayBuffer()), manifest.artifacts[platformKey() as keyof typeof manifest.artifacts]!.sha256);
  const realCommand = BrowserDaemon.prototype.command;
  const realClose = BrowserDaemon.prototype.close;
  const realFetch = globalThis.fetch;
  let sample: any;
  let evidence = false;
  BrowserDaemon.prototype.command = async function(action, args) {
    if (!evidence && action === 'navigate') await realCommand.call(this, 'viewport', { width: 1280, height: 800 });
    const start = performance.now();
    try {
      const result = await realCommand.call(this, action, args);
      if (!evidence && action === 'snapshot') sample.snapshots.push({ characters: String(result.snapshot).length, refs: Object.keys(result.refs as object ?? {}).length });
      if (!evidence && action === 'evaluate' && result.result && typeof result.result === 'object') sample.observations.push(result.result);
      if (!evidence && action === 'navigate') sample.startupMs = performance.now() - sample.started;
      return result;
    } catch (error) {
      if (!evidence) sample.errors.push({ action, message: String(error) });
      throw error;
    } finally {
      if (!evidence) sample.commands.push({ action, args, ms: performance.now() - start });
    }
  };
  BrowserDaemon.prototype.close = async function() {
    sample.totalMs = performance.now() - sample.started;
    sample.executionMs = sample.totalMs - (sample.startupMs ?? 0);
    evidence = true;
    try {
      const observed = await realCommand.call(this, 'evaluate', { script: '({url:location.href,title:document.title,text:document.body?.innerText??""})' });
      sample.final = observed.result;
      const expected = tasks.find(t => t.id === sample.task)!.completion;
      sample.destinationVerified = sample.final.url === expected.url && sample.final.text.includes(expected.text);
      sample.workflowVerified = sample.task !== 'govuk' || sample.observations.some((o: {url: string}) => {
        const url = new URL(o.url);
        return url.pathname.startsWith('/search/') && url.searchParams.get('keywords') === 'renew adult passport';
      });
      sample.verified = sample.destinationVerified && sample.workflowVerified;
      await realCommand.call(this, 'screenshot', { path: resolve(output, `${sample.task}-${sample.run}.png`), fullPage: true });
    } catch (error) { sample.evidenceError = String(error); }
    finally { evidence = false; }
    const start = performance.now();
    await realClose.call(this);
    sample.cleanupMs = performance.now() - start;
  };
  globalThis.fetch = (async (input, options) => {
    if (!String(input).startsWith('https://api.typesafe.ai/')) return realFetch(input, options);
    const start = performance.now();
    const response = await realFetch(input, options);
    const body = await response.clone().json();
    const request = JSON.parse(String(options?.body));
    sample.decisions.push({ ms: performance.now() - start, status: response.status, answers: body.answers, usage: body.usage, state: request.state, criteria: request.questions.action.criteria });
    return response;
  }) as typeof fetch;
  const results: any[] = [];
  try {
    // Rotate task order between repetitions; all runs have fresh profiles.
    for (let run = 1; run <= repetitions; run++) for (let offset = 0; offset < tasks.length; offset++) {
      const task = tasks[(offset + run - 1) % tasks.length]!;
      const harness = await startTestCore();
      try {
        const client = await harness.connect();
        const { threadId } = await echoThread(harness, client);
        const directory = join(harness.dataDir, 'plugins', manifest.id);
        mkdirSync(directory, { recursive: true });
        copyFileSync(binary, join(directory, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'));
        writeFileSync(join(directory, 'installed.json'), JSON.stringify({ schema: 1, origin: 'recommended', source: null, installedAt: Date.now(), manifest }));
        await client.call('browser.configure', { enabled: true, executablePath: findBrowser() });
        sample = { arm: 'jev-shipped', model: 'jev-1.13.0', date: new Date().toISOString(), task: task.id, run, started: performance.now(), commands: [], snapshots: [], errors: [], decisions: [], observations: [], verified: false };
        const { id: taskName, ...request } = task;
        const started = await client.call('browser.start', { ...request, threadId, pluginId: 'jev-browser', maxSteps: 30, timeoutMs: 120_000 });
        await waitFor(() => harness.core.browser.list(threadId)[0]?.finishedAt !== null, 145_000);
        const done = (await client.call('browser.list', { threadId }))[0]!;
        await waitFor(() => harness.core.procs.liveCount(`browser:${started.id}`) === 0, 15_000);
        Object.assign(sample, { status: done.status, message: done.message, steps: done.step, inputTokens: done.inputTokens, processesAfter: harness.core.procs.liveCount(`browser:${started.id}`) });
        delete sample.started;
        writeFileSync(join(output, `${task.id}-${run}.json`), JSON.stringify(sample, null, 2));
        const summary = { arm: sample.arm, task: task.id, run, status: sample.status, verified: sample.verified, destinationVerified: sample.destinationVerified, workflowVerified: sample.workflowVerified, startupMs: sample.startupMs, executionMs: sample.executionMs, totalMs: sample.totalMs, cleanupMs: sample.cleanupMs, calls: sample.decisions.length, inputTokens: sample.inputTokens, snapshots: sample.snapshots, errors: sample.errors, finalUrl: sample.final?.url };
        results.push(summary);
        writeFileSync(join(output, 'summary.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(summary));
      } finally { await harness.stop(); }
    }
  } finally {
    BrowserDaemon.prototype.command = realCommand;
    BrowserDaemon.prototype.close = realClose;
    globalThis.fetch = realFetch;
  }
}
