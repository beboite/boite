/**
 * How long the desktop app takes to be usable: from spawning the shell
 * executable to the core answering, to the page's first paint, and to the UI
 * holding its data (`performance.mark('boite:ready')` in the store). The shell
 * runs hidden on a fresh data directory, and the page is read over the WebView2
 * debugging port, so nothing reaches the screen.
 *
 *   bun run bench/startup.ts [--runs 7] [--exe path/to/boite-shell.exe] [--core-command "bun path/to/main.js"]
 *
 * `--core-command` is handed to the shell as `BOITE_CORE_COMMAND`, to time a
 * core other than the sidecar beside the executable. The shell splits it on
 * whitespace, so neither path in it may hold a space.
 *
 * The first run of a fresh WebView2 profile pays for creating the profile, so
 * every run here is that cold case. Medians are what to quote.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from '../tests/e2e/lib/cdp.ts';
import { freshDataDir, killProcessTree, removeDirectory } from '../tests/e2e/lib/core.ts';

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const ROOT = join(import.meta.dir, '..');
const EXE = flag('exe', process.env.BOITE_E2E_SHELL_EXE ?? join(ROOT, 'apps', 'shell', 'src-tauri', 'target', 'release', 'boite-shell.exe'));
const RUNS = Number(flag('runs', '7'));
const CORE_COMMAND = flag('core-command', '');
if (process.argv.at(-1) === '--core-command' || CORE_COMMAND.startsWith('--')) throw new Error('--core-command needs a value: the command that starts the core');

interface Run {
  coreMs: number;
  paintMs: number;
  readyMs: number;
}

async function once(): Promise<Run> {
  const dataDir = freshDataDir();
  const port = await freePort();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.BOITE_CORE_COMMAND;
  if (CORE_COMMAND !== '') env.BOITE_CORE_COMMAND = CORE_COMMAND;
  env.BOITE_SHELL_HIDDEN = '1';
  env.BOITE_DATA_DIR = dataDir;
  env.BOITE_TELEMETRY_URL = '';
  env.BOITE_ECHO = '1';
  env.BOITE_SHELL_DEBUG_PORT = String(port);
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port} --remote-allow-origins=* --mute-audio --use-angle=d3d11`;

  const spawnedAt = Date.now();
  const started = performance.now();
  const proc = Bun.spawn({ cmd: [EXE], env, stdout: 'ignore', stderr: 'ignore', windowsHide: true });
  let corePid = 0;
  let page: BrowserPage | undefined;
  try {
    let coreMs = 0;
    const corePath = join(dataDir, 'core.json');
    const deadline = Date.now() + 30_000;
    while (coreMs === 0) {
      try {
        const file = JSON.parse(await Bun.file(corePath).text()) as { port: number; pid: number };
        const response = await fetch(`http://127.0.0.1:${file.port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          coreMs = performance.now() - started;
          corePid = file.pid;
        }
      } catch {
        /* not there yet */
      }
      if (Date.now() > deadline) throw new Error('the shell never produced a healthy core');
      if (coreMs === 0) await Bun.sleep(4);
    }

    page = await BrowserPage.attach(port);
    // The store's own mark when the build has one; on an older build, the first
    // run card, which only a loaded store on an empty data directory draws.
    const probe = `new Promise((resolve) => {
      const answer = (ready) => resolve({
        paint: performance.timeOrigin + (performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0),
        ready
      });
      const look = () => {
        const mark = performance.getEntriesByName('boite:ready')[0];
        if (mark) { answer(performance.timeOrigin + mark.startTime); return true; }
        if (document.querySelector('[data-testid="first-run"]')) { answer(performance.timeOrigin + performance.now()); return true; }
        return false;
      };
      if (look()) return;
      const observer = new MutationObserver(() => { if (look()) observer.disconnect(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    })`;
    // The shell swaps its waiting page for the core's once the core answers: a
    // probe caught by that navigation is asked again on the page that replaced it.
    let timing: { paint: number; ready: number } | undefined;
    while (timing === undefined) {
      try {
        // The probe's own limit is the CDP call's 20 s: the run's deadline ends it sooner, and `finally` then closes what was started.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('the UI never reported ready before the deadline')), Math.max(0, deadline - Date.now()));
        });
        timing = await Promise.race([page.evaluate<{ paint: number; ready: number }>(probe), expired]).finally(() => clearTimeout(timer));
      } catch (error) {
        if (!String(error).includes('context') || Date.now() > deadline) throw error;
        await Bun.sleep(10);
      }
    }
    return { coreMs, paintMs: timing.paint - spawnedAt, readyMs: timing.ready - spawnedAt };
  } finally {
    await page?.close().catch(() => undefined);
    killProcessTree(proc.pid);
    if (corePid !== 0) killProcessTree(corePid);
    await Bun.sleep(300);
    await removeDirectory(dataDir);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

if (!existsSync(EXE)) throw new Error(`${EXE} is missing: bun run --cwd apps/shell tauri build --no-bundle, then bun run stage:core`);
const runs: Run[] = [];
for (let index = 0; index < RUNS; index += 1) {
  const run = await once();
  runs.push(run);
  console.log(`run ${index + 1}: core ${Math.round(run.coreMs)} ms, first paint ${Math.round(run.paintMs)} ms, ui ready ${Math.round(run.readyMs)} ms`);
}
console.log(`\n${EXE}\ncore: ${CORE_COMMAND === '' ? 'the sidecar beside it' : CORE_COMMAND}\n${new Date().toISOString().slice(0, 10)}, ${RUNS} runs, medians, fresh WebView2 profile each run`);
console.log('| spawn to | ms |\n| --- | ---: |');
console.log(`| core answering /health | ${Math.round(median(runs.map((run) => run.coreMs)))} |`);
console.log(`| first contentful paint | ${Math.round(median(runs.map((run) => run.paintMs)))} |`);
console.log(`| UI holding its data | ${Math.round(median(runs.map((run) => run.readyMs)))} |`);
