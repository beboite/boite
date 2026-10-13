import type { ProviderDescriptor, ThreadSummary } from '@boite/contracts';

/**
 * A Claude Haiku conversation another conversation delegated, through
 * `boite delegate spawn` or a workflow step. Such a child does one small job
 * from a brief that says everything it needs, in a compaction window the owner
 * may keep small. The user's memory files, MCP servers, the brain and Boite
 * guides and Claude Code's optional tools would take a third of that window
 * before the brief is read, so a light child starts without them.
 */
export function isLightChild(
  thread: Pick<ThreadSummary, 'parentThreadId' | 'model'>,
  provider: Pick<ProviderDescriptor, 'protocol'>,
): boolean {
  return Boolean(thread.parentThreadId) && provider.protocol === 'claude-sdk' && /haiku/i.test(thread.model ?? '');
}

/** Set to `1` in a light child's environment, so the user's own hooks can leave their context out too. */
export const LIGHT_CHILD_ENV = 'BOITE_LIGHT';
