import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserLabEngine } from './browser-lab-engine.ts';
import { LabPage } from './browser-lab-page.ts';
import { labTasks } from './browser-lab-tasks.ts';

const live = process.env.BOITE_BENCH_PREFLIGHT === '1' ? test : test.skip;

// Independent, read-only evidence. Actions below go through the exact LabPage
// ref validation and dispatch used by the model campaign.
const menuEvidence = `(() => {
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const label = e => (e.getAttribute('aria-label') || e.innerText || '').trim();
  return {
    viewport: {width: innerWidth, height: innerHeight},
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    expanded: Array.from(document.querySelectorAll('[aria-expanded="true"]')).filter(visible).map(label),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], dialog')).filter(visible).map(e => ({role: e.getAttribute('role') || e.tagName.toLowerCase(), label: label(e), text: e.innerText})),
    fields: Array.from(document.querySelectorAll('input')).filter(visible).map(e => ({role: e.getAttribute('role'), label: e.getAttribute('aria-label'), placeholder: e.placeholder, value: e.value})),
    text: document.body.innerText
  };
})()`;

live('latest engines open the actual GitHub Labels menu through LabPage refs and clean up owned groups', async () => {
  const { startTestCore } = await import('../packages/core/test/harness.ts');
  const { findBrowser } = await import('../tests/e2e/lib/cdp.ts');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  const output = process.env.BOITE_BENCH_ENGINE_OUTPUT;
  if (!binary || !output || !process.env.BOITE_BENCH_PLAYWRIGHT_MODULE) throw new Error('Expected browser binary, Playwright module and output environment paths.');
  mkdirSync(output, { recursive: true });
  const task = labTasks.find(task => task.id === 'github-issue-investigation')!;
  const harness = await startTestCore();
  const summaries: unknown[] = [];
  try {
    for (const kind of ['agent-browser', 'playwright'] as const) {
      const directory = join(output, kind);
      mkdirSync(directory, { recursive: true });
      const commands: unknown[] = [];
      const engine = await createBrowserLabEngine(kind, { core: harness.core, taskId: `lab-preflight-${kind}`, binary, executablePath: findBrowser(), log: entry => commands.push(entry) });
      const summary: Record<string, unknown> = { kind, metadata: engine.metadata, success: false };
      let page: LabPage | undefined;
      try {
        await engine.command('viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await engine.command('navigate', { url: task.url, waitUntil: 'domcontentloaded' });
        page = new LabPage(engine, task, true, directory, performance.now() + 90_000);
        const rendering: unknown[] = [];
        async function verifyRendering(phase: string) {
          const observed = (await engine.command('evaluate', { script: menuEvidence })).result as any;
          const capture = page!.history.at(-1);
          const png = readFileSync(capture.screenshot);
          const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
          rendering.push({ phase, viewport: observed.viewport, colorScheme: observed.colorScheme, pngSize: size, screenshot: capture.screenshot });
          summary.rendering = rendering;
          expect(observed.viewport).toEqual({ width: 1280, height: 800 });
          expect(observed.colorScheme).toBe('light');
          expect(size).toEqual([1280, 800]);
        }
        let observation = await page.observe('label');
        await verifyRendering('initial-navigation-observation-screenshot');
        let line: string | undefined;
        const readyDeadline = performance.now() + 15_000;
        do {
          expect(observation.text.errors).toEqual([]);
          line = String(observation.text.snapshot).split('\n').find(line => /- button "(?:Filter by )?Labels?"/i.test(line));
          if (line) break;
          observation = await page.observe('label');
        } while (performance.now() < readyDeadline);
        summary.readinessObservations = page.history.length;
        expect(line).toBeDefined();
        const ref = line?.match(/\[[^\]]*\bref=([^\]\s,]+)[^\]]*\]/)?.[1];
        expect(ref).toBeDefined();
        // This exact native form was silently dropped by the earlier parser.
        if (kind === 'agent-browser') expect(line).toMatch(/\[expanded=false, ref=/);
        const result = await page.execute({ commands: [{ action: 'click', selector: '@' + ref }] });
        const text = result.contentItems.find(item => item.type === 'inputText') as { text: string };
        const response = JSON.parse(text.text);
        expect(response.results).toHaveLength(1);
        expect(response.results[0].success).toBe(true);
        expect(response.errors).toEqual([]);
        expect(page.actionCount).toBe(1);
        expect(page.attempts[0].command.selector).toBe('@' + ref);
        let actual = (await engine.command('evaluate', { script: menuEvidence })).result as any;
        const menuDeadline = performance.now() + 15_000;
        while (!actual.dialogs.some((dialog: any) => dialog.text.includes('browser-chromium')) && performance.now() < menuDeadline) {
          await page.observe();
          actual = (await engine.command('evaluate', { script: menuEvidence })).result as any;
        }
        const fullSnapshot = String(page.history.at(-1).snapshot.snapshot);
        // Expanded state and independently visible label content prove that the
        // actual menu opened, beyond a successful native click response.
        expect(actual.expanded.some((label: string) => /^(?:Filter by )?Labels?$/i.test(label))).toBe(true);
        expect(actual.dialogs.some((dialog: any) => dialog.text.includes('browser-chromium'))).toBe(true);
        expect(fullSnapshot).toContain('browser-chromium');
        await verifyRendering('opened-menu-observation-screenshot');
        writeFileSync(join(directory, 'opened-menu.json'), JSON.stringify(actual, null, 2));
        Object.assign(summary, { success: true, observedButton: line, ref, openedMenu: { expanded: actual.expanded, dialogs: actual.dialogs, fields: actual.fields }, screenshot: page.history.at(-1).screenshot });
        const firstTabId = page.history.at(-1).tabs.tabs.find((tab: any) => tab.active).tabId;
        const repoUrl = page.history.at(-1).state.links.find((link: any) => link.url === 'https://github.com/microsoft/playwright')?.url;
        expect(repoUrl).toBeDefined();
        await page.execute({ commands: [{ action: 'tab_new', url: task.url }] });
        expect(page.attempts.at(-1).success).toBe(true);
        await verifyRendering('new-tab-navigation-observation-screenshot');
        await page.execute({ commands: [{ action: 'open', url: repoUrl }] });
        expect(page.attempts.at(-1).success).toBe(true);
        await verifyRendering('second-navigation-observation-screenshot');
        await page.execute({ commands: [{ action: 'back' }] });
        expect(page.attempts.at(-1).success).toBe(true);
        await verifyRendering('back-navigation-observation-screenshot');
        await page.execute({ commands: [{ action: 'tab_switch', tabId: firstTabId }] });
        expect(page.attempts.at(-1).success).toBe(true);
        await verifyRendering('switched-tab-observation-screenshot');
      } catch (error) {
        summary.error = error instanceof Error ? error.stack : String(error);
        throw error;
      } finally {
        await engine.close();
        summary.processesAfter = harness.core.procs.liveCount(engine.processGroup);
        expect(summary.processesAfter).toBe(0);
        summaries.push(summary);
        writeFileSync(join(directory, 'commands.json'), JSON.stringify(commands, null, 2));
        writeFileSync(join(directory, 'attempts.json'), JSON.stringify(page?.attempts ?? [], null, 2));
        writeFileSync(join(output, 'summary.json'), JSON.stringify(summaries, null, 2));
      }
    }
  } finally { await harness.stop(); }
}, 150_000);

live('characterize release ZIP failures and verify rendering through cross-origin navigation', async () => {
  const { startTestCore } = await import('../packages/core/test/harness.ts');
  const { findBrowser } = await import('../tests/e2e/lib/cdp.ts');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  const output = process.env.BOITE_BENCH_ENGINE_OUTPUT;
  if (!binary || !output) throw new Error('Expected browser binary and output paths.');
  const harness = await startTestCore();
  const summaries: any[] = [];
  try {
    for (const kind of ['agent-browser', 'playwright'] as const) {
      const directory = join(output, `${kind}-release`);
      mkdirSync(directory, { recursive: true });
      const commands: any[] = [];
      const engine = await createBrowserLabEngine(kind, { core: harness.core, taskId: `release-rendering-${kind}`, binary, executablePath: findBrowser(), log: entry => commands.push(entry) });
      const summary: any = { kind, checkpoints: [] };
      try {
        const releaseTask = labTasks.find(task => task.id === 'github-release-download')!;
        const task = { ...releaseTask, hosts: [...releaseTask.hosts, 'example.com'] };
        const page = new LabPage(engine, task, true, directory, performance.now() + 150_000);
        await engine.command('viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        async function capture(phase: string, query?: string) {
          await page.observe(query);
          const last = page.history.at(-1);
          const png = readFileSync(last.screenshot);
          const dimensions = [png.readUInt32BE(16), png.readUInt32BE(20)];
          summary.checkpoints.push({ phase, url: last.state.url, viewport: last.state.viewport, darkMode: last.state.darkMode, dimensions, screenshot: last.screenshot });
          expect(last.state.viewport).toEqual({ width: 1280, height: 800 });
          expect(last.state.darkMode).toBe(false);
          expect(dimensions).toEqual([1280, 800]);
          return String(last.snapshot.snapshot);
        }
        await engine.command('navigate', { url: 'https://example.com/', waitUntil: 'domcontentloaded' });
        await capture('cross-origin-start');
        await engine.command('navigate', { url: 'https://github.com/microsoft/playwright/releases/latest', waitUntil: 'domcontentloaded' });
        await capture('release-navigation');
        const releaseUrl = page.history.at(-1).state.url;
        const readyDeadline = performance.now() + 15_000;
        let zipRef: string | undefined;
        let expandedAssets = false;
        while (!zipRef && performance.now() < readyDeadline) {
          const snapshot = await capture('release-assets-ready', 'Assets');
          zipRef = snapshot.split('\n').find(line => /link "Source code \(zip\)"/.test(line))?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
          if (zipRef) break;
          const assets = snapshot.split('\n').find(line => /button "Assets/.test(line));
          const assetsRef = assets?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
          if (!expandedAssets && assetsRef) {
            await page.execute({ commands: [{ action: 'click', selector: '@' + assetsRef }] });
            expect(page.attempts.at(-1).success).toBe(true);
            if (assets?.includes('expanded=true') || assets?.includes('[expanded]')) {
              await page.observe('Assets');
              const currentAssets = String(page.history.at(-1).snapshot.snapshot).split('\n').find(line => /button "Assets/.test(line));
              const currentRef = currentAssets?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
              expect(currentRef).toBeDefined();
              await page.execute({ commands: [{ action: 'click', selector: '@' + currentRef }] });
            }
            expandedAssets = true;
          }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        expect(zipRef).toBeDefined();
        const zipSnapshot = await capture('source-zip-observed', 'Source code');
        zipRef = zipSnapshot.split('\n').find(line => /link "Source code \(zip\)"/.test(line))?.match(/\[[^\]]*\bref=([^\]\s,]+)/)?.[1];
        expect(zipRef).toBeDefined();
        try {
          await page.execute({ commands: [{ action: 'download', selector: '@' + zipRef }] });
          await capture('after-public-zip-download');
        } catch (error) {
          summary.downloadObservationError = error instanceof Error ? error.stack : String(error);
          expect(kind).toBe('agent-browser');
          expect(summary.downloadObservationError).toContain('Target does not support metrics override');
        }
        summary.downloadAttempt = page.attempts.at(-1);
        if (kind === 'playwright') expect(summary.downloadAttempt.success).toBe(true);
        // Native canceled downloads and rejected observation preparation remain
        // failures. Probe a subsequent explicit Back to test rendering recovery.
        await engine.command('back');
        try { await capture('after-download-back'); }
        catch (error) {
          summary.backObservationError = String(error);
          expect(kind).toBe('agent-browser');
          expect(summary.backObservationError).toContain('Target does not support metrics override');
        }
        await engine.command('navigate', { url: releaseUrl, waitUntil: 'domcontentloaded' });
        await capture('after-download-back-release-navigation');
        await engine.command('navigate', { url: 'https://example.com/', waitUntil: 'domcontentloaded' });
        await capture('cross-origin-after-download');
        await page.execute({ commands: [{ action: 'back' }] });
        await capture('cross-origin-back');
        expect(commands.filter(command => command.action === 'prepare_observation' && command.success).length).toBeGreaterThanOrEqual(summary.checkpoints.length);
        summary.success = true;
      } catch (error) {
        // Retain the independently reproduced native compatibility failure. A
        // passing characterization is not a successful native download claim.
        summary.success = false;
        summary.recoveryError = error instanceof Error ? error.stack : String(error);
        expect(kind).toBe('agent-browser');
        expect(summary.recoveryError).toContain('Target does not support metrics override');
      } finally {
        await engine.close();
        summary.processesAfter = harness.core.procs.liveCount(engine.processGroup);
        expect(summary.processesAfter).toBe(0);
        summaries.push(summary);
        writeFileSync(join(directory, 'commands.json'), JSON.stringify(commands, null, 2));
        writeFileSync(join(output, 'release-rendering-summary.json'), JSON.stringify(summaries, null, 2));
      }
    }
  } finally { await harness.stop(); }
}, 360_000);
