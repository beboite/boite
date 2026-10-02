import { appendFileSync } from 'node:fs';

// Unknown files run the complete suite. Documentation-only PRs still get the
// required job, so branch protection never waits for a filtered-out workflow.
export function affectedChecks(files: string[]) {
  const checks = { core: false, web: false, desktop: false, server: false, android: false, telemetry: false, e2eTypes: false, stress: false };
  for (const file of files) {
    if (
      /^(docs\/.*\.md|README\.md|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md|LICENSE)$/.test(file) ||
      /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$|topics\.json$|CODEOWNERS$|labeler\.yml$)/.test(file) ||
      file === '.coderabbit.yaml'
    ) continue;
    if (file.startsWith('apps/android/') || file === '.github/workflows/android.yml' || file === 'scripts/ci/android-apk.ts') {
      // The wrapper loads the UI from the core, so nothing else goes into the APK.
      checks.android = true;
    } else if (file.startsWith('apps/shell/')) {
      checks.desktop = true;
    } else if (file.startsWith('tests/e2e/')) {
      checks.desktop = checks.e2eTypes = true;
      // Stress fixtures use the same isolated core and browser harness.
      if (file.startsWith('tests/e2e/lib/')) checks.stress = true;
    } else if (/^(Dockerfile$|\.dockerignore$|docker\/)/.test(file)) {
      checks.server = true;
    } else if (file.startsWith('packages/ui/')) {
      checks.web = checks.desktop = checks.server = checks.stress = true;
    } else if (file.startsWith('telemetry/')) {
      checks.web = checks.telemetry = true;
    } else if (/^(tests\/stress\/|bench\/agent-stress\.ts$|bench\/lib\/)/.test(file)) {
      checks.web = checks.stress = true;
    } else if (/^(bench\/|scripts\/architecture\/)/.test(file)) {
      // The web job type-checks these; the changes job tests architecture scripts.
      checks.web = true;
    } else {
      // Core and contracts are used by both clients; unknown inputs stay safe.
      checks.core = checks.web = checks.desktop = checks.server = checks.android = checks.telemetry = checks.e2eTypes = checks.stress = true;
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

// Linux builds on the oldest runner that carries WebKitGTK 4.1: its glibc (2.35)
// is the floor for every Linux user a published package can serve.
const PORTABLE_PR = ['ubuntu-22.04', 'macos-15'];
const PORTABLE_ALL = ['ubuntu-22.04', 'ubuntu-22.04-arm', 'macos-15', 'macos-15-intel'];

// `pr` gates a merge, `warm` follows it on main, `full` is a release, a nightly
// or a manual run. Main runs the extra portable architectures and refreshes
// caches. A push event alone provides no proof that its tree passed PR tests,
// so every mode runs the affected suites.
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
    // Full suites already cover these focused checks.
    telemetry: checks.telemetry && !checks.core,
    e2eTypes: checks.e2eTypes && !checks.web,
    e2e: checks.desktop,
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
