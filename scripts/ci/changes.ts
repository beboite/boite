import { appendFileSync } from 'node:fs';

// Unknown files run the complete suite. Documentation-only PRs still get the
// required job, so branch protection never waits for a filtered-out workflow.
export function affectedChecks(files: string[]) {
  const checks = { core: false, web: false, desktop: false, server: false };
  for (const file of files) {
    if (
      /^(docs\/.*\.md|README\.md|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md|LICENSE)$/.test(file) ||
      /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$|topics\.json$|CODEOWNERS$|labeler\.yml$)/.test(file) ||
      file === '.coderabbit.yaml'
    ) continue;
    if (/^(apps\/shell\/|tests\/e2e\/)/.test(file)) {
      checks.desktop = true;
    } else if (/^(Dockerfile$|\.dockerignore$|docker\/)/.test(file)) {
      checks.server = true;
    } else if (file.startsWith('packages/ui/')) {
      checks.web = checks.desktop = checks.server = true;
    } else {
      // Core and contracts are used by both clients; unknown inputs stay safe.
      checks.core = checks.web = checks.desktop = checks.server = true;
    }
  }
  return checks;
}

export function needsCodeChecks(files: string[]): boolean {
  return Object.values(affectedChecks(files)).some(Boolean);
}

export function needsWorkflowLint(files: string[]): boolean {
  return files.some((file) => /^\.github\/(workflows|actions)\//.test(file) || file.startsWith('scripts/ci/'));
}

const PORTABLE_PR = ['ubuntu-24.04', 'macos-15'];
const PORTABLE_ALL = ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel'];

// `pr` gates a merge, `warm` follows it on main, `full` is a release, a nightly
// or a manual run. A pull request skips the slow extra architectures; the main
// push that follows runs them, refreshes the caches every pull request restores
// and skips the suites the pull request already passed.
export type Mode = 'pr' | 'warm' | 'full';

export function ciMode(event: string, force: boolean): Mode {
  if (force) return 'full';
  if (event === 'pull_request') return 'pr';
  if (event === 'push') return 'warm';
  return 'full';
}

export function plan(checks: ReturnType<typeof affectedChecks>, mode: Mode) {
  return {
    ...checks,
    core: checks.core && mode !== 'warm',
    e2e: mode !== 'warm',
    portable: JSON.stringify(mode === 'pr' ? PORTABLE_PR : PORTABLE_ALL),
  };
}

if (import.meta.main) {
  const base = process.env.BASE_SHA;
  const force = process.env.FORCE_CHECKS === 'true';
  let checks = affectedChecks(['unknown']);
  let workflows = true;
  if (!force && base && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    // A move between packages affects both its old and new runtime.
    const diff = Bun.spawnSync(['git', 'diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    if (diff.exitCode !== 0) throw new Error(diff.stderr.toString());
    const files = diff.stdout.toString().split('\0').filter(Boolean);
    checks = affectedChecks(files);
    workflows = needsWorkflowLint(files);
  }
  const mode = ciMode(process.env.GITHUB_EVENT_NAME ?? '', force);
  const output = Object.entries({ ...plan(checks, mode), workflows, mode }).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
