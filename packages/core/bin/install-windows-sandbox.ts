/** Build the native userspace helper with an installed Windows SDK or MinGW. No host setup. */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';

const [output] = process.argv.slice(2);
if (!output || !isAbsolute(output)) throw new Error('usage: bun packages/core/bin/install-windows-sandbox.ts <absolute protected-tool.exe path>');
const scratch = mkdtempSync(join(tmpdir(), 'boite-build-windows-protected-'));
const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
try {
  const source = join(import.meta.dir, '../src/platform/windows/protected-tool.c');
  const compiler = process.platform === 'win32' ? Bun.which('clang') || Bun.which('gcc')
    || ['C:\\mingw64\\bin\\gcc.exe', 'C:\\ProgramData\\mingw64\\mingw64\\bin\\gcc.exe'].find(existsSync) : Bun.which('x86_64-w64-mingw32-gcc');
  if (!compiler) throw new Error('execution.windows.compiler: install a Windows SDK clang or MinGW compiler before building the userspace helper');
  const local = join(scratch, 'protected-tool.c'), built = join(scratch, 'protected-tool.exe');
  writeFileSync(local, readFileSync(source));
  const msvc = process.platform === 'win32' && /clang/i.test(compiler);
  const child = procs.spawnPiped('install-windows-sandbox', compiler, ['-O2', '-Wall', '-Wextra', '-Werror', local, '-o', built,
    ...(msvc ? ['-luserenv', '-ladvapi32', '-lshell32'] : ['-static', '-luserenv', '-ladvapi32', '-lshell32'])], {cwd: scratch, agentRoot: false});
  child.proc.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
  if (code) throw new Error(`execution.windows.compiler: native helper build failed (${code}): ${stdout}${stderr}`);
  mkdirSync(dirname(output), {recursive: true}); copyFileSync(built, output);
  console.log(`boite-windows-protected 1; native helper built: ${output}`);
} finally {await procs.killAll(); await procs.close(); journal.close(); rmSync(scratch, {recursive: true, force: true});}
