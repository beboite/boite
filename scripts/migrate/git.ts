import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { status: run.status ?? 1, stdout: run.stdout };
}

/** A file at a commit, or undefined when the commit does not have it. */
export function show(cwd: string, ref: string, path: string): string | undefined {
  const run = git(cwd, ['show', `${ref}:${path}`]);
  return run.status === 0 ? run.stdout : undefined;
}

export const exists = (cwd: string, ref: string, path: string) => git(cwd, ['cat-file', '-e', `${ref}:${path}`]).status === 0;

/** `git merge-file` of the branch's text over main's, markers labelled like `git merge` labels them. */
export function mergeFile(ours: string, base: string, theirs: string): { text: string; conflict: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-merge-'));
  try {
    const paths = ['ours', 'base', 'theirs'].map((name) => join(dir, name));
    [ours, base, theirs].forEach((text, i) => writeFileSync(paths[i], text));
    const run = spawnSync('git', ['merge-file', '-p', '-L', 'HEAD', '-L', 'merge base', '-L', 'main', ...paths], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (run.status === null || run.status < 0) throw new Error(`git merge-file failed: ${run.stderr}`);
    return { text: run.stdout, conflict: run.status !== 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The two sides of the merge the migration replays: mid-merge, HEAD is the
 * branch and MERGE_HEAD main; after the merge commit, its two parents.
 */
export function mergeSides(cwd: string): { ours: string; theirs: string; merging: boolean } | undefined {
  if (git(cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']).status === 0) return { ours: 'HEAD', theirs: 'MERGE_HEAD', merging: true };
  if (git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^2']).status === 0) return { ours: 'HEAD^1', theirs: 'HEAD^2', merging: false };
  return undefined;
}
