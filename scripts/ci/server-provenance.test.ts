import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { imageName, latestTags, stageProvenance, validateProvenance, verifyRelease } from './server-provenance';

const workflow = (name: string) => readFileSync(resolve(import.meta.dir, '../../.github/workflows', name), 'utf8');

test('stable publication promotes tested images without calling the image builder', () => {
  expect(workflow('publish-server.yml')).not.toContain('uses: ./.github/workflows/server.yml');
});

test('different stable release refs keep separate concurrency groups', () => {
  for (const file of ['release.yml', 'publish-server.yml']) {
    expect(workflow(file)).toMatch(/group: .*\$\{\{ github\.ref \}\}.*\$\{\{ github\.sha \}\}/);
  }
});

test('only latest promotion is serialized across release refs and rechecks freshness under that group', () => {
  const source = workflow('publish-server.yml');
  const latest = source.split('\n  latest:\n')[1] ?? '';
  const publish = source.split('\n  publish:\n')[1]?.split('\n  latest:\n')[0] ?? '';
  expect(latest).toContain('needs: [verified, publish]');
  expect(latest).toContain("if: needs.verified.outputs.prerelease == 'false'");
  expect(latest).toMatch(/concurrency:\s+group: publish-server-latest\s+cancel-in-progress: false/);
  expect(latest).not.toMatch(/group: .*github\.(ref|sha)/);
  expect(latest).toMatch(/permissions:\s+contents: read\s+packages: write/);
  expect(latest).not.toContain('actions: read');
  expect(latest).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/latest"');
  expect(latest).toContain('latest=$(bun scripts/ci/server-provenance.ts latest latest-release.json)');
  expect(latest.indexOf('releases/latest')).toBeLessThan(latest.indexOf('--tag "$image:latest"'));
  expect(publish).toContain('--tag "$image:$RELEASE_TAG"');
  expect(publish).not.toContain('--tag "$image:latest"');
  expect(publish).not.toContain('concurrency:');
});

test('ordinary server verification has no registry credentials or write permission', () => {
  const source = workflow('server-verify.yml');
  expect(source).not.toContain('packages: write');
  expect(source).not.toContain('secrets.GITHUB_TOKEN');
  expect(source).not.toContain('docker/login-action');
});

const expected = { repository: 'beboite/boite', tag: 'v2.0.0', sha: 'a'.repeat(40) };
const digests = {
  amd64: `${imageName(expected.repository)}@sha256:${'1'.repeat(64)}`,
  arm64: `${imageName(expected.repository)}@sha256:${'2'.repeat(64)}`,
};

function fixture() {
  const provenance = stageProvenance(expected, { id: 123, attempt: 2, ref: 'refs/tags/v2.0.0', event: 'push' }, { ...digests });
  const run = {
    id: 123, run_attempt: 2, path: '.github/workflows/release.yml',
    head_sha: expected.sha, head_branch: 'v2.0.0', event: 'push',
    repository: { full_name: expected.repository }, head_repository: { full_name: expected.repository },
    status: 'completed', conclusion: 'success',
  };
  const jobs = [
    'version', 'verify / CI required', 'image / test and stage server (amd64)',
    'image / test and stage server (arm64)', 'draft',
  ].map((name) => ({ name, run_id: 123, run_attempt: 2, head_sha: expected.sha, status: 'completed', conclusion: 'success' }));
  return { provenance, run, jobs, release: { tag_name: expected.tag, draft: false, prerelease: false }, tag: { sha: expected.sha } };
}

function verify(input: ReturnType<typeof fixture>) {
  return verifyRelease(input.provenance, expected, input.release, input.run, input.jobs, input.tag);
}

test('matching published release promotes both exact tested digests from its successful attempt', () => {
  expect(verify(fixture()).digests).toEqual(digests);
});

test('manual preparation on a branch is bound to that ref, version and commit', () => {
  const input = fixture();
  input.provenance = stageProvenance(expected, { id: 123, attempt: 2, ref: 'refs/heads/release/2.0', event: 'workflow_dispatch' }, digests);
  input.run.event = 'workflow_dispatch';
  input.run.head_branch = 'release/2.0';
  expect(verify(input).tag).toBe(expected.tag);
  input.run.head_branch = 'unrelated';
  expect(() => verify(input)).toThrow('run.head_branch: expected');
  expect(() => stageProvenance(expected, { id: 123, attempt: 2, ref: 'refs/tags/v2.0.1', event: 'workflow_dispatch' }, digests)).toThrow('ref: expected');
});

test.each([
  ['wrong SHA', { sha: 'b'.repeat(40) }, 'sha: expected'],
  ['wrong tag', { tag: 'v2.0.1' }, 'tag: expected'],
  ['wrong version', { version: '2.0.1' }, 'version: expected'],
  ['different repository', { repository: 'another/repo' }, 'repository: expected'],
  ['non-release workflow', { workflow: '.github/workflows/nightly.yml' }, 'workflow: expected'],
  ['unrelated ref', { ref: 'refs/tags/v2.0.1' }, 'ref: expected'],
  ['fork PR event', { event: 'pull_request' }, 'event: expected'],
  ['unintended telemetry build', { telemetry: false }, 'telemetry: expected'],
  ['nightly channel', { channel: 'dev' }, 'channel: expected'],
  ['invalid run ID', { runId: 0 }, 'runId: expected'],
  ['invalid attempt', { runAttempt: 1.5 }, 'runAttempt: expected'],
])('persisted metadata rejects %s', (_name, fields, message) => {
  expect(() => validateProvenance({ ...fixture().provenance, ...fields }, expected)).toThrow(message);
});

test.each([
  ['missing architecture', { amd64: digests.amd64 }, 'digests: expected exactly'],
  ['empty digest', { ...digests, arm64: '' }, 'digests.arm64: expected'],
  ['mutable tag', { ...digests, amd64: `${imageName(expected.repository)}:latest` }, 'digests.amd64: expected'],
  ['wrong registry image', { ...digests, amd64: `ghcr.io/another/repo@sha256:${'1'.repeat(64)}` }, 'digests.amd64: expected'],
  ['duplicate native image', { ...digests, arm64: digests.amd64 }, 'digests: expected two different'],
])('digest metadata rejects %s', (_name, invalid, message) => {
  expect(() => validateProvenance({ ...fixture().provenance, digests: invalid }, expected)).toThrow(message);
});

test.each([
  ['different tested run', { id: 456 }, 'run.id: expected'],
  ['different attempt', { run_attempt: 1 }, 'run.run_attempt: expected'],
  ['different commit', { head_sha: 'b'.repeat(40) }, 'run.head_sha: expected'],
  ['different tag', { head_branch: 'v2.0.1' }, 'run.head_branch: expected'],
  ['different workflow', { path: '.github/workflows/ci.yml' }, 'run.path: expected'],
  ['different event', { event: 'workflow_dispatch' }, 'run.event: expected'],
  ['incomplete run', { status: 'in_progress' }, 'run.status: expected'],
  ['failed run', { conclusion: 'failure' }, 'run.conclusion: expected'],
  ['fork run', { head_repository: { full_name: 'fork/boite' } }, 'run.head_repository: expected'],
])('a green run on the same source is insufficient when it has %s', (_name, fields, message) => {
  const input = fixture();
  Object.assign(input.run, fields);
  expect(() => verify(input)).toThrow(message);
});

test.each(['version', 'verify / CI required', 'image / test and stage server (amd64)', 'image / test and stage server (arm64)', 'draft'])('a successful run cannot hide skipped required job %s', (name) => {
  const input = fixture();
  input.jobs.find((job) => job.name === name)!.conclusion = 'skipped';
  expect(() => verify(input)).toThrow(`${name}.conclusion: expected success`);
});

test('missing, duplicate and unrelated-attempt jobs cannot prove verification', () => {
  const missing = fixture();
  missing.jobs.pop();
  expect(() => verify(missing)).toThrow('draft: expected exactly one job');
  const duplicate = fixture();
  duplicate.jobs.push({ ...duplicate.jobs[0]! });
  expect(() => verify(duplicate)).toThrow('version: expected exactly one job');
  const unrelated = fixture();
  unrelated.jobs[0]!.run_id = 456;
  expect(() => verify(unrelated)).toThrow('version.run_id: expected');
  const futureAttempt = fixture();
  futureAttempt.jobs[0]!.run_attempt = 3;
  expect(() => verify(futureAttempt)).toThrow('version: expected exactly one job');
});

test('partial reruns carry earlier successful jobs without accepting later or skipped executions', () => {
  const input = fixture();
  for (const job of input.jobs) if (job.name !== 'draft') job.run_attempt = 1;
  input.jobs.push({ ...input.jobs[0]!, run_attempt: 3, conclusion: 'failure' });
  expect(verify(input).digests).toEqual(digests);
  input.jobs.push({ ...input.jobs[0]!, run_attempt: 2, conclusion: 'skipped' });
  expect(() => verify(input)).toThrow('version.conclusion: expected success');
});

test('publication rejects a draft, unrelated release or retargeted version tag', () => {
  const draft = fixture();
  draft.release.draft = true;
  expect(() => verify(draft)).toThrow('release.draft: expected a published release');
  const unrelated = fixture();
  unrelated.release.tag_name = 'v2.0.1';
  expect(() => verify(unrelated)).toThrow('release.tag_name: expected');
  const retargeted = fixture();
  retargeted.tag.sha = 'b'.repeat(40);
  expect(() => verify(retargeted)).toThrow('tag commit.sha: expected');
});

test('only the current stable release can move latest, including an older release published later', () => {
  const current = { tag_name: 'v2.1.0', draft: false, prerelease: false };
  expect(latestTags('v2.0.0', current)).toEqual([]);
  expect(latestTags('v2.1.0', current)).toEqual(['latest']);
  expect(latestTags('v2.2.0-beta.1', current)).toEqual([]);
  expect(() => latestTags('v2.1.0', { ...current, prerelease: true })).toThrow('latest release.prerelease: expected false');
});

test('persisted release JSON is sufficient for CLI verification after digest artifacts expire', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'boite-server-provenance-'));
  try {
    const input = fixture();
    const digestDirectory = resolve(directory, 'digests');
    mkdirSync(digestDirectory);
    for (const [arch, digest] of Object.entries(digests)) writeFileSync(resolve(digestDirectory, arch), digest + '\n');
    for (const [name, value] of Object.entries(input)) {
      if (name !== 'provenance') writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(value));
    }
    const output = resolve(directory, 'outputs');
    const env = {
      GITHUB_REPOSITORY: expected.repository, RELEASE_TAG: expected.tag, GITHUB_SHA: expected.sha, GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_REF: 'refs/tags/v2.0.0', GITHUB_EVENT_NAME: 'push',
    };
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, resolve(import.meta.dir, 'server-provenance.ts'), ...args], {
      env, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    const staged = cli('stage', digestDirectory, resolve(directory, 'provenance.json'));
    expect(staged.stderr.toString()).toBe('');
    expect(staged.exitCode).toBe(0);
    rmSync(digestDirectory, { recursive: true });
    const inspected = cli('inspect', resolve(directory, 'provenance.json'));
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout.toString())).toEqual({ runId: 123, runAttempt: 2 });
    const result = cli('verify',
      ...['provenance', 'release', 'run', 'jobs', 'tag'].map((name) => resolve(directory, `${name}.json`)),
    );
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(`amd64=${digests.amd64}\narm64=${digests.arm64}\nprerelease=false\n`);
    expect(result.stdout.toString()).toContain('run 123 attempt 2');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
