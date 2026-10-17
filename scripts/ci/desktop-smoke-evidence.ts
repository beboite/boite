/**
 * What the installed smoke prints when the core never published its endpoint:
 * the shell's process group with CPU and age, a stack sample of the shell on
 * macOS, and the end of every log the shell and core wrote. The data directory
 * is deleted afterwards, so this is the only trace a failed run keeps.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG_LINES = 40;

/** The header and the rows of `ps -A -o pid,ppid,pgid,...` whose group is `group`. */
export function groupRows(ps: string, group: number): string {
  const [header = '', ...rows] = ps.split('\n');
  const members = rows.filter(row => Number(row.trim().split(/\s+/)[2]) === group);
  return [header, ...members].join('\n');
}

function run(command: string[]): string {
  try {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    return `${result.stdout.toString()}${result.stderr.toString()}`.trimEnd();
  } catch (error) {
    return `${command[0]} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function tail(file: string): string {
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  return lines.slice(-LOG_LINES).join('\n');
}

export function startupEvidence(shellPid: number, logs: string): string {
  const parts: string[] = [];
  if (process.platform !== 'win32') {
    // The shell was spawned detached, so its pid is its process group.
    const ps = run(['ps', '-A', '-o', 'pid,ppid,pgid,stat,%cpu,etime,command']);
    parts.push(`--- processes of the shell's group ${shellPid}\n${groupRows(ps, shellPid)}`);
  }
  if (process.platform === 'darwin') parts.push(`--- sample of the shell\n${run(['/usr/bin/sample', String(shellPid), '3'])}`);
  if (existsSync(logs)) {
    for (const name of readdirSync(logs).sort()) parts.push(`--- ${name}, last ${LOG_LINES} lines\n${tail(join(logs, name))}`);
  } else {
    parts.push(`--- no log directory at ${logs}`);
  }
  return parts.join('\n');
}
