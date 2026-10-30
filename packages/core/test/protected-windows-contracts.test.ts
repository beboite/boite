import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {tmpdir} from 'node:os';
import {Bus} from '../src/bus.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';

// Only fixed case/run IDs, captured PIDs, phase states and measured resources enter these diagnostics.
// Compiler stages are allowlisted basenames; no output, command paths or environment are logged.
function contractPhases(caseId: string) {
  const started = performance.now();
  type Status = 'pending' | 'fulfilled' | 'rejected';
  type Wait = 'exit' | 'stdout' | 'stderr';
  type RunState = {pid: number} & Record<Wait, Status>;
  const runs = new Map<string, RunState>();
  const phase = (name: string, runId?: string, status?: string) => {
    console.error('[windows-contract-phase]', JSON.stringify({caseId, phase: name,
      ms: Math.round((performance.now() - started) * 100) / 100, runId, status,
      runs: Array.from(runs, ([id, state]) => ({id, ...state}))}));
  };
  return {
    phase,
    launched(id: string, pid: number, procs: ProcRegistry) {
      // Track the original waits, including those still pending at cleanup.
      const waits: RunState = {pid, exit: 'pending', stdout: 'pending', stderr: 'pending'};
      runs.set(id, waits);
      phase('launched', id);
      // Three samples before the existing 20 s deadline distinguish a busy compiler
      // from a parent waiting for a compiler stage or inherited output pipes.
      const timers = process.platform === 'win32' ? [5000, 10000, 15000].map(ms => setTimeout(() => {
        const load = procs.loadOf(id);
        const processes = procs.liveOf(id);
        console.error('[windows-contract-sample]', JSON.stringify({caseId, runId: id,
          ms: Math.round(performance.now() - started), load,
          count: processes.length, processes: processes.slice(0, 8).map(record => {
            const name = basename(record.exe).toLowerCase().replace(/\.exe$/, '');
            return {pid: record.pid, parentPid: record.parentPid,
              stage: ['gcc', 'clang', 'cc1', 'as', 'collect2', 'ld', 'nonce', 'contracts'].includes(name) ? name : 'other'};
          })}));
      }, ms)) : [];
      const stopSamples = () => { if (Object.values(waits).every(value => value !== 'pending')) timers.forEach(clearTimeout); };
      return <T>(wait: Wait, promise: Promise<T>): Promise<T> => promise.then(value => {
        waits[wait] = 'fulfilled'; phase(wait, id, 'fulfilled'); stopSamples(); return value;
      }, error => {
        waits[wait] = 'rejected'; phase(wait, id, 'rejected'); stopSamples(); throw error;
      });
    },
  };
}

test('diagnostic nonce parsing refuses overlong input without writing beyond its caller buffer', async () => {
  const phases = contractPhases('nonce');
  const scratch = mkdtempSync(join(tmpdir(), 'boite-live-fence-contracts-'));
  const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    phases.phase('compiler-selection-start');
    const compiler = process.platform === 'win32' ? Bun.which('gcc') || Bun.which('clang') : Bun.which('cc');
    phases.phase('compiler-selection-complete', undefined, compiler ? 'found' : 'missing');
    if (!compiler) throw new Error('Diagnostic nonce contract harness requires a C compiler');
    const header = readFileSync(join(import.meta.dir, '../../../tests/diagnostics/windows-debug-map/live-root-fence.h'), 'utf8');
    // Compile the actual diagnostic parser, with the Windows environment API replaced by its buffer contract.
    const parser = header.slice(header.indexOf('static BOOL lf_hex('), header.indexOf('static DWORD live_root_fence('));
    const source = join(scratch, 'nonce.c'), binary = join(scratch, process.platform === 'win32' ? 'nonce.exe' : 'nonce');
    writeFileSync(source, `
#include <wchar.h>
#include <stdio.h>
typedef int BOOL;
#define TRUE 1
#define FALSE 0
static const wchar_t *environment;
static unsigned long GetEnvironmentVariableW(const wchar_t *key, wchar_t *value, unsigned long size) {
  (void)key;
  unsigned long length = (unsigned long)wcslen(environment);
  if (length >= size) return length + 1;
  wmemcpy(value, environment, length + 1);
  return length;
}
${parser}
int main(void) {
  const wchar_t *values[] = {L"0123456789abcdef0123456789abcdef", L"0123456789abcdef0123456789abcdef0", L"0123456789abcdef0123456789abcdef00", L"", L"g123456789abcdef0123456789abcdef"};
  for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
    struct {wchar_t value[33]; wchar_t canary;} buffer = {{0}, 0x1234};
    environment = values[i];
    int accepted = lf_hex(buffer.value, L"nonce");
    if (buffer.canary != 0x1234) {fprintf(stderr, "nonce buffer overwritten for length %zu\\n", wcslen(environment)); return 1;}
    if (accepted != (i == 0)) return 2;
  }
  puts("LIVE_FENCE nonce=32 rejected=33,34,empty,nonhex canary=intact");
  return 0;
}
`);
    const run = async (id: string, command: string, args: string[]) => {
      phases.phase('launch-intent', id);
      const child = procs.spawnPiped(id, command, args, {cwd: scratch, agentRoot: false});
      const observe = phases.launched(id, child.proc.pid, procs);
      child.proc.stdin.end();
      const [code, out, err] = await Promise.all([observe('exit', child.exited),
        observe('stdout', new Response(child.proc.stdout).text()), observe('stderr', new Response(child.proc.stderr).text())]);
      expect(code, err).toBe(0); return out;
    };
    await run('compile-fence-nonce', compiler, ['-std=c11', '-O0', '-Wall', '-Wextra', '-Werror', source, '-o', binary]);
    expect((await run('run-fence-nonce', binary, [])).trim()).toBe('LIVE_FENCE nonce=32 rejected=33,34,empty,nonhex canary=intact');
  } finally {
    phases.phase('finally-enter');
    await procs.killAll(); phases.phase('kill-all-complete');
    await procs.close(); phases.phase('registry-close-complete');
    journal.close(); rmSync(scratch, {recursive: true, force: true});
    phases.phase('cleanup-complete');
  }
}, 20000);

test('production Null scheduler grows, replays queued traps and validates native outputs', async () => {
  const phases = contractPhases('production-null');
  const scratch = mkdtempSync(join(tmpdir(), 'boite-production-null-contracts-'));
  const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    phases.phase('compiler-selection-start');
    const compiler = process.platform === 'win32' ? Bun.which('gcc') || Bun.which('clang') : Bun.which('cc');
    phases.phase('compiler-selection-complete', undefined, compiler ? 'found' : 'missing');
    if (!compiler) throw new Error('Production Null contract harness requires a C compiler');
    const binary = join(scratch, process.platform === 'win32' ? 'contracts.exe' : 'contracts');
    const run = async (id: string, command: string, args: string[]) => {
      phases.phase('launch-intent', id);
      const child = procs.spawnPiped(id, command, args, {cwd: scratch, agentRoot: false});
      const observe = phases.launched(id, child.proc.pid, procs);
      child.proc.stdin.end();
      const [code, out, err] = await Promise.all([observe('exit', child.exited),
        observe('stdout', new Response(child.proc.stdout).text()), observe('stderr', new Response(child.proc.stderr).text())]);
      expect(code, err).toBe(0); return out;
    };
    await run('compile-production-contracts', compiler, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-I' + join(import.meta.dir, '../src/platform/windows'), join(import.meta.dir, 'fixtures/protected-null-contracts.c'), '-o', binary]);
    expect((await run('run-production-contracts', binary, [])).trim()).toBe(
      'PROTECTED_NULL growth=300 queued-replay=1 terminating-workers=2 balanced=1 cancellation=1 output-spans=1 qos-snapshot=1 create-abi=1');
  } finally {
    phases.phase('finally-enter');
    await procs.killAll(); phases.phase('kill-all-complete');
    await procs.close(); phases.phase('registry-close-complete');
    journal.close(); rmSync(scratch, {recursive: true, force: true});
    phases.phase('cleanup-complete');
  }
}, 20000);
