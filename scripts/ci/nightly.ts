import { appendFileSync, readFileSync } from 'node:fs';

export interface NightlyTag { name: string; commit: { sha: string } }
export function needsNightly(sha: string, released: string[]): boolean {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('expected a full commit SHA');
  return !released.includes(sha);
}
export function nightlyVersion(base: string, date: string, sha: string, tags: NightlyTag[]): string {
  needsNightly(sha, []);
  const version = base.match(/^\d+\.\d+\.\d+/)?.[0];
  if (!version || !/^\d{8}$/.test(date)) throw new Error('expected a semantic version and YYYYMMDD date');
  const pattern = /^v\d+\.\d+\.\d+-nightly\.(\d{8})\.(\d+)$/;
  const previous = tags.find((tag) => pattern.test(tag.name) && tag.commit.sha === sha);
  if (previous) return previous.name.slice(1);
  const counters = tags.flatMap((tag) => {
    const match = tag.name.match(pattern);
    return match?.[1] === date ? [Number(match[2])] : [];
  });
  return `${version}-nightly.${date}.${Math.max(0, ...counters) + 1}`;
}

if (import.meta.main) {
  const sha = process.env.GITHUB_SHA ?? '';
  const releases = JSON.parse(readFileSync(process.argv[2]!, 'utf8')).flat();
  const tags: NightlyTag[] = JSON.parse(readFileSync(process.argv[3]!, 'utf8')).flat();
  const published = new Set(releases.filter((r: any) => !r.draft).map((r: any) => r.tag_name));
  const released = tags.filter((tag) => tag.name.includes('-nightly.') && published.has(tag.name)).map((tag) => tag.commit.sha);
  const changed = needsNightly(sha, released);
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const base = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const version = nightlyVersion(base, date, sha, tags);
  const tag = `v${version}`;
  const reserved = tags.some((candidate) => candidate.name === tag);
  const output = `changed=${changed}\ntag=${tag}\nversion=${version}\nreserved=${reserved}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
