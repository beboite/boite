import type { GitChange, GitDiff, RpcParams } from '@boite/contracts';
import { DIFF_MAX_BYTES } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { hasNul, resolveInside, threadCwd } from '../workdir.ts';
import { notARepository, OUTSIDE_A_REPOSITORY } from './errors.ts';
import { parseStatus } from './porcelain.ts';
import { git, readRefSide, readTreeSide, SIDE_CEILING_BYTES } from './read.ts';

function checkRef(ref: string): string {
  if (typeof ref !== 'string' || ref.length === 0) throw refused('git.diff ref must be a revision', { ref: String(ref) });
  if (ref.startsWith('-') || /[\s\0:]/.test(ref)) throw refused(`git.diff refuses the ref ${ref}`, { ref });
  return ref;
}

function cut(data: Uint8Array): { text: string; truncated: boolean } {
  const truncated = data.length > DIFF_MAX_BYTES;
  return { text: new TextDecoder().decode(truncated ? data.subarray(0, DIFF_MAX_BYTES) : data), truncated };
}

export async function gitDiff(core: Core, params: RpcParams<'git.diff'>): Promise<GitDiff> {
  const threadId = params.threadId;
  const cwd = threadCwd(core, threadId);
  const found = resolveInside(cwd, params.path, 'git.diff path');
  const ref = checkRef(params.ref === undefined || params.ref.length === 0 ? 'HEAD' : params.ref);
  // Read the whole status so a rename retains its origin.
  const status = await git(core, threadId, cwd, ['status', '--porcelain=v1', '-z']);
  if (status.code === OUTSIDE_A_REPOSITORY) notARepository(threadId, status.stderr);
  const change = parseStatus(status.stdout).changes.find((entry) => entry.path === found.relative) ?? null;
  // Status paths are root-relative; an unchanged path is relative to cwd.
  const atRef = change?.oldPath ?? change?.path ?? `./${found.relative}`;
  const oldSide = await readRefSide(core, threadId, cwd, ref, atRef);
  const newSide = await readTreeSide(found.absolute);
  if (oldSide.tooBig || newSide.tooBig) {
    throw refused(
      `git.diff will not read ${params.path}: it is over ${SIDE_CEILING_BYTES / (1024 * 1024)} MB on one side`,
      { path: params.path, ref, ceilingBytes: SIDE_CEILING_BYTES },
    );
  }
  const old = oldSide.data;
  const current = newSide.data;
  if (old === null && current === null) {
    throw refused(`git.diff has no file to read at ${params.path}, in the working tree or at ${ref}`, { path: params.path, ref });
  }

  return renderDiff(found.relative, change, old, current);
}

function renderDiff(path: string, change: GitChange | null, old: Uint8Array | null, current: Uint8Array | null): GitDiff {
  const binary = (old !== null && hasNul(old)) || (current !== null && hasNul(current));
  const oldSide = old === null || binary ? null : cut(old);
  const newSide = current === null || binary ? null : cut(current);
  return {
    path,
    oldPath: change?.oldPath ?? null,
    status: change?.status ?? (old === null ? 'added' : current === null ? 'deleted' : 'modified'),
    oldText: oldSide?.text ?? null,
    newText: newSide?.text ?? null,
    binary,
    truncated: (oldSide?.truncated ?? false) || (newSide?.truncated ?? false),
  };
}
