/** Windows native workers must not survive into the next test file's runtime. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const CORE = resolve(import.meta.dir, '../../packages/core');

/** Match Bun's test filename forms while excluding installed dependencies. */
export function coreTestFiles(cwd: string): string[] {
  return [...new Bun.Glob('**/*').scanSync({ cwd, onlyFiles: true })]
    .filter(file => !file.split(/[\\/]/).includes('node_modules') && /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))
    .sort()
    .map(file => resolve(cwd, file));
}

/** Preserve child exit failures and bound hangs, including synchronous native waits. */
export async function runCoreFiles(files: string[], options: { cwd: string; quiet?: boolean; timeoutMs?: number }): Promise<void> {
  if (files.length === 0) throw new Error(`${options.cwd}: no core test files found`);
  const failures: string[] = [];
  const timeoutMs = options.timeoutMs ?? 90_000;
  for (const file of files) {
    const label = relative(options.cwd, file);
    if (!options.quiet) console.log(`Isolated core test: ${label}`);
    const dataDir = mkdtempSync(join(tmpdir(), 'boite-core-file-'));
    try {
      const child = Bun.spawn([process.execPath, 'test', file, '--timeout', '15000'], {
        cwd: options.cwd,
        env: { ...process.env, BOITE_DATA_DIR: dataDir },
        stdin: 'ignore',
        stdout: options.quiet ? 'ignore' : 'inherit',
        stderr: options.quiet ? 'ignore' : 'inherit',
      });
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
      let code: number;
      try { code = await child.exited; }
      finally { clearTimeout(timer); }
      const failure = expired ? `${label}: exceeded ${timeoutMs} ms` : code !== 0 ? `${label}: exited with code ${code}` : null;
      if (failure !== null) {
        failures.push(failure);
        if (!options.quiet) console.error(failure);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  if (!options.quiet) console.log(`Isolated core tests passed: ${files.length} files`);
}

if (import.meta.main) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map(file => resolve(CORE, file)) : coreTestFiles(CORE);
  await runCoreFiles(files, { cwd: CORE });
}
