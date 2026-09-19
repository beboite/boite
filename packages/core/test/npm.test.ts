import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isNpmSpec, resolveNpm } from '../src/providers/npm.ts';

const windows = process.platform === 'win32';
let prefix: string;
let saved: string | undefined;

/** Lays a package out where `npm install -g --prefix <prefix>` would. */
function install(name: string, manifest: Record<string, unknown>, files: string[]): string {
  const dir = join(prefix, ...(windows ? ['node_modules'] : ['lib', 'node_modules']), ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }), 'utf8');
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), '', 'utf8');
  }
  return dir;
}

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'boite-npm-'));
  saved = process.env['npm_config_prefix'];
  process.env['npm_config_prefix'] = prefix;
});

afterEach(() => {
  if (saved === undefined) delete process.env['npm_config_prefix'];
  else process.env['npm_config_prefix'] = saved;
  rmSync(prefix, { recursive: true, force: true });
});

describe('npm candidates', () => {
  test('a package name is accepted with an optional bin, anything path-like is not', () => {
    expect(isNpmSpec('@earendil-works/pi-coding-agent#pi')).toBe(true);
    expect(isNpmSpec('opencode-ai')).toBe(true);
    expect(isNpmSpec('../escape')).toBe(false);
    expect(isNpmSpec('C:\\tools\\pi.cmd')).toBe(false);
    expect(isNpmSpec('@scope/')).toBe(false);
  });

  test('the named bin of a scoped package is found under the prefix and run by the Node beside it', () => {
    const dir = install('@boite-test/agent', { bin: { other: 'dist/other.js', agent: 'dist/cli.js' } }, ['dist/cli.js', 'dist/other.js']);
    const node = windows ? join(prefix, 'node.exe') : join(prefix, 'bin', 'node');
    mkdirSync(join(node, '..'), { recursive: true });
    writeFileSync(node, '', 'utf8');

    const found = resolveNpm('@boite-test/agent#agent');
    expect(found?.script).toBe(join(dir, 'dist', 'cli.js'));
    expect(found?.executable).toBe(node);
  });

  test('a string bin and a bin-less spec both resolve to the only script', () => {
    const dir = install('@boite-test/single', { bin: 'cli.js' }, ['cli.js']);
    expect(resolveNpm('@boite-test/single')?.script).toBe(join(dir, 'cli.js'));
    expect(resolveNpm('@boite-test/single#anything')?.script).toBe(join(dir, 'cli.js'));
  });

  test('a manifest naming another package, a bin outside the package or a missing script is not a match', () => {
    install('@boite-test/renamed', { name: '@boite-test/other', bin: 'cli.js' }, ['cli.js']);
    // The bin resolves beside the scope directory, so the file exists and only the containment check refuses it.
    const escape = install('@boite-test/escape', { bin: '../../outside.js' }, []);
    writeFileSync(join(escape, '..', '..', 'outside.js'), '', 'utf8');
    install('@boite-test/unbuilt', { bin: 'dist/cli.js' }, []);

    expect(resolveNpm('@boite-test/renamed')).toBeNull();
    expect(resolveNpm('@boite-test/escape')).toBeNull();
    expect(resolveNpm('@boite-test/unbuilt')).toBeNull();
    expect(resolveNpm('@boite-test/absent')).toBeNull();
  });
});
