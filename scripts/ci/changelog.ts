import { readFileSync, writeFileSync } from 'node:fs';

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}
export interface Commit { sha: string; subject: string }

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

export function releaseNotes(
  commits: Commit[], repository: string, tag: string, previous?: string, announcement = '',
): string {
  const url = `https://github.com/${repository}`;
  const changes = commits.map(({ sha, subject }) =>
    `- ${escapeMarkdown(subject)} ([${sha.slice(0, 7)}](${url}/commit/${sha}))`,
  ).join('\n');
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
  const commits = git(['log', '--no-merges', '--format=%H%x00%s', range])
    .split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf('\0');
      return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
    });
  const notes = releaseNotes(commits, repository, tag, previous, process.env.RELEASE_ANNOUNCEMENT);
  writeFileSync(process.argv[3] ?? 'release-notes.md', notes);
  console.log(`Changelog: ${commits.length} commits since ${previous ?? 'the first commit'}`);
}
