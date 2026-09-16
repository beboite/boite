import { appendFileSync } from 'node:fs';

// Unknown files run the complete suite. Documentation-only PRs still get the
// required job, so branch protection never waits for a filtered-out workflow.
export function affectedChecks(files: string[]) {
  const checks = { core: false, web: false, desktop: false, server: false };
  for (const file of files) {
    if (
      /^(docs\/.*\.md|README\.md|AGENTS\.md|CONTRIBUTING\.md|LICENSE)$/.test(file) ||
      /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$|topics\.json$)/.test(file) || file === '.coderabbit.yaml'
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

if (import.meta.main) {
  const base = process.env.BASE_SHA;
  let checks = affectedChecks(['unknown']);
  let workflows = true;
  if (process.env.FORCE_CHECKS !== 'true' && base && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    // A move between packages affects both its old and new runtime.
    const diff = Bun.spawnSync(['git', 'diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    if (diff.exitCode !== 0) throw new Error(diff.stderr.toString());
    const files = diff.stdout.toString().split('\0').filter(Boolean);
    checks = affectedChecks(files);
    workflows = needsWorkflowLint(files);
  }
  const output = Object.entries({ ...checks, workflows }).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
