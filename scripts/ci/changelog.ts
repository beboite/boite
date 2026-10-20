import { readFileSync, writeFileSync } from 'node:fs';

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}
/** `authors` are the commit's author then its `Co-authored-by` trailers, as `Name <email>`. */
export interface Commit { sha: string; subject: string; authors?: string[] }

export function previousRelease(
  releases: Release[], current: string, ancestor: (tag: string) => boolean,
): string | undefined {
  const isNightly = (tag: string) => tag.includes('-nightly.') || tag.startsWith('nightly-');
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

export function releaseNotes(
  commits: Commit[], repository: string, tag: string, previous?: string, announcement = '',
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
  return [announcement.trim(), changes || 'No code changes.', compare].filter(Boolean).join('\n\n') + '\n';
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
  const notes = releaseNotes(commits, repository, tag, previous, process.env.RELEASE_ANNOUNCEMENT);
  writeFileSync(process.argv[3] ?? 'release-notes.md', notes);
  console.log(`Changelog: ${commits.length} commits since ${previous ?? 'the first commit'}`);
}
