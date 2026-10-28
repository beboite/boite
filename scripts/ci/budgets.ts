/**
 * Bundle sizes: the UI's entry chunk, the whole UI without its precompressed
 * copies, the core entry and all emitted core JavaScript. Sizes are
 * deterministic for a commit, unlike timings on a shared runner, so they can
 * fail a pull request. No file in the repository holds a limit
 * (docs/ci.md#bundle-growth):
 *
 * - a pull request is measured against the main commit its merge ref sits on
 *   (comparisonBase), which bundle-size.yml
 *   measured on its push to main and kept as the `bundle-sizes` artifact (or
 *   this job builds when that run is missing). A measure growing more than 0.1 % needs a `## Bundle size`
 *   section in the pull request body;
 * - the ceiling is the last published build (a nightly or a release) plus 2 %,
 *   so only publishing raises it. A pull request fails it only for growth it
 *   adds: when main already sits above it, the debt is reported and main's own
 *   run (`ceiling`, bundle-size.yml) fails on it.
 *
 * Run: bun scripts/ci/budgets.ts measure <out.json> (after build:ui and build:core)
 *      bun scripts/ci/budgets.ts check <head.json> (in a pull request's CI)
 *      bun scripts/ci/budgets.ts ceiling <main.json> (on a push to main)
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Sizes {
  /** bytes */
  uiEntryChunk: number;
  uiDist: number;
  coreBundle: number;
  /** Includes worker entries and lazy chunks; excludes native binaries and maps. */
  coreJavaScript: number;
}

/** What `measure` writes and the `bundle-sizes` artifact holds. */
export interface Measurement {
  commit: string;
  sizes: Sizes;
}

export const MEASURES = ['uiEntryChunk', 'uiDist', 'coreBundle', 'coreJavaScript'] as const satisfies readonly (keyof Sizes)[];
/** Headroom of the ceiling above the last published build. */
export const HEADROOM = 0.02;
/** Growth over the base above which the pull request body must explain it. */
export const EXPLAIN_ABOVE = 0.001;
export const ARTIFACT = 'bundle-sizes';

const ROOT = join(import.meta.dir, '..', '..');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** The entry chunk is the one script index.html loads. */
export function entryChunk(indexHtml: string): string {
  const match = /<script[^>]+type="module"[^>]+src="(?:\.?\/)?([^"]+\.js)"/.exec(indexHtml);
  if (!match) throw new Error('packages/ui/dist/index.html: no module script, expected <script type="module" src="assets/index-*.js">');
  return match[1]!;
}

export function measure(root = ROOT): Sizes {
  const ui = join(root, 'packages', 'ui', 'dist');
  const core = join(root, 'packages', 'core', 'dist', 'main.js');
  for (const [path, build] of [[join(ui, 'index.html'), 'bun run build:ui'], [core, 'bun run build:core']] as const) {
    if (!existsSync(path)) throw new Error(`${path}: missing, run ${build} first`);
  }
  const chunk = entryChunk(readFileSync(join(ui, 'index.html'), 'utf8'));
  return {
    uiEntryChunk: statSync(join(ui, chunk)).size,
    uiDist: files(ui).filter((file) => !/\.(?:br|gz)$/.test(file)).reduce((sum, file) => sum + statSync(file).size, 0),
    coreBundle: statSync(core).size,
    coreJavaScript: files(join(root, 'packages', 'core', 'dist'))
      .filter((file) => /\.(?:js|mjs|cjs)$/.test(file))
      .reduce((sum, file) => sum + statSync(file).size, 0),
  };
}

export function ceiling(published: Sizes): Sizes {
  return Object.fromEntries(MEASURES.map((key) => [key, Math.floor(published[key] * (1 + HEADROOM))])) as unknown as Sizes;
}

/** Markdown without its `<!-- -->` comments, removed until none is left; an unclosed one runs to the end. */
function withoutComments(text: string): string {
  const once = withoutCommentsOnce(text);
  return once === text ? text : withoutComments(once);
}

function withoutCommentsOnce(text: string): string {
  let kept = '';
  let at = 0;
  for (let open = text.indexOf('<!--'); open !== -1; open = text.indexOf('<!--', at)) {
    kept += text.slice(at, open);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return kept;
    at = close + 3;
  }
  return kept + text.slice(at);
}

/** The text under a `## Bundle size` heading, comments removed; undefined when absent or empty. */
export function bodyReason(body: string | null | undefined): string | undefined {
  const text = withoutComments((body ?? '').replace(/\r\n/g, '\n'));
  const heading = /^#{2,3}[ \t]+bundle size[ \t]*$/im.exec(text);
  if (!heading) return undefined;
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^#{1,3}[ \t]/m.exec(rest);
  const reason = (next ? rest.slice(0, next.index) : rest).trim();
  return reason || undefined;
}

export interface Reference {
  sizes: Sizes;
  /** Where the sizes come from, for the report: "`a1b2c3d4` (main)". */
  source: string;
}

export interface Verdict {
  /** Markdown table for the job summary. */
  report: string;
  /** Each failure, naming the measure and what to do. */
  errors: string[];
}

const bytes = (value: number) => value.toLocaleString('en-US');
const signed = (value: number) => `${value > 0 ? '+' : ''}${bytes(value)}`;

/**
 * The verdict on `head`. With a base, the ceiling fails only growth past
 * `max(base, ceiling)`: what main already carries above it is debt, reported
 * here and failed by main's own check, which passes no base.
 */
export function judge(head: Sizes, base: Reference | undefined, limit: Reference | undefined, reason: string | undefined): Verdict {
  const rows = ['| Measure | Measured | Base | Growth | Ceiling |', '| --- | ---: | ---: | ---: | ---: |'];
  const errors: string[] = [];
  const debts: string[] = [];
  const unexplained: string[] = [];
  const shrink = 'Shrink the change; the ceiling rises only when a nightly or a release is published.';
  for (const key of MEASURES) {
    const growth = base ? head[key] - base.sizes[key] : undefined;
    const ratio = base && growth !== undefined ? growth / base.sizes[key] : undefined;
    rows.push(`| ${key} | ${bytes(head[key])} | ${base ? bytes(base.sizes[key]) : 'n/a'} | ${growth === undefined ? 'n/a' : `${signed(growth)} (${(ratio! * 100).toFixed(2)} %)`} | ${limit ? bytes(limit.sizes[key]) : 'n/a'} |`);
    if (limit && head[key] > limit.sizes[key]) {
      const ceilingOf = `${bytes(limit.sizes[key])}-byte ceiling (${limit.source} plus ${HEADROOM * 100} %)`;
      if (!base || base.sizes[key] <= limit.sizes[key]) errors.push(`${key}: ${bytes(head[key])} bytes, above its ${ceilingOf}. ${shrink}`);
      else if (growth! > 0) errors.push(`${key}: ${bytes(head[key])} bytes, ${bytes(growth!)} more than ${base.source}, which is already above its ${ceilingOf}. ${shrink}`);
      else debts.push(`${key}: ${bytes(head[key])} bytes, ${bytes(head[key] - limit.sizes[key])} above the ${bytes(limit.sizes[key])}-byte ceiling, carried from ${base.source}; main's own bundle size run fails on it.`);
    }
    if (ratio !== undefined && ratio > EXPLAIN_ABOVE) unexplained.push(`${key} ${signed(growth!)} bytes (${(ratio * 100).toFixed(2)} %)`);
  }
  if (unexplained.length && !reason) {
    errors.push(`${unexplained.join(', ')} over ${base!.source}, above ${EXPLAIN_ABOVE * 100} %: say what grows and why under a "## Bundle size" heading in the pull request body, then rerun this job.`);
  }
  const notes = [
    base ? `Base: ${base.source}.` : 'Base: no measurement, growth not checked.',
    limit ? `Ceiling: ${limit.source} plus ${HEADROOM * 100} %.` : 'Ceiling: no published measurement, not checked.',
    ...(debts.length ? ['', 'Above the ceiling before this pull request:', ...debts.map((debt) => `- ${debt}`)] : []),
    // Shown in the job summary, which renders HTML: the body's text stays text.
    ...(reason ? ['', `Reason given in the body: ${reason.split('\n')[0]!.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`)}`] : []),
  ];
  return { report: [...rows, '', ...notes].join('\n'), errors };
}

// GitHub lookups. Every measurement comes from a `bundle size` push run on main of this
// repository: a pull request's own artifact cannot stand in for its base or the ceiling.

interface Run { id: number; path: string; head_sha: string; head_branch: string | null; event: string; repository: { id: number }; head_repository: { id: number } | null }

export function mainRun(runs: Run[], sha: string): Run | undefined {
  return runs.find((run) => run.path === '.github/workflows/bundle-size.yml' && run.event === 'push' && run.head_branch === 'main'
    && run.head_sha === sha && run.head_repository?.id === run.repository.id);
}

/** Published releases newest first, keeping those whose target is a commit. */
export function publishedCommits(releases: { draft: boolean; tag_name: string; target_commitish: string; published_at: string | null }[]): { tag: string; sha: string }[] {
  return releases
    .filter((release) => !release.draft && release.published_at && /^[0-9a-f]{40}$/.test(release.target_commitish))
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!))
    .map((release) => ({ tag: release.tag_name, sha: release.target_commitish }));
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function run(command: string[], cwd?: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')}: exit ${result.exitCode}`);
}

/** The sizes bundle-size.yml measured at `sha`, or undefined when it has none (cancelled, skipped, expired). */
async function mainMeasurement(sha: string): Promise<Sizes | undefined> {
  const { workflow_runs } = await api<{ workflow_runs: Run[] }>(`actions/runs?head_sha=${sha}&branch=main&event=push&per_page=20`);
  const found = mainRun(workflow_runs, sha);
  if (!found) return undefined;
  const { artifacts } = await api<{ artifacts: { name: string; expired: boolean }[] }>(`actions/runs/${found.id}/artifacts?name=${ARTIFACT}`);
  if (!artifacts.some((artifact) => !artifact.expired)) return undefined;
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'bundle-sizes-'));
  run(['gh', 'run', 'download', String(found.id), '--name', ARTIFACT, '--dir', dir, '--repo', process.env.GITHUB_REPOSITORY!]);
  const measured = JSON.parse(readFileSync(join(dir, 'bundle-sizes.json'), 'utf8')) as Measurement;
  return measured.commit === sha ? measured.sizes : undefined;
}

/** Builds `sha` in a worktree of its own: main's run for it was cancelled or skipped. */
function buildBase(sha: string): Sizes {
  const dir = join(process.env.RUNNER_TEMP ?? tmpdir(), `bundle-base-${sha.slice(0, 8)}`);
  run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', sha]);
  run(['git', 'worktree', 'add', '--detach', dir, sha]);
  run(['bun', 'install', '--frozen-lockfile'], dir);
  run(['bun', 'run', 'build:ui'], dir);
  run(['bun', 'run', 'build:core'], dir);
  return measure(dir);
}

/**
 * The commit a pull request's sizes are compared with. Its CI checks out the
 * merge ref, whose first parent is the main commit it was merged onto;
 * `pull_request.base.sha` stays at the branch point until the branch moves,
 * so main's growth since then was charged to the pull request. `headCommit`
 * is `git cat-file -p HEAD`, which a shallow checkout still holds.
 */
export function comparisonBase(headCommit: string, pullBase: string): string {
  const parents = [...headCommit.split('\n\n')[0]!.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]!);
  return parents.length === 2 ? parents[0]! : pullBase;
}

async function check(headFile: string) {
  const head = (JSON.parse(readFileSync(headFile, 'utf8')) as Measurement).sizes;
  const pullBase = process.env.BASE_SHA ?? '';
  if (!/^[0-9a-f]{40}$/.test(pullBase)) throw new Error(`BASE_SHA: "${pullBase}", expected the pull request's 40-character base commit`);
  const headCommit = Bun.spawnSync(['git', 'cat-file', '-p', 'HEAD'], { stderr: 'inherit' });
  if (headCommit.exitCode !== 0) throw new Error('git cat-file -p HEAD failed');
  const baseSha = comparisonBase(headCommit.stdout.toString(), pullBase);
  const short = (sha: string) => sha.slice(0, 8);

  const fromMain = await mainMeasurement(baseSha);
  const base: Reference = fromMain
    ? { sizes: fromMain, source: `\`${short(baseSha)}\` (main bundle-sizes artifact)` }
    : { sizes: buildBase(baseSha), source: `\`${short(baseSha)}\` (built here: main kept no measurement)` };

  const number = process.env.PR_NUMBER;
  const pull = number ? await api<{ body: string | null }>(`pulls/${number}`) : undefined;
  publish(judge(head, base, await publishedLimit(), bodyReason(pull?.body)));
}

/** The ceiling: the newest of the last ten published builds main measured, plus the headroom. */
async function publishedLimit(): Promise<Reference | undefined> {
  const releases = publishedCommits(await api<Parameters<typeof publishedCommits>[0]>('releases?per_page=20'));
  for (const release of releases.slice(0, 10)) {
    const sizes = await mainMeasurement(release.sha);
    if (sizes) return { sizes: ceiling(sizes), source: `${release.tag} at \`${release.sha.slice(0, 8)}\`` };
  }
  return undefined;
}

function publish(verdict: Verdict): void {
  console.log(verdict.report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Bundle size\n\n${verdict.report}\n`);
  if (verdict.errors.length) throw new Error(`Bundle size:\n${verdict.errors.join('\n')}`);
}

if (import.meta.main) {
  const [command, path] = process.argv.slice(2);
  if (command === 'measure' && path) {
    const sizes = measure();
    for (const key of MEASURES) console.log(`${key.padEnd(14)} ${bytes(sizes[key]).padStart(11)} bytes`);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ commit: process.env.GITHUB_SHA ?? '', sizes } satisfies Measurement, null, 2)}\n`);
  } else if (command === 'check' && path) {
    await check(path);
  } else if (command === 'ceiling' && path) {
    // Main against the published ceiling alone: the debt pull requests are not charged for.
    publish(judge((JSON.parse(readFileSync(path, 'utf8')) as Measurement).sizes, undefined, await publishedLimit(), undefined));
  } else {
    throw new Error('usage: bun scripts/ci/budgets.ts measure <out.json> | check <head.json> | ceiling <main.json>');
  }
}
