import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserLabEngine } from './browser-lab-engine.ts';
import { LabPage } from './browser-lab-page.ts';
import { labTasks } from './browser-lab-tasks.ts';

const live = process.env.BOITE_BENCH_PIN === '1' ? test : test.skip;

live('characterize native pinned public ZIP download and active web target', async () => {
  const { startTestCore } = await import('../packages/core/test/harness.ts');
  const { findBrowser } = await import('../tests/e2e/lib/cdp.ts');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  const output = process.env.BOITE_BENCH_ENGINE_OUTPUT;
  if (!binary || !output) throw new Error('Expected browser binary and private output directory.');
  mkdirSync(output, { recursive: true });
  const harness = await startTestCore();
  const commands: unknown[] = [];
  const summary: any = { pinTab: true, concurrency: 'Two main benchmark lanes may run concurrently; this probe is not latency-matched.' };
  const engine = await createBrowserLabEngine('agent-browser', { core: harness.core, taskId: 'pin-download-probe', binary, executablePath: findBrowser(), log: entry => commands.push(entry) });
  try {
    await engine.command('evaluate', { script: '0', pinTab: true });
    await engine.command('viewport', { width: 1280, height: 800 });
    await engine.command('navigate', { url: 'https://github.com/microsoft/playwright/releases/latest', waitUntil: 'domcontentloaded' });
    const page = new LabPage(engine, labTasks.find(task => task.id === 'github-release-download')!, true, output, performance.now() + 75_000);
    await page.observe('Assets');
    summary.targetBefore = await engine.activeTargetId();
    let zipRef: string | undefined;
    let toggled = false;
    const deadline = performance.now() + 15_000;
    while (!zipRef && performance.now() < deadline) {
      await page.observe('Assets');
      const snapshot = String(page.history.at(-1).snapshot.snapshot);
      zipRef = snapshot.split('\n').find(line => /link "Source code \(zip\)"/.test(line))?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
      if (zipRef) break;
      const assets = snapshot.split('\n').find(line => /button "Assets/.test(line));
      const ref = assets?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
      if (!toggled && ref) {
        await page.execute({ commands: [{ action: 'click', selector: '@' + ref }] });
        expect(page.attempts.at(-1).success).toBe(true);
        if (assets?.includes('expanded=true')) {
          await page.observe('Assets');
          const current = String(page.history.at(-1).snapshot.snapshot).split('\n').find(line => /button "Assets/.test(line));
          const currentRef = current?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
          await page.execute({ commands: [{ action: 'click', selector: '@' + currentRef }] });
        }
        toggled = true;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(zipRef).toBeDefined();
    await page.observe('Source code');
    const currentSnapshot = String(page.history.at(-1).snapshot.snapshot);
    zipRef = currentSnapshot.split('\n').find(line => /link "Source code \(zip\)"/.test(line))?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
    expect(zipRef).toBeDefined();
    try { await page.execute({ commands: [{ action: 'download', selector: '@' + zipRef }] }); }
    catch (error) { summary.observationError = error instanceof Error ? error.stack : String(error); }
    summary.attempts = page.attempts;
    summary.tabsAfter = await engine.command('tabs');
    summary.targetAfter = await engine.activeTargetId();
    const path = join(output, 'download.zip');
    summary.zipExists = existsSync(path);
    summary.zipBytes = summary.zipExists ? statSync(path).size : 0;
    summary.zipSignature = summary.zipExists ? readFileSync(path).subarray(0, 4).toString('hex') : null;
    summary.savedZip = summary.zipBytes > 0 && summary.zipSignature === '504b0304';
    const final = await page.observe();
    summary.finalState = { url: final.text.url, viewport: page.history.at(-1).state.viewport, darkMode: page.history.at(-1).state.darkMode, screenshot: page.history.at(-1).screenshot };
    summary.pinRetainedOriginalWebTarget = summary.targetBefore === summary.targetAfter;
    expect(summary.pinRetainedOriginalWebTarget).toBe(true);
    expect(summary.finalState.url).toContain('/releases/tag/');
    expect(summary.finalState.viewport).toEqual({ width: 1280, height: 800 });
    expect(summary.finalState.darkMode).toBe(false);
    const download = page.attempts.find(attempt => attempt.command.action === 'download');
    expect(download).toBeDefined();
    expect(Boolean(download.success)).toBe(summary.savedZip);
  } finally {
    await engine.close();
    summary.processesAfter = harness.core.procs.liveCount(engine.processGroup);
    writeFileSync(join(output, 'commands.json'), JSON.stringify(commands, null, 2));
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    await harness.stop();
    console.log(JSON.stringify({ pinTab: true, savedZip: summary.savedZip, zipBytes: summary.zipBytes, pinRetainedOriginalWebTarget: summary.pinRetainedOriginalWebTarget, processesAfter: summary.processesAfter }));
    expect(summary.processesAfter).toBe(0);
  }
}, 100_000);
