import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import type { ProviderInstall } from '@boite/contracts';
import { resolveLatestInstall } from '../src/providers/install-latest.ts';
import { Rejection, validateDescriptor } from '../src/providers/validate.ts';
import claudeShipped from '../src/providers/shipped/claude.json';

const SHA = 'a'.repeat(64);

const PINNED: ProviderInstall = {
  format: 'binary',
  version: '2.1.267',
  url: 'https://downloads.example/2.1.267/win32-x64/claude.exe',
  sha256: 'b'.repeat(64),
  archiveBytes: 100,
  files: [{ path: 'claude.exe', bytes: 100 }],
  latest: {
    versionUrl: 'https://downloads.example/latest',
    manifest: 'https://downloads.example/{version}/manifest.json',
    platform: 'win32-x64',
    url: 'https://downloads.example/{version}/win32-x64/claude.exe',
  },
};

/** A publisher answering from a table, so no test reaches the network. */
function publisher(version: string, manifest: unknown): (url: string) => Promise<string> {
  return async (url) => {
    if (url === 'https://downloads.example/latest') return `${version}\n`;
    if (url === `https://downloads.example/${version}/manifest.json`) return typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    throw new Error(`unexpected ${url}`);
  };
}

function manifest(entry: Record<string, unknown>, version = '2.1.295'): Record<string, unknown> {
  return { version, platforms: { 'win32-x64': entry, 'linux-x64': { binary: 'claude', checksum: 'c'.repeat(64), size: 5 } } };
}

describe('the newest release a publisher names', () => {
  test('becomes an install block with the manifest digest and size', async () => {
    const resolved = await resolveLatestInstall(PINNED, publisher('2.1.295', manifest({ binary: 'claude.exe', checksum: SHA.toUpperCase(), size: 259_509_920 })));
    expect(resolved).toEqual({
      ...PINNED,
      version: '2.1.295',
      url: 'https://downloads.example/2.1.295/win32-x64/claude.exe',
      sha256: SHA,
      archiveBytes: 259_509_920,
      files: [{ path: 'claude.exe', bytes: 259_509_920 }],
    });
  });

  test('a pinned block with no publisher comes back as it is', async () => {
    const { latest: _, ...pinned } = PINNED;
    expect(await resolveLatestInstall(pinned, async () => { throw new Error('read'); })).toBe(pinned);
  });

  test('a manifest that does not describe that binary, version or digest is refused by what is wrong', async () => {
    const good = { binary: 'claude.exe', checksum: SHA, size: 10 };
    const cases: [string, (url: string) => Promise<string>, string][] = [
      ['another binary', publisher('2.1.295', manifest({ ...good, binary: 'claude' })), 'names claude for win32-x64, expected claude.exe'],
      ['no digest', publisher('2.1.295', manifest({ ...good, checksum: 'nope' })), 'no sha256 checksum'],
      ['no size', publisher('2.1.295', manifest({ ...good, size: 0 })), 'no positive size'],
      ['another version', publisher('2.1.295', manifest(good, '2.1.200')), 'describes 2.1.200, not 2.1.295'],
      ['no platform', publisher('2.1.295', { version: '2.1.295', platforms: {} }), 'has no win32-x64 entry'],
      ['not JSON', publisher('2.1.295', '<html>'), 'is not JSON'],
      ['a path for a version', publisher('../x', manifest(good)), 'named no plain version'],
    ];
    for (const [name, read, message] of cases) {
      const error = await resolveLatestInstall(PINNED, read).then(() => null, (thrown: unknown) => thrown as Error);
      expect(error?.message, name).toContain(message);
    }
  });
});

describe('a descriptor that follows its publisher', () => {
  const descriptor = (install: Record<string, unknown>): unknown => {
    const raw = structuredClone(claudeShipped) as { profiles: Record<string, Record<string, unknown>> };
    raw.profiles['windows']!['install'] = install;
    return raw;
  };
  const shipped = (claudeShipped.profiles.windows as { install: Record<string, unknown> }).install;

  test('ships Claude on Windows with its release bucket', () => {
    const loaded = validateDescriptor(claudeShipped, 'claude.json', new Set(), tmpdir());
    expect(loaded.profiles.windows?.install?.latest?.platform).toBe('win32-x64');
  });

  test('is refused for a zip, a plain http url or a url with no {version}', () => {
    const latest = shipped['latest'] as Record<string, string>;
    const cases: [Record<string, unknown>, string][] = [
      [{ ...shipped, format: 'zip' }, 'profiles.windows.install.latest'],
      [{ ...shipped, latest: { ...latest, manifest: 'http://downloads.claude.ai/{version}/manifest.json' } }, 'profiles.windows.install.latest.manifest'],
      [{ ...shipped, latest: { ...latest, url: 'https://downloads.claude.ai/claude.exe' } }, 'profiles.windows.install.latest.url'],
      [{ ...shipped, latest: { ...latest, platform: 'win32/x64' } }, 'profiles.windows.install.latest.platform'],
    ];
    for (const [install, field] of cases) {
      let rejected: Rejection | null = null;
      try { validateDescriptor(descriptor(install), 'claude.json', new Set(), tmpdir()); }
      catch (error) { if (error instanceof Rejection) rejected = error; else throw error; }
      expect(rejected?.rejected.field).toBe(field);
    }
  });
});
