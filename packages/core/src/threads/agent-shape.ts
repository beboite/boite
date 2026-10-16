import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentShape, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { claudeProjectFolder } from '../imports/claude.ts';
import { transcriptShape } from '../imports/claude-shape.ts';

const EMPTY = {
  version: null, at: null, model: null, effort: null, thinking: null, betas: [], maxTokens: null,
  system: [], tools: [], omitted: { system: 0, tools: 0 }, chars: { system: 0, tools: 0 }, estimatedTokens: 0,
} satisfies Omit<AgentShape, 'threadId' | 'sessionId' | 'status'>;

/**
 * Reads the thread's current Claude transcript on request, from the account's
 * config directory as `imports.list` finds it. Nothing is cached in the
 * journal and nothing starts an agent.
 */
export async function agentShape(core: Core, threadId: ThreadId): Promise<AgentShape> {
  const thread = core.threads.require(threadId);
  const provider = core.providers.get(thread.providerId);
  if (provider?.protocol !== 'claude-sdk') {
    throw refused(`threads.agentShape reads Claude Code transcripts; this thread runs ${thread.providerId}`, {
      threadId, field: 'providerId', expected: 'a provider on the claude-sdk protocol',
    });
  }
  const sessionId = thread.sessionId;
  if (sessionId === null) return { threadId, sessionId, status: 'no-session', ...EMPTY };
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw refused('the thread session id is not a Claude Code session id', { threadId, field: 'sessionId', expected: 'letters, digits, - and _' });
  }
  const account = core.accounts.list().find((item) => item.id === thread.accountId);
  const dir = account === undefined ? core.accounts.defaultLocation(provider) : account.isolationDir ?? core.accounts.defaultLocation(provider);
  if (dir === null) return { threadId, sessionId, status: 'no-transcript', ...EMPTY };
  // The CLI files a session under the folder it was started in, which may be the resolved one.
  const folders = new Set([thread.cwd, await realpath(thread.cwd).catch(() => thread.cwd)]);
  for (const folder of folders) {
    const shape = await transcriptShape(join(dir, 'projects', claudeProjectFolder(folder), `${sessionId}.jsonl`));
    if (shape !== null) return { threadId, sessionId, ...shape };
  }
  return { threadId, sessionId, status: 'no-transcript', ...EMPTY };
}
