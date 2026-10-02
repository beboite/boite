import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workerEntry } from '../src/worker-entry.ts';

test('worker lookup preserves sibling sources and bundled files before an explicit embedded relative entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-worker-entry-'));
  const base = pathToFileURL(join(dir, 'main.ts')).href;
  const name = 'isolated-worker-lookup';
  try {
    mkdirSync(join(dir, 'platform'));
    const nested = join(dir, 'platform', `${name}.ts`);
    writeFileSync(nested, '');
    expect(workerEntry(base, name, `./platform/${name}.ts`)).toBe(pathToFileURL(nested).href);
    const bundled = join(dir, `${name}.js`); writeFileSync(bundled, '');
    expect(workerEntry(base, name, `./platform/${name}.ts`)).toBe(pathToFileURL(bundled).href);
    const source = join(dir, `${name}.ts`); writeFileSync(source, '');
    expect(workerEntry(base, name)).toBe(pathToFileURL(source).href);
    expect(() => workerEntry(base, 'missing-worker')).toThrow('no missing-worker beside');
    expect(workerEntry('file:///$bunfs/root/compiled-core', name, './src/platform/entry.ts'))
      .toBe('file:///$bunfs/root/src/platform/entry.ts');
    const sourceDir = join(dir, 'src');
    mkdirSync(join(sourceDir, 'platform'), { recursive: true });
    writeFileSync(join(sourceDir, 'worker-entry.ts'), readFileSync(join(import.meta.dir, '../src/worker-entry.ts')));
    writeFileSync(join(sourceDir, 'resource-usage.ts'), readFileSync(join(import.meta.dir, '../src/resource-usage.ts')));
    writeFileSync(join(sourceDir, 'platform/linux-tcp-client.ts'), readFileSync(join(import.meta.dir, '../src/platform/linux-tcp-client.ts')));
    writeFileSync(join(sourceDir, 'main.ts'), "await import('./runtime.ts'); export {};\n");
    writeFileSync(join(sourceDir, 'runtime.ts'), `
      import { LinuxTcpClient } from './platform/linux-tcp-client.ts';
      const client = new LinuxTcpClient(); const members = [{ pid: 1, birth: 1 }];
      client.watch(true); client.finish(new Map([['thread', members]]));
      const poll = setInterval(async () => {
        const sample = client.sample('thread', members);
        if (sample.source === 'linux-tcp-info') {
          clearInterval(poll); await client.closed(); console.log(sample.note); process.exit(0);
        }
      }, 10);
      setTimeout(() => process.exit(2), 5000);
    `);
    const worker = (note: string) => `onmessage = event => {
      if (event.data.kind === 'stop') { postMessage({ kind: 'stopped' }); close(); }
      else postMessage({ kind: 'sample', id: event.data.id, samples: [['thread',
        { source: 'linux-tcp-info', note: '${note}' }]] });
    };\n`;
    writeFileSync(join(sourceDir, 'platform/linux-tcp-worker.ts'), worker('embedded worker ready'));
    const binary = join(dir, process.platform === 'win32' ? 'lookup.exe' : 'lookup');
    const build = Bun.spawnSync([process.execPath, 'build', '--compile', '--bytecode', '--format=esm',
      '--minify-whitespace', '--minify-syntax', 'src/main.ts', 'src/platform/linux-tcp-worker.ts', '--outfile', binary],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(build.exitCode).toBe(0);
    const embedded = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(embedded.stderr.toString()).toBe('');
    expect(embedded.exitCode).toBe(0);
    expect(embedded.stdout.toString()).toBe('embedded worker ready\n');
    writeFileSync(join(dir, 'linux-tcp-worker.js'), worker('staged worker ready'));
    const staged = Bun.spawnSync([binary], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(staged.stderr.toString()).toBe('');
    expect(staged.exitCode).toBe(0);
    expect(staged.stdout.toString()).toBe('staged worker ready\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
