import { appendFileSync } from 'node:fs';

// Unknown files run the complete suite. Documentation-only PRs still get the
// required job, so branch protection never waits for a filtered-out workflow.
export function affectedChecks(files: string[]) {
  const checks = { core: false, web: false, desktop: false, shellRust: false, server: false, android: false, androidServer: false, telemetry: false, e2eTypes: false, stress: false };
  for (const file of files) {
    if (
      /^(docs\/.*\.md|README\.md|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md|LICENSE)$/.test(file) ||
      /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$|topics\.json$|CODEOWNERS$|labeler\.yml$)/.test(file) ||
      file === '.coderabbit.yaml'
    ) continue;
    if (file.startsWith('apps/android/') || file === '.github/workflows/android.yml' || file === 'scripts/ci/android-apk.ts') {
      // The wrapper loads the UI from the core, so nothing else goes into the APK.
      // Boite Server's pipeline counts its version with the same script.
      checks.android = true;
      if (file === 'scripts/ci/android-apk.ts') checks.androidServer = true;
    } else if (file.startsWith('apps/android-server/termux/')) {
      // The release bundle: the core suite packs it, the web job type-checks
      // it and the Linux x64 desktop job builds it. The changes job always
      // runs its tests.
      checks.core = checks.web = checks.desktop = true;
    } else if (file.startsWith('apps/android-server/') || file === '.github/workflows/android-server.yml' || file === 'scripts/ci/android-server-apk.ts') {
      // Boite Server's APK drives the core through Termux and reads nothing from it.
      checks.androidServer = true;
    } else if (file.startsWith('apps/shell/')) {
      checks.desktop = checks.shellRust = true;
    } else if (/^packages\/(core|contracts)\//.test(file)) {
      // The shell's Rust tests compile apps/shell/src-tauri and start inline
      // fake cores, never this code. The APK build reads APP_ORIGIN from the
      // contracts and nothing from the core.
      checks.core = checks.web = checks.desktop = checks.server = checks.telemetry = checks.e2eTypes = checks.stress = true;
      if (file.startsWith('packages/contracts/')) checks.android = true;
    } else if (file.startsWith('tests/e2e/')) {
      checks.desktop = checks.e2eTypes = true;
      // Stress fixtures use the same isolated core and browser harness.
      if (file.startsWith('tests/e2e/lib/')) checks.stress = true;
    } else if (/^(Dockerfile$|\.dockerignore$|docker\/)/.test(file)) {
      checks.server = true;
    } else if (file.startsWith('packages/ui/')) {
      checks.web = checks.desktop = checks.server = checks.stress = true;
      // browser.rs embeds these two page scripts with include_str!.
      if (/^packages\/ui\/src\/lib\/preview-(picker|highlight)\.js$/.test(file)) checks.shellRust = true;
    } else if (file.startsWith('telemetry/')) {
      checks.web = checks.telemetry = true;
    } else if (/^(tests\/stress\/|bench\/agent-stress\.ts$|bench\/lib\/)/.test(file)) {
      checks.web = checks.stress = true;
    } else if (/^(bench\/|scripts\/architecture\/)/.test(file)) {
      // The web job type-checks these; the changes job tests architecture scripts.
      checks.web = true;
    } else {
      // Dependencies, shared builds and unknown inputs stay safe.
      checks.core = checks.web = checks.desktop = checks.shellRust = checks.server = checks.android = checks.androidServer = checks.telemetry = checks.e2eTypes = checks.stress = true;
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

/** Protection and shared inputs need the actual Windows boundary, including on drafts. */
export function needsNativeWindows(files: string[]): boolean {
  return files.some((file) => /^packages\/core\/(src\/(platform\/|execution-|drivers\/(?:[^/]+\/)?protected[^/]*\.ts$|contacts\/native-execution\.ts$)|bin\/install-windows-sandbox\.ts$|test\/protected)/.test(file)
    || ['package.json', 'bun.lock', '.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'scripts/ci/changes.ts', 'scripts/ci/changes.test.ts'].includes(file))
    || Object.values(affectedChecks(files)).every(Boolean);
}

// Linux builds on the oldest runner that carries WebKitGTK 4.1: its glibc (2.35)
// is the floor for every Linux user a published package can serve. Intel macOS
// is cross-built on Apple Silicon and smoke-tested under Rosetta: the Intel
// runner took 14 minutes where Apple Silicon took 8 (nightly 37234148865).
export type Platform = { id: string; name: string; runner: string; target?: string };
const LINUX_X64: Platform = { id: 'linux-x64', name: 'Linux x64', runner: 'ubuntu-22.04' };
const LINUX_ARM64: Platform = { id: 'linux-arm64', name: 'Linux arm64', runner: 'ubuntu-22.04-arm' };
const MACOS_ARM64: Platform = { id: 'macos-arm64', name: 'macOS arm64', runner: 'macos-15' };
const MACOS_X64: Platform = { id: 'macos-x64', name: 'macOS x64', runner: 'macos-15', target: 'x86_64-apple-darwin' };
const PORTABLE_PR = [LINUX_X64, MACOS_ARM64];
export const PORTABLE_ALL = [LINUX_X64, LINUX_ARM64, MACOS_ARM64, MACOS_X64];

// The core suite still needs a real Intel Mac, a scarce runner: 322 to 409 s a
// PR on 2026-10-17. Pull requests skip it like the Intel desktop leg; main
// pushes, releases and manual runs keep it.
export type CoreRunner = { os: string; name: string };
const CORE_PR: CoreRunner[] = [
  { os: 'ubuntu-24.04', name: 'Linux x64' },
  { os: 'ubuntu-24.04-arm', name: 'Linux arm64' },
  { os: 'windows-2025', name: 'Windows x64' },
  { os: 'macos-15', name: 'macOS arm64' },
];
export const CORE_ALL: CoreRunner[] = [...CORE_PR, { os: 'macos-15-intel', name: 'macOS x64' }];

// `pr` gates a merge, in the pull request and again in the merge queue, `warm`
// follows it on main, `full` is a release or a manual run. Main runs the extra
// portable architectures, the Intel Mac core suite, and refreshes caches.
// `draft` normally runs the Linux checks; protection inputs add native Windows.
// Marking it ready runs `pr` (docs/ci.md#draft-pull-requests).
// A push event alone provides no proof that its tree passed PR tests, so every
// mode runs the affected suites. A main push compares with the last main commit
// whose CI passed, not the previous push: a cancelled or failed run's changes
// are tested again, so a green main commit has every suite passing on some tree
// that its later changes did not affect. The nightly publishes on that alone.
export type Mode = 'draft' | 'pr' | 'warm' | 'full';

export function ciMode(event: string, force: boolean, draft = false): Mode {
  if (force) return 'full';
  if (event === 'pull_request') return draft ? 'draft' : 'pr';
  if (event === 'merge_group') return 'pr';
  if (event === 'push') return 'warm';
  return 'full';
}

// A draft keeps the Linux core suite, type checks, UI tests and focused checks;
// Protection inputs also select Windows core/native tests; macOS, desktop
// packages, E2E, stress, Docker and the APKs wait for the ready pull request.
const CORE_DRAFT: CoreRunner[] = CORE_PR.slice(0, 1);

export function plan(checks: ReturnType<typeof affectedChecks>, mode: Mode, nativeWindows = false) {
  if (mode === 'draft') {
    const draft = plan({ ...checks, desktop: false, server: false, android: false, androidServer: false, stress: false }, 'pr', nativeWindows);
    const runners = nativeWindows ? CORE_PR.filter((runner) => runner.os === 'ubuntu-24.04' || runner.os === 'windows-2025') : CORE_DRAFT;
    return { ...draft, coreRunners: JSON.stringify(runners) };
  }
  return {
    ...checks,
    nativeWindows,
    // Full suites already cover these focused checks.
    telemetry: checks.telemetry && !checks.core,
    e2eTypes: checks.e2eTypes && !checks.web,
    e2e: checks.desktop,
    portable: JSON.stringify(mode === 'pr' ? PORTABLE_PR : PORTABLE_ALL),
    coreRunners: JSON.stringify(mode === 'pr' ? CORE_PR : CORE_ALL),
  };
}

type Run = { head_sha: string };

/** The newest main commit whose CI passed, other than `head` and older than it. */
export function lastGreen(runs: Run[], head: string, isAncestor: (sha: string) => boolean): string | undefined {
  return runs.find((run) => run.head_sha !== head && isAncestor(run.head_sha))?.head_sha;
}

async function mainBase(head: string): Promise<string | undefined> {
  const { GITHUB_API_URL: api = 'https://api.github.com', GITHUB_REPOSITORY: repo, GH_TOKEN: token } = process.env;
  if (!repo || !token) return undefined;
  try {
    const response = await fetch(`${api}/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=50`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    const { workflow_runs: runs } = await response.json() as { workflow_runs: Run[] };
    const isAncestor = (sha: string) => /^[a-f0-9]{40}$/.test(sha) &&
      Bun.spawnSync(['git', 'merge-base', '--is-ancestor', sha, head], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
    return lastGreen(runs, head, isAncestor);
  } catch (error) {
    console.warn(`::warning::no passing main commit to compare with (${error instanceof Error ? error.message : String(error)}); running every check`);
    return undefined;
  }
}

if (import.meta.main) {
  const force = process.env.FORCE_CHECKS === 'true';
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim();
  const mainPush = process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main';
  const base = force ? undefined : mainPush ? await mainBase(head) : process.env.BASE_SHA;
  if (mainPush && base) console.log(`Comparing with ${base}, the last main commit whose CI passed`);
  let checks = affectedChecks(['unknown']);
  let workflows = true;
  let nativeWindows = true;
  if (!force && base && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    // A move between packages affects both its old and new runtime.
    const diff = Bun.spawnSync(['git', 'diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    if (diff.exitCode !== 0) throw new Error(diff.stderr.toString());
    const files = diff.stdout.toString().split('\0').filter(Boolean);
    checks = affectedChecks(files);
    workflows = needsWorkflowLint(files);
    nativeWindows = needsNativeWindows(files);
  }
  const mode = ciMode(process.env.GITHUB_EVENT_NAME ?? '', force, process.env.DRAFT === 'true');
  const output = Object.entries({ ...plan(checks, mode, nativeWindows), workflows, mode }).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
