import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { targetOf } from './updater-manifest.ts';

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}
/** `authors` are the commit's author then its `Co-authored-by` trailers, as `Name <email>`. */
export interface Commit { sha: string; subject: string; authors?: string[] }

const isNightly = (tag: string) => tag.includes('-nightly.') || tag.startsWith('nightly-');

export function previousRelease(
  releases: Release[], current: string, ancestor: (tag: string) => boolean,
): string | undefined {
  const nightly = isNightly(current);
  const prerelease = current.includes('-');
  return releases
    .filter((release) => !release.draft && release.tag_name !== current)
    .filter((release) => nightly
      ? isNightly(release.tag_name)
      : !isNightly(release.tag_name) && /^v\d+\.\d+\.\d+/.test(release.tag_name) && (prerelease || !release.prerelease))
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
    .find((release) => ancestor(release.tag_name))?.tag_name;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, '\\$&');
}

// Subjects follow the pull request title check (scripts/ci/pr-title.ts). Older
// or direct commits without a known type land under "Other changes".
const SECTIONS = [['feat', 'Features'], ['fix', 'Fixes'], ['perf', 'Performance']] as const;

// A GitHub noreply address names the account: `@login` links its profile and
// lists it among the release's contributors. Any other address shows the name.
function credit(author: string): string {
  const match = /^(.*?)\s*<([^>]*)>$/.exec(author.trim());
  const name = match ? match[1]! : author.trim();
  const login = /^(?:\d+\+)?([\w-]+)@users\.noreply\.github\.com$/i.exec(match?.[2] ?? '')?.[1];
  return login ? `@${login}` : escapeMarkdown(name);
}

function credits(authors: string[] = []): string {
  const names = [...new Set(authors.map(credit).filter(Boolean))];
  return names.length > 0 ? ` by ${names.join(', ')}` : '';
}

function commitType(subject: string): string | undefined {
  return /^(\w+)(?:\([^)]*\))?!?: /.exec(subject)?.[1];
}

/** Only manual downloads belong here; signatures and updater payloads stay in Assets. */
function downloadNotes(repository: string, tag: string, files: string[]): string {
  const base = `https://github.com/${repository}`;
  const encodedTag = encodeURIComponent(tag);
  const link = (label: string, matches: (file: string) => boolean) => {
    const file = files.find(matches);
    return file ? `[${label}](${base}/releases/download/${encodedTag}/${encodeURIComponent(file)})` : '';
  };
  const target = (label: string, name: string) => link(label, (file) => targetOf(file) === name);
  const match = (label: string, pattern: RegExp) => link(label, (file) => pattern.test(file));
  const table = (rows: Array<[string, string[]]>) => {
    const present = rows.filter(([, links]) => links.some(Boolean));
    return present.length ? [
      '| Platform | Download |', '| --- | --- |',
      ...present.map(([platform, links]) => `| ${platform} | ${links.filter(Boolean).join(' · ')} |`),
    ].join('\n') : '';
  };
  const desktop = table([
    ['Windows (x64)', [target('Installer (.exe)', 'windows-x86_64')]],
    ['macOS (Apple Silicon)', [match('Disk image (.dmg)', /_aarch64\.dmg$/)]],
    ['macOS (Intel)', [match('Disk image (.dmg)', /_x64\.dmg$/)]],
    ['Linux (x64)', [target('Debian / Ubuntu (.deb)', 'linux-x86_64-deb'), target('AppImage', 'linux-x86_64-appimage')]],
    ['Linux (ARM64)', [target('Debian / Ubuntu (.deb)', 'linux-aarch64-deb'), target('AppImage', 'linux-aarch64-appimage')]],
    ['Android (client)', [match('Boite (.apk)', /^boite-android-\d+\.\d+\.\d+\.apk$/)]],
    ['Android (server, ARM64)', [match('Boite Server (.apk)', /^boite-server-android-\d+\.\d+\.\d+\.apk$/)]],
  ]);
  const server = table([
    ['Linux (x64)', [target('Server (.zip)', 'linux-x86_64-server')]],
    ['Linux (ARM64)', [target('Server (.zip)', 'linux-aarch64-server')]],
    ['Android / Termux (ARM64)', [target('Server bundle (.zip)', 'android-aarch64-server')]],
  ]);
  if (!desktop && !server) return '';
  const docs = `${base}/blob/${encodedTag}/docs`;
  return [
    '## Downloads', desktop,
    `[Desktop installation](${docs}/portability.md) · [Android app](${docs}/android.md) · [Android server setup (Termux required)](${docs}/android-server.md)`,
    ...(server ? ['### Headless server', server, `[Self-hosting guide](${docs}/server.md)`] : []),
  ].filter(Boolean).join('\n\n');
}

export function releaseNotes(
  commits: Commit[], repository: string, tag: string, previous?: string, announcement = '', files: string[] = [],
): string {
  const url = `https://github.com/${repository}`;
  const list = (group: Commit[]) => group.map(({ sha, subject, authors }) =>
    `- ${escapeMarkdown(subject)} ([${sha.slice(0, 7)}](${url}/commit/${sha}))${credits(authors)}`,
  ).join('\n');
  const known = new Set<string>(SECTIONS.map(([type]) => type));
  const groups = [
    ...SECTIONS.map(([type, title]) => [title, commits.filter((commit) => commitType(commit.subject) === type)] as const),
    ['Other changes', commits.filter((commit) => !known.has(commitType(commit.subject) ?? ''))] as const,
  ].filter(([, group]) => group.length > 0);
  // A list with nothing to tell apart needs no heading.
  const changes = groups.length === 1 && groups[0]![0] === 'Other changes'
    ? list(groups[0]![1])
    : groups.map(([title, group]) => `### ${title}\n\n${list(group)}`).join('\n\n');
  const compare = previous
    ? `[Full diff](${url}/compare/${encodeURIComponent(previous)}...${encodeURIComponent(tag)})`
    : '';
  const warning = isNightly(tag)
    ? '> [!WARNING]\n> Nightly builds are unstable and may contain bugs or unfinished changes. Back up your Boite data before installing or switching channels.'
    : '';
  const downloads = downloadNotes(repository, tag, files);
  return [warning, downloads, announcement.trim(), downloads ? '## What\'s changed' : '', changes || 'No code changes.', compare]
    .filter(Boolean).join('\n\n') + '\n';
}

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

if (import.meta.main) {
  const tag = process.env.RELEASE_TAG;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!tag || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('RELEASE_TAG and GITHUB_REPOSITORY (owner/repository) are required');
  }
  const pages = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Release[][];
  const releases = pages.flat();
  const previous = previousRelease(releases, tag, (candidate) => {
    const ref = `refs/tags/${candidate}`;
    const result = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', ref, 'HEAD'], { stderr: 'pipe' });
    if (result.exitCode > 1) throw new Error(`cannot resolve published release ${candidate}: ${result.stderr.toString()}`);
    return result.exitCode === 0;
  });
  const range = previous ? `refs/tags/${previous}..HEAD` : 'HEAD';
  // One NUL-ended record per commit, its fields split by US: a trailer value
  // never holds either, and every field stays on its own commit.
  const commits = git(['log', '--no-merges', '-z',
    '--format=%H%x1f%s%x1f%an <%ae>%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1f)', range])
    .split('\0').filter(Boolean).map((record) => {
      const [sha = '', subject = '', author = '', ...coauthors] = record.trim().split('\x1f');
      return { sha, subject, authors: [author, ...coauthors].map((name) => name.trim()).filter(Boolean) };
    });
  const files = process.argv.slice(4).flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
  const notes = releaseNotes(commits, repository, tag, previous, process.env.RELEASE_ANNOUNCEMENT, files);
  writeFileSync(process.argv[3] ?? 'release-notes.md', notes);
  console.log(`Changelog: ${commits.length} commits since ${previous ?? 'the first commit'}`);
}
