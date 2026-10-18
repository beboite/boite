import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The newest records of `<dataDir>/logs/shell.0.ndjson` a diagnosis prints. */
const SHELL_LOG_RECORDS = 60;
/** How much of the log's end is read to find them, whatever its size. */
const SHELL_LOG_TAIL_BYTES = 256 * 1024;
const MESSAGE_CHARS = 300;
/** How long PowerShell gets to list the shell's process tree. */
const PROCESS_TREE_TIMEOUT_MS = 10_000;

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
  const text = `Shell ${shellPid} log (newest ${SHELL_LOG_RECORDS} records of ${join(dataDir, 'logs', 'shell.0.ndjson')}):\n${shellLogTail(dataDir)}\n`
    + `Shell ${shellPid} process tree: ${await processTree(shellPid)}`;
  const artifacts = join(import.meta.dir, '..', '.artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, `shell-${shellPid}-diagnosis.txt`), failure === '' ? text : `${failure}\n${text}`);
  return text;
}

function shellLogTail(dataDir: string): string {
  const path = join(dataDir, 'logs', 'shell.0.ndjson');
  if (!existsSync(path)) return '  (none: the shell never started its log)';
  let lines: string[];
  try {
    lines = readTail(path).split('\n').filter(line => line.trim() !== '');
  } catch (error) {
    return `  (unreadable: ${error instanceof Error ? error.message : String(error)})`;
  }
  return lines.slice(-SHELL_LOG_RECORDS).map((line) => {
    try {
      const record = JSON.parse(line) as { at?: number; level?: string; event?: string; message?: string; runId?: string };
      const at = typeof record.at === 'number' ? new Date(record.at).toISOString().slice(11, 23) : '?';
      return `  ${at} ${record.runId?.slice(0, 8) ?? '?'} ${record.level ?? '?'} ${record.event ?? '?'} ${(record.message ?? '').slice(0, MESSAGE_CHARS)}`;
    } catch {
      return `  ${line.slice(0, MESSAGE_CHARS)}`;
    }
  }).join('\n');
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
