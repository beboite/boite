/*
 * A Claude Code transcript the way the CLI writes one: two prompts, a tool
 * call answered by a `tool_result`, a thinking block, a sidechain the import
 * leaves out, an `ai-title` record when asked for one. Shared by the core
 * test and the browser e2e.
 */

export const FIXTURE_SESSION_ID = '0f3a9c2e-1111-4bbb-8ccc-0123456789ab';

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

export function claudeSessionFixture(cwd: string, options: { aiTitle?: string; sessionId?: string } = {}): string {
  const sessionId = options.sessionId ?? FIXTURE_SESSION_ID;
  const base = { isSidechain: false, cwd, sessionId, version: '2.1.266', gitBranch: 'main', userType: 'external' };
  const records: Record<string, unknown>[] = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-10T08:00:00.000Z', sessionId },
    {
      ...base,
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-09-10T08:00:01.000Z',
      message: { role: 'user', content: 'List the files of this folder, then say hello' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: '2026-09-10T08:00:03.000Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'thinking', thinking: 'A directory listing first.', signature: 'sig' }],
      },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'a1',
      timestamp: '2026-09-10T08:00:04.000Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    },
    {
      ...base,
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a2',
      timestamp: '2026-09-10T08:00:05.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\npackage.json' }] },
      toolUseResult: { stdout: 'README.md\npackage.json' },
    },
    // A subagent's records: the same file, another conversation, not the user's.
    {
      ...base,
      isSidechain: true,
      type: 'user',
      uuid: 's1',
      parentUuid: null,
      timestamp: '2026-09-10T08:00:05.500Z',
      message: { role: 'user', content: 'Explore the repository' },
    },
    {
      ...base,
      isSidechain: true,
      type: 'assistant',
      uuid: 's2',
      parentUuid: 's1',
      timestamp: '2026-09-10T08:00:05.600Z',
      message: { id: 'msg_s', role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'Explored.' }] },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a3',
      parentUuid: 'u2',
      timestamp: '2026-09-10T08:00:06.000Z',
      message: { id: 'msg_2', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Two files. ' }] },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a4',
      parentUuid: 'a3',
      timestamp: '2026-09-10T08:00:06.500Z',
      message: { id: 'msg_2', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Hello.' }] },
    },
    {
      ...base,
      type: 'user',
      uuid: 'u3',
      parentUuid: 'a4',
      timestamp: '2026-09-10T08:01:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Thanks, bye' }] },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a5',
      parentUuid: 'u3',
      timestamp: '2026-09-10T08:01:02.000Z',
      message: { id: 'msg_3', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Bye.' }] },
    },
    { type: 'last-prompt', lastPrompt: 'Thanks, bye', sessionId },
  ];
  if (options.aiTitle !== undefined) records.push({ type: 'ai-title', aiTitle: options.aiTitle, sessionId });
  return `${records.map(line).join('\n')}\n`;
}
