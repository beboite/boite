import type { GitChangeStatus, GitStatus } from '@boite/contracts';

/** `## main...origin/main [ahead 1, behind 2]`, and the three shapes that are not that. */
export function parseBranchHeader(header: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> {
  const rest = header.startsWith('## ') ? header.slice(3) : header;
  const tracking = /\s\[(.+)\]$/.exec(rest);
  const names = tracking === null ? rest : rest.slice(0, rest.length - tracking[0].length);
  const ahead = Number(/ahead (\d+)/.exec(tracking?.[1] ?? '')?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(tracking?.[1] ?? '')?.[1] ?? 0);
  // A repository with no commit yet names its branch in a sentence, and a
  // detached HEAD names no branch at all.
  const fresh = /^No commits yet on (.+)$/.exec(names);
  if (fresh !== null) return { branch: fresh[1] ?? null, upstream: null, ahead, behind };
  if (names.startsWith('HEAD (no branch)')) return { branch: null, upstream: null, ahead, behind };
  const [branch, upstream] = names.split('...');
  return { branch: branch === undefined || branch.length === 0 ? null : branch, upstream: upstream ?? null, ahead, behind };
}

function changeStatusOf(index: string, tree: string): GitChangeStatus {
  if (index === '?' && tree === '?') return 'untracked';
  if (index === 'U' || tree === 'U' || (index === 'A' && tree === 'A') || (index === 'D' && tree === 'D')) return 'conflict';
  const code = index !== ' ' && index !== '?' ? index : tree;
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  return 'modified';
}

/**
 * `git status --porcelain=v1 -z --branch`. Every record ends with a NUL, and a
 * rename carries its origin as the record right after it, the new path first:
 * that is what `-z` changes about the format, and why the arrow is gone.
 */
export function parseStatus(raw: string): GitStatus {
  const records = raw.split('\0').filter((record) => record.length > 0);
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, changes: [] };
  let at = 0;
  if (records[0]?.startsWith('##') === true) {
    Object.assign(status, parseBranchHeader(records[0]));
    at = 1;
  }
  while (at < records.length) {
    const record = records[at] as string;
    at += 1;
    if (record.length < 4) continue;
    const index = record[0] as string;
    const tree = record[1] as string;
    const path = record.slice(3);
    const renamed = index === 'R' || index === 'C' || tree === 'R' || tree === 'C';
    const oldPath = renamed ? (records[at] ?? null) : null;
    if (renamed) at += 1;
    status.changes.push({
      path,
      status: changeStatusOf(index, tree),
      oldPath,
      staged: index !== ' ' && index !== '?',
      additions: null,
      deletions: null,
    });
  }
  return status;
}

/**
 * `git diff --numstat -z`: `added<TAB>deleted<TAB>path`, and for a rename the
 * path field is empty and the two paths follow as their own records. A binary
 * file counts as `-`, which is the null the contract asks for.
 */
export function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const fields = raw.split('\0');
  const out = new Map<string, { additions: number | null; deletions: number | null }>();
  let at = 0;
  while (at < fields.length) {
    const field = fields[at] as string;
    at += 1;
    if (field.length === 0) continue;
    const parsed = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (parsed === null) continue;
    const additions = parsed[1] === '-' ? null : Number(parsed[1]);
    const deletions = parsed[2] === '-' ? null : Number(parsed[2]);
    let path = parsed[3] ?? '';
    if (path.length === 0) {
      // A rename: the origin, then the destination, each its own record.
      path = fields[at + 1] ?? '';
      at += 2;
    }
    if (path.length > 0) out.set(path, { additions, deletions });
  }
  return out;
}
