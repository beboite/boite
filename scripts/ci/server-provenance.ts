import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ReleaseIdentity = { repository: string; tag: string; sha: string };
export type ServerProvenance = ReleaseIdentity & {
  schema: 1;
  version: string;
  channel: 'stable';
  telemetry: true;
  workflow: '.github/workflows/release.yml';
  runId: number;
  runAttempt: number;
  ref: string;
  event: 'push' | 'workflow_dispatch';
  digests: { amd64: string; arm64: string };
};

const REQUIRED_JOBS = [
  'version',
  'verify / CI required',
  'image / test and stage server (amd64)',
  'image / test and stage server (arm64)',
  'draft',
];

function object(value: unknown, field: string): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${field}: expected an object`);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, `${field}: expected a positive integer`);
  return value;
}

export function imageName(repository: string): string {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'repository: expected owner/repository');
  return `ghcr.io/${repository.toLowerCase()}/boite-server`;
}

/** Release assets persist after Actions artifacts expire. This JSON is unsigned. */
export function validateProvenance(value: unknown, expected: ReleaseIdentity): ServerProvenance {
  assert(/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(expected.tag) && !expected.tag.includes('-nightly.'), 'tag: expected a non-nightly version tag');
  assert(/^[a-f0-9]{40}$/.test(expected.sha), 'sha: expected a full commit SHA');
  const proof = object(value, 'server-images.json');
  for (const field of ['repository', 'tag', 'sha'] as const) {
    assert.equal(proof[field], expected[field], `${field}: expected ${expected[field]}`);
  }
  assert.equal(proof.schema, 1, 'schema: expected 1');
  assert.equal(proof.version, expected.tag.slice(1), 'version: expected the release tag version');
  assert.equal(proof.workflow, '.github/workflows/release.yml', 'workflow: expected release.yml');
  assert.equal(proof.channel, 'stable', 'channel: expected stable');
  assert.equal(proof.telemetry, true, 'telemetry: expected release-intended images');
  positiveInteger(proof.runId, 'runId');
  positiveInteger(proof.runAttempt, 'runAttempt');
  const tagRef = `refs/tags/${expected.tag}`;
  assert(proof.event === 'push' || proof.event === 'workflow_dispatch', 'event: expected push or workflow_dispatch');
  const branchDispatch = proof.event === 'workflow_dispatch' && typeof proof.ref === 'string'
    && proof.ref.startsWith('refs/heads/') && proof.ref.length > 'refs/heads/'.length && !/[\r\n\0]/.test(proof.ref);
  assert(proof.ref === tagRef || branchDispatch, 'ref: expected the release tag, or a branch for manual preparation');
  const digests = object(proof.digests, 'digests');
  assert.deepEqual(Object.keys(digests).sort(), ['amd64', 'arm64'], 'digests: expected exactly amd64 and arm64');
  const prefix = `${imageName(expected.repository)}@`;
  for (const arch of ['amd64', 'arm64']) {
    const digest = digests[arch];
    assert(typeof digest === 'string' && digest.startsWith(prefix) && /^sha256:[a-f0-9]{64}$/.test(digest.slice(prefix.length)), `digests.${arch}: expected ${prefix}sha256:<64 lowercase hex digits>`);
  }
  assert.notEqual(digests.amd64, digests.arm64, 'digests: expected two different native images');
  return proof as ServerProvenance;
}

export function stageProvenance(expected: ReleaseIdentity, run: { id: number; attempt: number; ref: string; event: string }, digests: ServerProvenance['digests']): ServerProvenance {
  return validateProvenance({
    ...expected, schema: 1, version: expected.tag.slice(1), channel: 'stable', telemetry: true,
    workflow: '.github/workflows/release.yml', runId: run.id, runAttempt: run.attempt,
    ref: run.ref, event: run.event, digests,
  }, expected);
}

/** Check a specific successful attempt, never any green run sharing its commit. */
export function verifyRelease(provenance: unknown, expected: ReleaseIdentity, releaseValue: unknown, runValue: unknown, jobsValue: unknown, tagValue: unknown): ServerProvenance {
  const proof = validateProvenance(provenance, expected);
  const release = object(releaseValue, 'release');
  assert.equal(release.tag_name, expected.tag, 'release.tag_name: expected the release tag');
  assert.equal(release.draft, false, 'release.draft: expected a published release');
  assert.equal(release.prerelease, expected.tag.includes('-'), 'release.prerelease: expected the version channel');
  const tag = object(tagValue, 'tag commit');
  assert.equal(tag.sha, expected.sha, 'tag commit.sha: expected the verified release commit');
  const run = object(runValue, 'run');
  assert.equal(run.id, proof.runId, 'run.id: expected the tested run');
  assert.equal(run.run_attempt, proof.runAttempt, 'run.run_attempt: expected the tested attempt');
  assert.equal(run.path, proof.workflow, 'run.path: expected release.yml');
  assert.equal(run.head_sha, expected.sha, 'run.head_sha: expected the release commit');
  assert.equal(run.head_branch, proof.ref.replace(/^refs\/(heads|tags)\//, ''), 'run.head_branch: expected the preparation ref');
  assert.equal(run.event, proof.event, 'run.event: expected the preparation event');
  assert.equal(object(run.repository, 'run.repository').full_name, expected.repository, 'run.repository: expected the release repository');
  assert.equal(object(run.head_repository, 'run.head_repository').full_name, expected.repository, 'run.head_repository: expected the release repository');
  assert.equal(run.status, 'completed', 'run.status: expected completed');
  assert.equal(run.conclusion, 'success', 'run.conclusion: expected success');
  assert(Array.isArray(jobsValue), 'jobs: expected the jobs from the tested attempt');
  const jobs = jobsValue.map((value) => object(value, 'job'));
  for (const name of REQUIRED_JOBS) {
    // A partial rerun carries successful jobs from earlier attempts. Select
    // the latest execution at or before the attempt that prepared this draft.
    const eligible = jobs.filter((job) => job.name === name && typeof job.run_attempt === 'number' && job.run_attempt <= proof.runAttempt);
    const attempt = Math.max(...eligible.map((job) => positiveInteger(job.run_attempt, `${name}.run_attempt`)));
    const matches = eligible.filter((job) => job.run_attempt === attempt);
    assert.equal(matches.length, 1, `${name}: expected exactly one job in the tested attempt`);
    const job = matches[0]!;
    assert.equal(job.run_id, proof.runId, `${name}.run_id: expected the tested run`);
    assert.equal(job.head_sha, expected.sha, `${name}.head_sha: expected the release commit`);
    assert.equal(job.status, 'completed', `${name}.status: expected completed`);
    assert.equal(job.conclusion, 'success', `${name}.conclusion: expected success, never skipped`);
  }
  return proof;
}

/** Evaluate GitHub's current stable release immediately before moving latest. */
export function latestTags(tag: string, currentValue: unknown): string[] {
  const current = object(currentValue, 'latest release');
  assert.equal(current.draft, false, 'latest release.draft: expected false');
  assert.equal(current.prerelease, false, 'latest release.prerelease: expected false');
  assert(typeof current.tag_name === 'string', 'latest release.tag_name: expected a tag');
  return current.tag_name === tag && !tag.includes('-') ? ['latest'] : [];
}

function environmentIdentity(): ReleaseIdentity {
  return { repository: process.env.GITHUB_REPOSITORY ?? '', tag: process.env.RELEASE_TAG ?? '', sha: process.env.GITHUB_SHA ?? '' };
}

function readJson(path: string | undefined): unknown {
  assert(path, 'argument: expected a JSON file path');
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (import.meta.main) {
  const [command, ...paths] = process.argv.slice(2);
  const expected = environmentIdentity();
  if (command === 'stage') {
    const [directory, output] = paths;
    assert(directory && output, 'stage: expected DIGEST_DIRECTORY OUTPUT_JSON');
    const proof = stageProvenance(expected, {
      id: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      ref: process.env.GITHUB_REF ?? '', event: process.env.GITHUB_EVENT_NAME ?? '',
    }, { amd64: readFileSync(join(directory, 'amd64'), 'utf8').trim(), arm64: readFileSync(join(directory, 'arm64'), 'utf8').trim() });
    writeFileSync(output, JSON.stringify(proof, null, 2) + '\n');
  } else if (command === 'inspect') {
    const proof = validateProvenance(readJson(paths[0]), expected);
    console.log(JSON.stringify({ runId: proof.runId, runAttempt: proof.runAttempt }));
  } else if (command === 'verify') {
    const proof = verifyRelease(readJson(paths[0]), expected, readJson(paths[1]), readJson(paths[2]), readJson(paths[3]), readJson(paths[4]));
    assert(process.env.GITHUB_OUTPUT, 'verify: expected GITHUB_OUTPUT');
    appendFileSync(process.env.GITHUB_OUTPUT, `amd64=${proof.digests.amd64}\narm64=${proof.digests.arm64}\nprerelease=${proof.tag.includes('-')}\n`);
    console.log(`Verified tested server digests: ${proof.tag}, ${proof.sha}, run ${proof.runId} attempt ${proof.runAttempt}`);
  } else if (command === 'latest') {
    console.log(latestTags(expected.tag, readJson(paths[0])).join('\n'));
  } else {
    throw new Error('command: expected stage, inspect, verify or latest');
  }
}
