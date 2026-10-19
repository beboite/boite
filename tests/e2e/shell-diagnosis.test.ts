import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { removeDirectory } from './lib/cleanup.ts';
import { waitForShellPage } from './lib/shell-diagnosis.ts';

// The Desktop Windows failure: the attached shell page stays about:blank and
// never gets its IPC bridge. A plain browser on about:blank has no bridge
// either, so the wait times out the same way, and its report must carry
// what the next occurrence needs to explain itself.
test('a shell page that never gets its IPC bridge reports its target, the target list and the page-load records', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-e2e-shell-ready-'));
  mkdirSync(join(dataDir, 'logs'));
  const record = (at: number, event: string, message: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({ id: `run:${at}`, runId: 'run00001', seq: at, at: 1_792_400_000_000 + at, level: 'info', source: 'webview', event, message, data });
  writeFileSync(join(dataDir, 'logs', 'shell.0.ndjson'), [
    record(1, 'shell.startup.phase', 'main-window built', { phase: 'main-window' }),
    record(2, 'shell.webview.page-load', 'the main page started loading; browser surfaces close with it', { phase: 'started' }),
    // The records a busy shell writes after it push the page-load out of the last 60.
    ...Array.from({ length: 80 }, (_, i) => record(10 + i, 'shell.core.health', 'the core answered')),
  ].join('\n') + '\n');
  const port = await freePort();
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: 'about:blank', debugPort: port });
    const shell = { port, dataDir, pid: page.pid! };
    const failure = await waitForShellPage(page, shell, 500).then(() => null, (error: unknown) => error as Error);
    expect(failure?.message).toStartWith("waitFor timed out on typeof window.__TAURI_INTERNALS__?.invoke === 'function'");
    const report = failure!.message;
    expect(report).toContain(`Attached target: {"`);
    expect(report).toContain(`"webSocketDebuggerUrl":"ws://127.0.0.1:${port}/devtools/page/`);
    expect(report).toMatch(new RegExp(`/json/list of port ${port} now: \\[.*"url": "about:blank"`));
    expect(report).toMatch(/Page\.getFrameTree: \{"frameTree":\{"frame":\{"id":"[^"]+","loaderId":"[^"]+","url":"about:blank"/);
    expect(report).toContain('Page.getNavigationHistory: {"currentIndex":');
    expect(report).toMatch(/webview records[^\n]*\n {2}\S+ run00001 info shell\.webview\.page-load the main page started loading; browser surfaces close with it \{"phase":"started"\}/);
    expect(report).toContain(`Shell ${shell.pid} process tree:`);
    const artifact = readFileSync(join(import.meta.dir, '.artifacts', `shell-${shell.pid}-not-ready.txt`), 'utf8');
    expect(artifact).toBe(report);
  } finally {
    await page?.close();
    await removeDirectory(dataDir);
  }
}, 60_000);
