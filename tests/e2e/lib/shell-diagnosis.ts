import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserPage } from './cdp.ts';

/** The webview exposes its page target before the IPC bridge is injected. */
export const TAURI_READY = "typeof window.__TAURI_INTERNALS__?.invoke === 'function'";

/** The newest records of `<dataDir>/logs/shell.0.ndjson` a diagnosis prints. */
const SHELL_LOG_RECORDS = 60;
/** How much of the log's end is read to find them, whatever its size. */
const SHELL_LOG_TAIL_BYTES = 256 * 1024;
const MESSAGE_CHARS = 300;
/** How long PowerShell gets to list the shell's process tree. */
const PROCESS_TREE_TIMEOUT_MS = 10_000;
/** The newest `shell.webview.*` records a page that never got its bridge reports, from the same tail. */
const WEBVIEW_RECORDS = 40;
/** How long each devtools question of that report may take: the page may be what hangs. */
const PROBE_TIMEOUT_MS = 3_000;
const TARGETS_CHARS = 4_000;

/** A hidden shell a test drives: its debugging port, data directory and pid. */
export interface ShellUnderTest { port: number; dataDir: string; pid: number }

/**
 * What a hidden shell that never exposed its page left behind: the end of its
 * own log, which says whether `build_main_window` returned (the `main-window`
 * startup phase), whether the page started and finished loading, whether the
 * watchdog saw the main thread blocked and whether a WebView2 process failed;
 * and on Windows the process tree under the shell, which says whether WebView2
 * ever started a renderer. The text, after the attach `failure` it explains,
 * also goes to `tests/e2e/.artifacts/shell-<pid>-diagnosis.txt`, which CI
 * uploads.
 */
export async function describeShell(dataDir: string, shellPid: number, failure = ''): Promise<string> {
  const text = await shellReport(dataDir, shellPid);
  writeArtifact(`shell-${shellPid}-diagnosis.txt`, failure === '' ? text : `${failure}\n${text}`);
  return text;
}

/**
 * Waits for the shell page's IPC bridge (`TAURI_READY`). A page that never
 * gets it fails with what the attach did not show: the target the test
 * attached to, `/json/list` at the failure, the frame and its navigation
 * history as devtools reports them, the shell's `shell.webview.*` records
 * (`shell.webview.page-load` started and finished), its log tail and process
 * tree. The text also goes to `tests/e2e/.artifacts/shell-<pid>-not-ready.txt`,
 * which the desktop job uploads as `desktop-failure-captures`.
 */
export async function waitForShellPage(page: BrowserPage, shell: ShellUnderTest, timeoutMs = 15_000): Promise<void> {
  try {
    await page.waitFor(TAURI_READY, timeoutMs);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const report = await notReadyReport(page, shell);
    writeArtifact(`shell-${shell.pid}-not-ready.txt`, `${failure}\n${report}`);
    throw new Error(`${failure}\n${report}`, { cause: error });
  }
}

async function notReadyReport(page: BrowserPage, shell: ShellUnderTest): Promise<string> {
  const ask = (method: string) => page.send(method, {}, PROBE_TIMEOUT_MS).then(
    result => JSON.stringify(result),
    (error: unknown) => `(no answer: ${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)})`,
  );
  const [targets, frames, history, shellText] = await Promise.all([
    fetch(`http://127.0.0.1:${shell.port}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      .then(response => response.text())
      .then(
        text => text.replace(/\s+/g, ' ').slice(0, TARGETS_CHARS),
        (error: unknown) => `(no answer: ${error instanceof Error ? error.message : String(error)})`,
      ),
    ask('Page.getFrameTree'),
    ask('Page.getNavigationHistory'),
    shellReport(shell.dataDir, shell.pid),
  ]);
  const records = shellRecords(shell.dataDir);
  const webview = typeof records === 'string'
    ? records
    : records.filter(record => record.event.startsWith('shell.webview.')).slice(-WEBVIEW_RECORDS).map(record => record.text).join('\n') || '  (none)';
  return [
    `Attached target: ${JSON.stringify(page.target)}`,
    `/json/list of port ${shell.port} now: ${targets}`,
    `Page.getFrameTree: ${frames}`,
    `Page.getNavigationHistory: ${history}`,
    `Shell ${shell.pid} webview records (newest ${WEBVIEW_RECORDS} shell.webview.* of the log tail):`,
    webview,
    shellText,
  ].join('\n');
}

async function shellReport(dataDir: string, shellPid: number): Promise<string> {
  const records = shellRecords(dataDir);
  const tail = typeof records === 'string' ? records : records.slice(-SHELL_LOG_RECORDS).map(record => record.text).join('\n');
  return `Shell ${shellPid} log (newest ${SHELL_LOG_RECORDS} records of ${join(dataDir, 'logs', 'shell.0.ndjson')}):\n${tail}\n`
    + `Shell ${shellPid} process tree: ${await processTree(shellPid)}`;
}

function writeArtifact(name: string, text: string): void {
  const artifacts = join(import.meta.dir, '..', '.artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, name), text);
}

/** The records of the log's tail, each with its event and printed line; a string says why there are none. */
function shellRecords(dataDir: string): Array<{ event: string; text: string }> | string {
  const path = join(dataDir, 'logs', 'shell.0.ndjson');
  if (!existsSync(path)) return '  (none: the shell never started its log)';
  let lines: string[];
  try {
    lines = readTail(path).split('\n').filter(line => line.trim() !== '');
  } catch (error) {
    return `  (unreadable: ${error instanceof Error ? error.message : String(error)})`;
  }
  return lines.map((line) => {
    try {
      const record = JSON.parse(line) as { at?: number; level?: string; event?: string; message?: string; runId?: string; data?: Record<string, unknown> };
      const at = typeof record.at === 'number' ? new Date(record.at).toISOString().slice(11, 23) : '?';
      // `shell.webview.page-load` says started or finished only in its data.
      const data = record.data !== undefined && Object.keys(record.data).length > 0 ? ` ${JSON.stringify(record.data).slice(0, MESSAGE_CHARS)}` : '';
      return { event: record.event ?? '?', text: `  ${at} ${record.runId?.slice(0, 8) ?? '?'} ${record.level ?? '?'} ${record.event ?? '?'} ${(record.message ?? '').slice(0, MESSAGE_CHARS)}${data}` };
    } catch {
      return { event: '?', text: `  ${line.slice(0, MESSAGE_CHARS)}` };
    }
  });
}

/** The last `SHELL_LOG_TAIL_BYTES` of a file, its first partial line dropped. */
function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - SHELL_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    // Cut on the newline byte before decoding, so a window that starts inside
    // a character drops its broken record with the rest of that line.
    const from = start === 0 ? 0 : buffer.subarray(0, read).indexOf(0x0a) + 1;
    return buffer.subarray(from, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The shell and every descendant, WebView2's processes with their `--type`. */
async function processTree(shellPid: number): Promise<string> {
  if (process.platform !== 'win32') return '(only collected on Windows)';
  // Bun kills this PowerShell, and only it, once the timeout passes: a stuck
  // WMI query then costs the diagnosis its tree, not the run its error.
  const listing = Bun.spawn(['powershell', '-NoProfile', '-Command',
    `$all = Get-CimInstance Win32_Process; $ids = @(${shellPid}); do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids += $next } while ($next.Count); $all | Where-Object { $_.ProcessId -in $ids } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 3`,
  ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: PROCESS_TREE_TIMEOUT_MS });
  const [stdout, stderr] = await Promise.all([new Response(listing.stdout).text(), new Response(listing.stderr).text(), listing.exited]);
  if (listing.signalCode !== null) return `(PowerShell gave no tree within ${PROCESS_TREE_TIMEOUT_MS} ms)`;
  return stdout || `(empty; powershell said: ${stderr.slice(0, 300)})`;
}
