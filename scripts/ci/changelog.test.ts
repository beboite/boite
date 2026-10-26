import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previousRelease, releaseNotes, type Release } from './changelog.ts';

const release = (tag: string, date: string, prerelease = false, draft = false): Release => ({
  tag_name: tag, published_at: date, prerelease, draft,
});

test('stable notes exclude drafts, nightlies, prereleases and unrelated branches', () => {
  const releases = [
    release('v1.0.0', '2026-01-01'),
    release('v1.1.0-beta.1', '2026-01-02', true),
    release('v1.1.0', '2026-01-03', false, true),
    release('v1.1.0-nightly.20260104.1', '2026-01-04', true),
    release('v9.0.0', '2026-01-05'),
  ];
  expect(previousRelease(releases, 'v2.0.0', (tag) => tag !== 'v9.0.0')).toBe('v1.0.0');
  expect(previousRelease(releases, 'v1.1.0-beta.2', (tag) => tag !== 'v9.0.0')).toBe('v1.1.0-beta.1');
});

test('nightlies compare with the previous published nightly', () => {
  expect(previousRelease([
    release('v1.0.0-nightly.20260101.1', '2026-01-01', true),
    release('v1.0.0', '2026-01-02'),
    release('v1.0.0-nightly.20260103.1', '2026-01-03', true),
  ], 'v1.0.0-nightly.20260103.1', () => true)).toBe('v1.0.0-nightly.20260101.1');
});

test('direct commits and an optional announcement appear without manual notes', () => {
  const notes = releaseNotes([
    { sha: 'a'.repeat(40), subject: 'Fix [provider] selection' },
    { sha: 'b'.repeat(40), subject: 'Add Docker deployment' },
  ], 'example/boite', 'v1.1.0', 'v1.0.0', 'A short announcement.');
  expect(notes.startsWith('A short announcement.\n\n')).toBe(true);
  expect(notes).toContain('Fix \\[provider\\] selection');
  expect(notes).toContain('/commit/' + 'b'.repeat(40));
  expect(notes).toContain('/compare/v1.0.0...v1.1.0');
});

test('typed subjects are grouped, untyped ones fall under other changes', () => {
  const notes = releaseNotes([
    { sha: 'a'.repeat(40), subject: 'fix(ui): normalize spacing' },
    { sha: 'b'.repeat(40), subject: 'feat: add dictation' },
    { sha: 'c'.repeat(40), subject: 'Point the cargo note at the docs' },
    { sha: 'd'.repeat(40), subject: 'chore(deps): bump node' },
    { sha: 'e'.repeat(40), subject: 'feat(core)!: drop schema 8' },
  ], 'example/boite', 'v1.1.0');
  const features = notes.indexOf('### Features');
  const fixes = notes.indexOf('### Fixes');
  const other = notes.indexOf('### Other changes');
  expect(features).toBeGreaterThanOrEqual(0);
  expect(fixes).toBeGreaterThan(features);
  expect(other).toBeGreaterThan(fixes);
  expect(notes).not.toContain('### Performance');
  expect(notes.slice(features, fixes)).toContain('drop schema 8');
  expect(notes.slice(other)).toContain('bump node');
  expect(notes.slice(other)).toContain('Point the cargo note');
});

test('each commit credits its author and co-authors, GitHub accounts by login', () => {
  const notes = releaseNotes([
    { sha: 'a'.repeat(40), subject: 'fix: one', authors: ['meetsu <96637888+klNuno@users.noreply.github.com>', 'Chris <76012699+ChrisPlayer@users.noreply.github.com>'] },
    { sha: 'b'.repeat(40), subject: 'fix: two', authors: ['Jane_Doe <jane@example.com>', 'old <old-login@users.noreply.github.com>', 'meetsu <96637888+klNuno@users.noreply.github.com>'] },
    { sha: 'c'.repeat(40), subject: 'fix: three' },
  ], 'example/boite', 'v1.1.0');
  expect(notes).toContain(`/commit/${'a'.repeat(40)})) by @klNuno, @ChrisPlayer\n`);
  expect(notes).toContain(`/commit/${'b'.repeat(40)})) by Jane\\_Doe, @old-login, @klNuno\n`);
  expect(notes).toContain(`/commit/${'c'.repeat(40)}))\n`);
});

test('the first release has no invented previous version', () => {
  expect(previousRelease([], 'v1.0.0', () => true)).toBeUndefined();
  expect(releaseNotes([{ sha: 'a'.repeat(40), subject: 'Initial implementation' }], 'example/boite', 'v1.0.0')).not.toContain('/compare/');
});

test('release downloads link the actual installers by platform before the changelog', () => {
  const version = '2.0.0-beta.2';
  const installers = [
    `Boite_${version}_x64-setup.exe`,
    `Boite_${version}_aarch64.dmg`, `Boite_${version}_x64.dmg`,
    `Boite_${version}_amd64.deb`, `Boite_${version}_amd64.AppImage`,
    `Boite_${version}_arm64.deb`, `Boite_${version}_aarch64.AppImage`,
    `boite-server_${version}_x64.zip`, `boite-server_${version}_arm64.zip`,
    `boite-server_${version}_android.zip`,
    // Reused APKs keep their own versions, independently of the desktop release.
    'boite-android-1.0.1.apk', 'boite-server-android-1.0.0.apk',
  ];
  const notes = releaseNotes([{ sha: 'a'.repeat(40), subject: 'feat: ship this change' }],
    'example/boite', `v${version}`, 'v2.0.0-beta.1', 'An announcement.', [
      ...installers, ...installers.map((file) => `${file}.sig`),
      `Boite_${version}_aarch64.app.tar.gz`, 'latest.json', 'SHA256SUMS.txt',
    ]);
  expect(notes.indexOf('## Downloads')).toBeLessThan(notes.indexOf('An announcement.'));
  expect(notes.indexOf('An announcement.')).toBeLessThan(notes.indexOf('### Features'));
  for (const platform of ['Windows (x64)', 'macOS (Apple Silicon)', 'macOS (Intel)', 'Linux (x64)', 'Linux (ARM64)', 'Android']) {
    expect(notes).toContain(platform);
  }
  for (const installer of installers) expect(notes).toContain(`https://github.com/example/boite/releases/download/v${version}/${installer}`);
  expect(notes.match(/\/releases\/download\//g)).toHaveLength(installers.length);
  expect(notes).not.toContain('.sig');
  expect(notes).not.toContain('.app.tar.gz');
  expect(notes).not.toContain('latest.json');
  expect(notes).not.toContain('[!WARNING]');
  expect(notes).toContain('/compare/v2.0.0-beta.1...v2.0.0-beta.2');
});

test('nightly warnings come first and downloads never invent absent assets', () => {
  const files = ['Boite_2.0.0-nightly.20261025.1_x64-setup.exe'];
  for (const tag of ['v2.0.0-nightly.20261025.1', 'nightly-20261025']) {
    const notes = releaseNotes([], 'example/boite', tag, undefined, 'An announcement.', files);
    expect(notes.startsWith('> [!WARNING]\n')).toBe(true);
    expect(notes).toContain('unstable');
    expect(notes.indexOf('## Downloads')).toBeLessThan(notes.indexOf('An announcement.'));
    expect(notes).toContain(files[0]!);
    for (const absent of ['.dmg', '.deb', '.AppImage', '.apk', '.zip']) expect(notes).not.toContain(absent);
  }
});

test('the publication CLI reads desktop and reused Android artifacts from separate directories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-release-notes-'));
  const run = (args: string[], env?: Record<string, string>) => {
    const result = Bun.spawnSync(args, { cwd: directory, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    expect(result.stderr.toString()).not.toContain('error:');
    expect(result.exitCode).toBe(0);
  };
  try {
    run(['git', 'init', '-q']);
    run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'feat: fixture']);
    writeFileSync(join(directory, 'released.json'), '[]');
    for (const folder of ['artifacts', 'android', 'android-server']) mkdirSync(join(directory, folder));
    writeFileSync(join(directory, 'artifacts', 'Boite_2.0.0-nightly.20261025.1_x64-setup.exe'), 'fixture');
    writeFileSync(join(directory, 'android', 'boite-android-1.0.1.apk'), 'fixture');
    writeFileSync(join(directory, 'android-server', 'boite-server-android-1.0.0.apk'), 'fixture');
    run([process.execPath, join(import.meta.dir, 'changelog.ts'), 'released.json', 'artifacts/release-notes.md', 'artifacts', 'android', 'android-server'], {
      GITHUB_REPOSITORY: 'example/boite', RELEASE_TAG: 'v2.0.0-nightly.20261025.1', RELEASE_ANNOUNCEMENT: '',
    });
    const notes = readFileSync(join(directory, 'artifacts/release-notes.md'), 'utf8');
    expect(notes).toContain('unstable');
    expect(notes).toContain('Boite_2.0.0-nightly.20261025.1_x64-setup.exe');
    expect(notes).toContain('boite-android-1.0.1.apk');
    expect(notes).toContain('boite-server-android-1.0.0.apk');
    expect(notes).toContain('feat: fixture');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
