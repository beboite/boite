import { appendFileSync } from 'node:fs';

// Unknown files run the complete suite. Documentation-only PRs still get the
// required job, so branch protection never waits for a filtered-out workflow.
export function needsCodeChecks(files: string[]): boolean {
  return files.some((file) => !(
    /^(docs\/.*\.md|README\.md|AGENTS\.md|CONTRIBUTING\.md|LICENSE)$/.test(file) ||
    /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$|topics\.json$)/.test(file)
  ));
}

export function needsWorkflowLint(files: string[]): boolean {
  return files.some((file) => /^\.github\/(workflows|actions)\//.test(file) || file.startsWith('scripts/ci/'));
}

if (import.meta.main) {
  const base = process.env.BASE_SHA;
  let code = true;
  let workflows = true;
  if (process.env.FORCE_CHECKS !== 'true' && base && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    const diff = Bun.spawnSync(['git', 'diff', '--name-only', '-z', base, 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    if (diff.exitCode !== 0) throw new Error(diff.stderr.toString());
    const files = diff.stdout.toString().split('\0').filter(Boolean);
    code = needsCodeChecks(files);
    workflows = needsWorkflowLint(files);
  }
  const output = `code=${code}\nworkflows=${workflows}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
