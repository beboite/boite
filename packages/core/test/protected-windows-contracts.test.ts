import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Bus} from '../src/bus.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';

test('diagnostic nonce parsing refuses overlong input without writing beyond its caller buffer', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'boite-live-fence-contracts-'));
  const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    const compiler = process.platform === 'win32' ? Bun.which('gcc') || Bun.which('clang') : Bun.which('cc');
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
      const child = procs.spawnPiped(id, command, args, {cwd: scratch, agentRoot: false}); child.proc.stdin.end();
      const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
      expect(code, err).toBe(0); return out;
    };
    await run('compile-fence-nonce', compiler, ['-std=c11', '-O0', '-Wall', '-Wextra', '-Werror', source, '-o', binary]);
    expect((await run('run-fence-nonce', binary, [])).trim()).toBe('LIVE_FENCE nonce=32 rejected=33,34,empty,nonhex canary=intact');
  } finally {await procs.killAll(); await procs.close(); journal.close(); rmSync(scratch, {recursive: true, force: true});}
}, 20000);

test('production Null scheduler grows, replays queued traps and validates native outputs', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'boite-production-null-contracts-'));
  const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    const compiler = process.platform === 'win32' ? Bun.which('gcc') || Bun.which('clang') : Bun.which('cc');
    if (!compiler) throw new Error('Production Null contract harness requires a C compiler');
    const binary = join(scratch, process.platform === 'win32' ? 'contracts.exe' : 'contracts');
    const run = async (id: string, command: string, args: string[]) => {
      const child = procs.spawnPiped(id, command, args, {cwd: scratch, agentRoot: false}); child.proc.stdin.end();
      const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
      expect(code, err).toBe(0); return out;
    };
    await run('compile-production-contracts', compiler, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-I' + join(import.meta.dir, '../src/platform/windows'), join(import.meta.dir, 'fixtures/protected-null-contracts.c'), '-o', binary]);
    expect((await run('run-production-contracts', binary, [])).trim()).toBe(
      'PROTECTED_NULL growth=300 queued-replay=1 terminating-workers=2 balanced=1 cancellation=1 output-spans=1 qos-snapshot=1 create-abi=1');
  } finally {await procs.killAll(); await procs.close(); journal.close(); rmSync(scratch, {recursive: true, force: true});}
}, 20000);
