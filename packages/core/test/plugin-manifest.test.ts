/*
 * The manifest format, field by field. Every refusal names the file, the field
 * and what was expected, because that line is what a plugin author reads.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ManifestRefused, POOL_PROVIDERS, commandsOf, parseManifest, parseManifestText } from '../src/plugins/manifest.ts';
import { checkRef, normalizeSourceUrl } from '../src/plugins/source.ts';
import { RECOMMENDED } from '../src/plugins.ts';
import { startTestCore, type TestCore } from './harness.ts';

const SHA = 'a'.repeat(64);

function good(): Record<string, unknown> {
  return {
    schema: 1,
    id: 'seat-pool',
    name: 'Seat pool',
    version: '1.4.0',
    description: 'Switches OpenCode logins.',
    homepage: 'https://example.com/seat-pool',
    executable: 'seat-pool',
    artifacts: {
      'win32-x64': { url: 'https://example.com/seat-pool-1.4.0-win32-x64.exe', sha256: SHA },
      'linux-x64': { url: 'https://example.com/seat-pool-1.4.0-linux-x64', sha256: SHA },
    },
    provides: { accountPools: { providers: ['opencode'] } },
  };
}

function refusalOf(raw: unknown): ManifestRefused {
  try {
    parseManifest(raw, 'boite-plugin.json');
  } catch (error) {
    if (error instanceof ManifestRefused) return error;
    throw error;
  }
  throw new Error('the manifest was accepted');
}

function edited(edit: (raw: Record<string, unknown>) => void): Record<string, unknown> {
  const raw = good();
  edit(raw);
  return raw;
}

describe('the plugin manifest', () => {
  test('a good manifest reads back as itself, with the commands Boite may run', () => {
    const manifest = parseManifest(good(), 'boite-plugin.json');
    expect(manifest).toEqual(good() as unknown as typeof manifest);
    expect(commandsOf(manifest)).toEqual([
      'seat-pool list -<pool> -Json',
      'seat-pool list -<pool> -Json -Refresh',
      'seat-pool add -<pool>',
      'seat-pool switch -<pool> -Email <email> -Yes',
      'seat-pool remove -<pool> -Email <email> -Yes',
    ]);
  });

  const cases: [string, (raw: Record<string, unknown>) => void, string, string][] = [
    ['an unknown top-level field', (raw) => { raw['scripts'] = { postinstall: 'curl' }; }, 'scripts', 'one of schema, id, name'],
    ['another schema', (raw) => { raw['schema'] = 2; }, 'schema', '1'],
    ['an id with a path in it', (raw) => { raw['id'] = '../escape'; }, 'id', 'lowercase letters'],
    ['an id in capitals', (raw) => { raw['id'] = 'Seat'; }, 'id', 'lowercase letters'],
    ['an empty name', (raw) => { raw['name'] = ' '; }, 'name', 'a string of 1 to 60'],
    ['a name with a newline', (raw) => { raw['name'] = 'Seat\npool'; }, 'name', 'no control characters'],
    ['a version that is not one', (raw) => { raw['version'] = 'latest'; }, 'version', 'a version such as 1.2.0'],
    ['a long description', (raw) => { raw['description'] = 'x'.repeat(301); }, 'description', 'a string of 1 to 300'],
    ['an http homepage', (raw) => { raw['homepage'] = 'http://example.com'; }, 'homepage', 'an https URL'],
    ['an executable with a path', (raw) => { raw['executable'] = '../bin/sh'; }, 'executable', 'a file name'],
    ['an executable with its extension', (raw) => { raw['executable'] = 'seat.exe'; }, 'executable', 'no extension'],
    ['no artifacts', (raw) => { raw['artifacts'] = {}; }, 'artifacts', 'at least one of win32-x64'],
    ['an unknown platform', (raw) => { (raw['artifacts'] as Record<string, unknown>)['freebsd-x64'] = { url: 'https://example.com/a', sha256: SHA }; }, 'artifacts.freebsd-x64', 'one of win32-x64'],
    ['an artifact over http', (raw) => { (raw['artifacts'] as Record<string, unknown>)['linux-x64'] = { url: 'http://example.com/a', sha256: SHA }; }, 'artifacts.linux-x64.url', 'an https URL'],
    ['an artifact carrying a password', (raw) => { (raw['artifacts'] as Record<string, unknown>)['linux-x64'] = { url: 'https://user:pass@example.com/a', sha256: SHA }; }, 'artifacts.linux-x64.url', 'no credentials'],
    ['an uppercase digest', (raw) => { (raw['artifacts'] as Record<string, unknown>)['linux-x64'] = { url: 'https://example.com/a', sha256: SHA.toUpperCase() }; }, 'artifacts.linux-x64.sha256', '64 lowercase hexadecimal'],
    ['an artifact with a script', (raw) => { (raw['artifacts'] as Record<string, unknown>)['linux-x64'] = { url: 'https://example.com/a', sha256: SHA, run: 'sh' }; }, 'artifacts.linux-x64.run', 'one of url, sha256'],
    ['nothing provided', (raw) => { raw['provides'] = {}; }, 'provides', 'at least one of accountPools'],
    ['an unknown feature', (raw) => { raw['provides'] = { hooks: {} }; }, 'provides.hooks', 'one of accountPools'],
    ['an empty pool list', (raw) => { raw['provides'] = { accountPools: { providers: [] } }; }, 'provides.accountPools.providers', 'a non-empty array'],
    ['an unknown provider', (raw) => { raw['provides'] = { accountPools: { providers: ['opencode', 'echo'] } }; }, 'provides.accountPools.providers[1]', 'among antigravity'],
    ['a provider twice', (raw) => { raw['provides'] = { accountPools: { providers: ['pi', 'pi'] } }; }, 'provides.accountPools.providers[1]', 'distinct'],
  ];
  for (const [label, edit, field, expected] of cases) {
    test(`refuses ${label}, naming ${field}`, () => {
      const refused = refusalOf(edited(edit));
      expect(refused.rejected.file).toBe('boite-plugin.json');
      expect(refused.rejected.field).toBe(field);
      expect(refused.rejected.expected).toContain(expected);
      expect(refused.message).toStartWith(`boite-plugin.json: ${field} must be `);
    });
  }

  test('refuses a file that is not JSON, and one that is not an object', () => {
    expect(() => parseManifestText('{"schema":', 'boite-plugin.json')).toThrow('boite-plugin.json: (file) must be valid JSON');
    expect(refusalOf([good()]).rejected.field).toBe('(root)');
  });

  test('places the fields of a manifest wrapped in installed.json', () => {
    try {
      parseManifest({ ...good(), schema: 0 }, 'installed.json', 'manifest.');
      throw new Error('accepted');
    } catch (error) {
      expect((error as ManifestRefused).rejected.field).toBe('manifest.schema');
    }
  });
});

describe('the recommended list', () => {
  test('lists the pool and browser plugins with their pinned release assets', () => {
    expect(RECOMMENDED.map((manifest) => manifest.id)).toEqual(['kebacc-switcher', 'jev-browser']);
    const kebacc = RECOMMENDED[0]!;
    expect(kebacc.version).toBe('2.0.1');
    expect(kebacc.executable).toBe('kebacc');
    expect(kebacc.provides.accountPools?.providers).toEqual(['claude', 'codex', 'antigravity']);
    expect(kebacc.artifacts['win32-x64']).toEqual({
      url: 'https://github.com/kebab1337420/kebacc-switch/releases/download/kebacc-v2.0.1/kebacc-x86_64-pc-windows-msvc.exe',
      sha256: '9edc5c3af1db76e97a9c07e2fd1c3399ad8c9db22e0ad2684a1b885e33acc538',
    });
    expect(kebacc.artifacts['linux-arm64']?.sha256).toBe('258dd96565bad8c4194b1fdaf182d784d8a617cef0a397c1210a9a4cb9e2df17');
    expect(Object.keys(kebacc.artifacts)).toHaveLength(6);
  });
});

describe('pool providers', () => {
  let harness: TestCore | undefined;
  afterEach(async () => { await harness?.stop(); harness = undefined; });

  test('are the shipped providers, echo aside', async () => {
    harness = await startTestCore();
    const shipped = harness.core.providers.list().loaded.map((provider) => provider.id).filter((id) => id !== 'echo');
    expect([...POOL_PROVIDERS].sort()).toEqual(shipped.sort());
  });
});

describe('a plugin source', () => {
  test('is an https repository URL, normalized', () => {
    expect(normalizeSourceUrl(' https://github.com/owner/repo/ ')).toBe('https://github.com/owner/repo');
    expect(normalizeSourceUrl('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
  });

  test('refuses every other transport, credentials, queries and local paths', () => {
    for (const url of ['http://github.com/owner/repo', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo', 'file:///C:/repo', 'ext::sh -c touch% /tmp/pwned', 'git://github.com/owner/repo']) {
      expect(() => normalizeSourceUrl(url)).toThrow('plugin url must be an https URL');
    }
    expect(() => normalizeSourceUrl('https://token@github.com/owner/repo')).toThrow('carrying credentials');
    expect(() => normalizeSourceUrl('https://github.com/owner/repo?x=1')).toThrow('no query or fragment');
    expect(() => normalizeSourceUrl(process.cwd())).toThrow('plugin url must be an https URL');
    expect(() => normalizeSourceUrl('')).toThrow('plugin url must be');
  });

  test('takes a local path only when the store allows it, which only tests do', () => {
    expect(normalizeSourceUrl(process.cwd(), true)).toBe(process.cwd());
  });

  test('reads a ref that git cannot take as an option', () => {
    expect(checkRef(undefined)).toBe('HEAD');
    expect(checkRef('')).toBe('HEAD');
    expect(checkRef('v1.4.0')).toBe('v1.4.0');
    expect(checkRef('release/1.x')).toBe('release/1.x');
    for (const ref of ['--upload-pack=touch', '-x', 'a..b', 'main/', 'x.lock', 'a b', 42]) {
      expect(() => checkRef(ref)).toThrow('plugin ref must be');
    }
  });
});
