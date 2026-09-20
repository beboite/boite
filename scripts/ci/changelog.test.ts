import { expect, test } from 'bun:test';
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

test('the first release has no invented previous version', () => {
  expect(previousRelease([], 'v1.0.0', () => true)).toBeUndefined();
  expect(releaseNotes([{ sha: 'a'.repeat(40), subject: 'Initial implementation' }], 'example/boite', 'v1.0.0')).not.toContain('/compare/');
});
