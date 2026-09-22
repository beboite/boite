import type { ThreadId } from '@boite/contracts';
import { refused } from '../errors.ts';

/** git answers 128 on anything it will not do here, a directory outside a repository first of all. */
export const OUTSIDE_A_REPOSITORY = 128;

export function notARepository(threadId: ThreadId, stderr: string): never {
  const detail = stderr.trim().split('\n')[0] ?? '';
  throw refused(
    `the working directory of thread ${threadId} is not inside a git repository${detail.length === 0 ? '' : `: ${detail}`}`,
    { threadId },
  );
}
