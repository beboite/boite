import { expect, test } from 'bun:test';
import { affectedChecks, ciMode, lastGreen, needsCodeChecks, needsNativeWindows, needsWorkflowLint, plan } from './changes.ts';

const none = { core: false, web: false, desktop: false, shellRust: false, server: false, android: false, androidServer: false, telemetry: false, e2eTypes: false, stress: false };
const allChecks = { core: true, web: true, desktop: true, shellRust: true, server: true, android: true, androidServer: true, telemetry: true, e2eTypes: true, stress: true };

test('checks follow runtime boundaries and combine changed paths', () => {
  expect(affectedChecks(['apps/shell/src-tauri/src/main.rs'])).toEqual({ ...none, desktop: true, shellRust: true });
  expect(affectedChecks(['Dockerfile'])).toEqual({ ...none, server: true });
  expect(affectedChecks(['packages/ui/src/app.css'])).toEqual({ ...none, web: true, desktop: true, server: true, stress: true });
  expect(affectedChecks(['packages/core/src/main.ts'])).toEqual({ ...allChecks, shellRust: false, android: false, androidServer: false });
  expect(affectedChecks(['tests/e2e/ui.test.ts', 'docker/compose.yml'])).toEqual({ ...none, desktop: true, server: true, e2eTypes: true });
});

test('the shell Rust tests run only for the inputs they compile', () => {
  // browser.rs embeds two page scripts; the rest of the UI, the core and the contracts never reach the crate.
  for (const file of ['apps/shell/src-tauri/src/lib.rs', 'apps/shell/src-tauri/Cargo.lock', 'packages/ui/src/lib/preview-picker.js', 'packages/ui/src/lib/preview-highlight.js', '.cargo/config.toml', 'package.json', 'bun.lock']) {
    expect(affectedChecks([file]).shellRust).toBe(true);
  }
  for (const file of ['packages/core/src/main.ts', 'packages/contracts/src/index.ts', 'packages/ui/src/App.svelte', 'packages/ui/src/lib/attention.ts', 'tests/e2e/shell.test.ts', 'Dockerfile']) {
    const checks = affectedChecks([file]);
    expect(checks.shellRust).toBe(false);
    // The desktop builds and their smoke tests still run where the file reaches them.
    if (file.startsWith('packages/')) expect(checks.desktop).toBe(true);
  }
  expect(affectedChecks(['packages/core/src/main.ts', 'apps/shell/src-tauri/src/lib.rs']).shellRust).toBe(true);
  for (const mode of ['pr', 'queue', 'warm', 'full'] as const) {
    expect(plan(affectedChecks(['packages/core/src/main.ts']), mode).shellRust).toBe(false);
    expect(plan(affectedChecks(['unknown']), mode).shellRust).toBe(true);
  }
});

test('the APK follows the contracts it reads, not the core', () => {
  expect(affectedChecks(['packages/core/src/main.ts']).android).toBe(false);
  expect(affectedChecks(['packages/contracts/src/index.ts']).android).toBe(true);
});

test('only the wrapper and its own pipeline build the APK', () => {
  for (const file of ['apps/android/app/build.gradle', '.github/workflows/android.yml']) {
    expect(affectedChecks([file])).toEqual({ ...none, android: true });
  }
  // Boite Server counts its version with the same script.
  expect(affectedChecks(['scripts/ci/android-apk.ts'])).toEqual({ ...none, android: true, androidServer: true });
});

test('Boite Server builds its APK for the app and the bundle checks for its Termux scripts', () => {
  for (const file of ['apps/android-server/app/src/main/java/com/boite/server/App.kt', 'apps/android-server/VERSION', '.github/workflows/android-server.yml', 'scripts/ci/android-server-apk.ts']) {
    expect(affectedChecks([file])).toEqual({ ...none, androidServer: true });
  }
  // The release bundle carries termux/, not the APK.
  expect(affectedChecks(['apps/android-server/termux/boite-server.ts'])).toEqual({ ...none, core: true, web: true, desktop: true });
});

test('ordinary benches and architecture scripts keep the cheap type-check route', () => {
  for (const file of ['bench/retitle.ts', 'scripts/architecture/check.ts']) {
    expect(affectedChecks([file])).toEqual({ ...none, web: true });
  }
  expect(affectedChecks(['bench/retitle.ts', 'packages/core/src/main.ts'])).toEqual({ ...allChecks, shellRust: false, android: false, androidServer: false });
});

test('telemetry-only changes require behavioral relay coverage on PRs and main', () => {
  for (const file of ['telemetry/src/index.ts', 'telemetry/wrangler.toml']) {
    const checks = affectedChecks([file]);
    expect(checks).toEqual({ ...none, web: true, telemetry: true });
    for (const mode of ['pr', 'queue', 'warm', 'full'] as const) expect(plan(checks, mode).telemetry).toBe(true);
  }
});

test('E2E-only changes require focused type checking without UI unit tests', () => {
  for (const file of ['tests/e2e/ui.test.ts', 'tests/e2e/lib/core.ts', 'tests/e2e/tsconfig.json']) {
    expect(plan(affectedChecks([file]), 'queue')).toMatchObject({ desktop: true, e2e: true, e2eTypes: true, web: false });
  }
});

test('stress fixtures and their bench helpers require the bounded stress suite', () => {
  for (const file of ['tests/stress/drivers.test.ts', 'tests/stress/lib/protocol-load.ts', 'bench/agent-stress.ts', 'bench/lib/health.ts']) {
    expect(affectedChecks([file])).toEqual({ ...none, web: true, stress: true });
  }
  for (const mode of ['queue', 'warm', 'full'] as const) {
    expect(plan(affectedChecks(['packages/core/src/scheduler.ts']), mode).stress).toBe(true);
  }
  expect(affectedChecks(['packages/ui/src/App.svelte'])).toEqual({ ...none, web: true, desktop: true, server: true, stress: true });
  expect(affectedChecks(['tests/e2e/lib/core.ts'])).toEqual({ ...none, desktop: true, e2eTypes: true, stress: true });
});

test('shared inputs and unknown files fail open to every check', () => {
  for (const file of ['bun.lock', 'package.json', '.github/workflows/ci.yml', 'new-config.json']) {
    expect(Object.values(affectedChecks([file])).every(Boolean)).toBe(true);
  }
  expect(affectedChecks(['packages/contracts/src/index.ts'])).toEqual({ ...allChecks, shellRust: false, androidServer: false });
  expect(Object.values(affectedChecks(['README.md', '.coderabbit.yaml'])).some(Boolean)).toBe(false);
});

test('docs-only changes keep the cheap check path', () => {
  expect(needsCodeChecks(['README.md', 'docs/server.md', 'LICENSE'])).toBe(false);
  expect(needsCodeChecks(['SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/CODEOWNERS', '.github/labeler.yml'])).toBe(false);
});

test('workflow lint follows workflows, local actions and their decision scripts', () => {
  expect(needsWorkflowLint(['README.md'])).toBe(false);
  for (const path of ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'scripts/ci/changes.ts']) {
    expect(needsWorkflowLint([path])).toBe(true);
  }
});

test('native Windows proof follows protection code and shared toolchain inputs', () => {
  for (const file of ['packages/core/src/platform/windows/protected-tool.c', 'packages/core/src/platform/protected-checkout.ts', 'packages/core/src/execution-policy.ts', 'packages/core/src/drivers/muse/protected.ts', 'packages/core/src/drivers/protected-bridge.ts', 'packages/core/src/contacts/native-execution.ts', 'packages/core/bin/install-windows-sandbox.ts', 'packages/core/test/protected-windows.test.ts', 'bun.lock', 'package.json', '.github/workflows/ci.yml', 'scripts/ci/changes.ts', 'new-config.json']) {
    expect(needsNativeWindows([file]), file).toBe(true);
    const pr = plan(affectedChecks([file]), 'pr', needsNativeWindows([file]));
    expect(pr.nativeWindows).toBe(true);
    expect(JSON.parse(pr.coreRunners).map((runner: { os: string }) => runner.os)).toEqual(['ubuntu-24.04', 'windows-2025']);
    expect(pr.desktop).toBe(false);
  }
  for (const file of ['docs/ci.md', 'packages/ui/src/App.svelte', 'packages/core/src/cli.ts', 'Dockerfile']) {
    expect(needsNativeWindows([file]), file).toBe(false);
    expect(plan(affectedChecks([file]), 'pr', needsNativeWindows([file])).coreRunners).toBe(plan(affectedChecks([file]), 'pr').coreRunners);
  }
  for (const mode of ['queue', 'warm', 'full'] as const) {
    expect(plan(allChecks, mode, true).nativeWindows).toBe(true);
  }
});

test('runtime, build inputs and unknown files require the complete suite', () => {
  for (const path of ['packages/core/src/main.ts', 'bun.lock', 'Dockerfile', '.github/workflows/ci.yml', 'new-config.json', 'docs/example.ts']) {
    expect(needsCodeChecks(['README.md', path])).toBe(true);
  }
});

test('pull requests, main pushes and forced runs pick their mode', () => {
  // Draft or ready, a pull request runs the same plan.
  expect(ciMode('pull_request', false)).toBe('pr');
  expect(ciMode('pull_request', true)).toBe('full');
  // A merge group compares with its main base and runs the full matrix.
  expect(ciMode('merge_group', false)).toBe('queue');
  expect(ciMode('push', false)).toBe('warm');
  expect(ciMode('push', true)).toBe('full');
  expect(ciMode('workflow_dispatch', false)).toBe('full');
  expect(ciMode('schedule', false)).toBe('full');
});

test('main pushes run affected tests while warming the extra portable architectures', () => {
  const all = affectedChecks(['packages/core/src/main.ts']);
  const queue = plan(all, 'queue');
  expect(queue).toMatchObject({ core: true, web: true, desktop: true, server: true, e2e: true });
  const runners = (portable: string) => JSON.parse(portable).map((platform: { runner: string; target?: string }) => platform.target ?? platform.runner);
  expect(runners(queue.portable)).toEqual(['ubuntu-22.04', 'macos-15']);
  const warm = plan(all, 'warm');
  expect(warm).toMatchObject({ core: true, web: true, desktop: true, server: true, e2e: true, stress: true });
  // Intel macOS is cross-built on Apple Silicon: no portable leg waits for an Intel runner.
  expect(runners(warm.portable)).toEqual(['ubuntu-22.04', 'ubuntu-22.04-arm', 'macos-15', 'x86_64-apple-darwin']);
  expect(JSON.parse(warm.portable).map((platform: { runner: string }) => platform.runner)).not.toContain('macos-15-intel');
  const full = plan(all, 'full');
  expect(full).toMatchObject({ core: true, e2e: true });
  expect(JSON.parse(full.portable)).toHaveLength(4);
  expect(plan(affectedChecks(['README.md']), 'warm')).toMatchObject({ ...none, e2e: false });
});

test('a pull request runs only the Linux checks and leaves the rest to the merge queue', () => {
  const all = affectedChecks(['packages/core/src/main.ts']);
  const pr = plan(all, 'pr');
  expect(pr).toMatchObject({ core: true, web: true, desktop: false, e2e: false, server: false, android: false, androidServer: false, stress: false });
  expect(JSON.parse(pr.coreRunners)).toEqual([{ os: 'ubuntu-24.04', name: 'Linux x64' }]);
  // Bundle size still measures a desktop change: the queue skips it.
  expect(pr.size).toBe(true);
  expect(plan(affectedChecks(['telemetry/src/index.ts']), 'pr').size).toBe(false);
  // Focused checks still stand in for absent full suites.
  expect(plan(affectedChecks(['tests/e2e/ui.test.ts']), 'pr')).toMatchObject({ e2eTypes: true, desktop: false, e2e: false, size: true });
  expect(plan(affectedChecks(['telemetry/src/index.ts']), 'pr')).toMatchObject({ web: true, telemetry: true });
  expect(plan(affectedChecks(['README.md']), 'pr')).toMatchObject({ ...none, e2e: false, size: false });
});

test('the merge queue runs every check the changes select, on every pull request platform', () => {
  const queue = plan(affectedChecks(['unknown']), 'queue', true);
  expect(queue).toMatchObject({ ...allChecks, telemetry: false, e2eTypes: false, e2e: true, nativeWindows: true });
  expect(JSON.parse(queue.coreRunners).map((runner: { os: string }) => runner.os)).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2025', 'macos-15']);
  expect(JSON.parse(queue.portable)).toHaveLength(2);
});

test('the merge queue runs the core suite without the Intel Mac; main, releases and manual runs keep it', () => {
  const all = affectedChecks(['packages/core/src/main.ts']);
  const runners = (mode: 'queue' | 'warm' | 'full') => JSON.parse(plan(all, mode).coreRunners).map((runner: { os: string }) => runner.os);
  expect(runners('queue')).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2025', 'macos-15']);
  for (const mode of ['warm', 'full'] as const) expect(runners(mode)).toEqual([...runners('queue'), 'macos-15-intel']);
  // ci.yml names each core job after its runner: `Core tests (macOS x64)`.
  expect(JSON.parse(plan(all, 'full').coreRunners).map((runner: { name: string }) => runner.name))
    .toEqual(['Linux x64', 'Linux arm64', 'Windows x64', 'macOS arm64', 'macOS x64']);
});

test('a main push compares with the last main commit whose CI passed, skipping cancelled and failed runs', () => {
  const head = 'h'.repeat(40);
  const [green, older] = ['g', 'o'].map((letter) => letter.repeat(40));
  // The API lists only passing runs, newest first: a cancelled or failed push is absent, so its changes stay in the diff.
  const ancestors = new Set([green, older]);
  expect(lastGreen([{ head_sha: green }, { head_sha: older }], head, (sha) => ancestors.has(sha))).toBe(green);
  // A rerun of the head's own passing run, or a newer commit's run, is no base.
  expect(lastGreen([{ head_sha: head }, { head_sha: 'n'.repeat(40) }, { head_sha: older }], head, (sha) => ancestors.has(sha))).toBe(older);
  expect(lastGreen([], head, () => true)).toBeUndefined();
});

test('focused checks are covered by the full core and web jobs when both apply', () => {
  expect(plan(affectedChecks(['telemetry/src/index.ts', 'packages/core/src/main.ts']), 'warm'))
    .toMatchObject({ core: true, telemetry: false, web: true, e2eTypes: false });
});
