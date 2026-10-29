/**
 * What a test suite running in a thread does with its own core: agent CLIs put
 * in a Job Object of its own, ended by TerminateJobObject. Windows posts no
 * exit of theirs to the thread's job above it.
 *
 * Usage: bun nested-job-cli.ts <workDir> <count>. Touch `<workDir>/end` to end
 * the job, `<workDir>/exit` to let this process go (it goes after two minutes anyway).
 */
import { dlopen, FFIType } from 'bun:ffi';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KILL_EXIT_CODE } from '@boite/contracts';

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

const k32 = dlopen('kernel32.dll', {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
}).symbols;

const [workDir = '.', count = '1'] = process.argv.slice(2);
// The path `processAgentCommand` reads as Claude Code run by bun.
const cli = join(workDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
mkdirSync(dirname(cli), { recursive: true });
writeFileSync(cli, 'setInterval(() => {}, 60_000);\n');

const job = k32.CreateJobObjectW(null, null);
if (job === null) throw new Error('CreateJobObjectW failed');
const children = Array.from({ length: Number(count) }, () => {
  const child = Bun.spawn([process.execPath, cli, '--print', '--model', 'claude-haiku-5-5', 'Review the fixture'], { stdout: 'ignore', stderr: 'ignore' });
  const handle = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.pid);
  if (handle === null || k32.AssignProcessToJobObject(job, handle) === 0) throw new Error(`pid ${child.pid} did not join the nested job`);
  k32.CloseHandle(handle);
  return child;
});
console.log(`started ${children.map(child => child.pid).join(' ')}`);

async function until(file: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!existsSync(join(workDir, file)) && Date.now() < deadline) await Bun.sleep(50);
}

await until('end');
k32.TerminateJobObject(job, KILL_EXIT_CODE);
await Promise.all(children.map(child => child.exited));
console.log('ended the nested job');
await until('exit');
