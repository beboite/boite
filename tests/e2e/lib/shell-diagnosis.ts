import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The newest records of `<dataDir>/logs/shell.0.ndjson` a diagnosis prints. */
const SHELL_LOG_RECORDS = 60;
const MESSAGE_CHARS = 300;

/**
 * What a hidden shell that never exposed its page left behind: the end of its
 * own log, which says whether `build_main_window` returned (the `main-window`
 * startup phase), whether the page started and finished loading, whether the
 * watchdog saw the main thread blocked and whether a WebView2 process failed;
 * and on Windows the process tree under the shell, which says whether WebView2
 * ever started a renderer. The text also goes to
 * `tests/e2e/.artifacts/shell-<pid>-diagnosis.txt`, which CI uploads.
 */
export function describeShell(dataDir: string, shellPid: number): string {
  const text = `Shell ${shellPid} log (newest ${SHELL_LOG_RECORDS} records of ${join(dataDir, 'logs', 'shell.0.ndjson')}):\n${shellLogTail(dataDir)}\n`
    + `Shell ${shellPid} process tree: ${processTree(shellPid)}`;
  const artifacts = join(import.meta.dir, '..', '.artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, `shell-${shellPid}-diagnosis.txt`), text);
  return text;
}

function shellLogTail(dataDir: string): string {
  const path = join(dataDir, 'logs', 'shell.0.ndjson');
  if (!existsSync(path)) return '  (none: the shell never started its log)';
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '');
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

/** The shell and every descendant, WebView2's processes with their `--type`. */
function processTree(shellPid: number): string {
  if (process.platform !== 'win32') return '(only collected on Windows)';
  const listed = Bun.spawnSync(['powershell', '-NoProfile', '-Command',
    `$all = Get-CimInstance Win32_Process; $ids = @(${shellPid}); do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids += $next } while ($next.Count); $all | Where-Object { $_.ProcessId -in $ids } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 3`,
  ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  return listed.stdout.toString() || `(empty; powershell said: ${listed.stderr.toString().slice(0, 300)})`;
}
