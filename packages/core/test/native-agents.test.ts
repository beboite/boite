import { expect, test } from 'bun:test';
import { collectNativeAgents, collectProcessAgents, nativeAgentsOfTool, type MessagePart, type ProcessRecord } from '@boite/contracts';
import { toolViewOf } from '../src/drivers/codex/mapping.ts';

const tool = (patch: Partial<Extract<MessagePart, { type: 'tool' }>> = {}): Extract<MessagePart, { type: 'tool' }> => ({ type: 'tool', toolId: 'call-1', name: 'Task', input: { prompt: 'Review parsing' }, output: null, status: 'running', ...patch });
const processRecord = (patch: Partial<ProcessRecord> = {}): ProcessRecord => ({ threadId: 'thread', pid: 2, parentPid: 1, exe: 'claude.exe', commandLine: 'claude.exe --print --model opus --effort xhigh "Review"', startedAt: 2, exitedAt: null, exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null, ...patch });

test('traced Windows binaries and Linux Node launchers expose CLI metadata and their own exit status', () => {
  const shell = processRecord({ pid: 1, parentPid: 0, startedAt: 1, exe: 'bash', commandLine: 'bash review.sh' });
  const commands = [
    processRecord(),
    processRecord({ pid: 3, exe: '/usr/bin/node', commandLine: 'node /opt/node_modules/@openai/codex/bin/codex.js exec --model reviewer -c model_reasoning_effort="high" "Review"' }),
    processRecord({ pid: 4, exe: '/usr/bin/opencode', commandLine: 'opencode run -m provider/reviewer "Review"', exitedAt: 10, exitCode: 0 }),
    processRecord({ pid: 5, exe: '/usr/bin/node', commandLine: 'node /opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --print --model reviewer --thinking high "Review"', exitedAt: 10, exitCode: 1 }),
    processRecord({ pid: 6, exe: 'grok.exe', commandLine: 'grok.exe --prompt "Review"', exitedAt: 10, exitCode: null }),
    processRecord({ pid: 7, exe: '/usr/bin/node', commandLine: 'node --require /tmp/preload.js --import /tmp/init.mjs --conditions development /opt/node_modules/@openai/codex/bin/codex.js exec --model reviewer -c model_reasoning_effort="high" "Review"' }),
    processRecord({ pid: 8, exe: '/usr/bin/bun', commandLine: 'bun --preload /tmp/preload.js /opt/node_modules/@anthropic-ai/claude-code/cli.js --print --effort high "Review"' }),
  ];
  const agents = collectProcessAgents([shell, ...commands]);
  expect(agents.map(agent => [agent.name, agent.model, agent.effort, agent.status])).toEqual([
    ['Claude Code', 'opus', 'xhigh', 'running'], ['Codex', 'reviewer', 'high', 'running'],
    ['OpenCode', 'provider/reviewer', undefined, 'done'], ['pi', 'reviewer', 'high', 'error'], ['Grok', undefined, undefined, 'unknown'],
    ['Codex', 'reviewer', 'high', 'running'], ['Claude Code', undefined, 'high', 'running'],
  ]);
  expect(agents[2]?.finishedAt).toBe(10);
});

test('process agents exclude the parent provider, wrapper copies, version probes, command mentions and reused parent PIDs', () => {
  const root = processRecord({ pid: 1, parentPid: 0, startedAt: 1 });
  const shell = processRecord({ pid: 3, parentPid: 1, exe: 'pwsh.exe', commandLine: 'pwsh.exe review.ps1' });
  const child = processRecord({ pid: 4, parentPid: 3, startedAt: 3 });
  expect(collectProcessAgents([root, processRecord(), shell, child, processRecord({ pid: 5, parentPid: 3, commandLine: 'claude.exe --version' }), processRecord({ pid: 6, parentPid: 3, exe: 'rg', commandLine: 'rg "claude --print"' })])).toEqual([expect.objectContaining({ name: 'Claude Code', id: 'process:thread:4:3' })]);
  expect(collectProcessAgents([shell, child, processRecord({ ...shell, startedAt: 4 })])).toEqual([]);
  expect(collectProcessAgents([processRecord({ ...shell, exitedAt: 2 }), child])).toEqual([]);
  // A reused live pid must not confirm an older CLI invocation.
  expect(collectProcessAgents([root, shell, child], [{ ...child, startedAt: 4 }])[0]?.status).toBe('unknown');
});

test('task-list tools and ordinary tool output do not invent agents', () => {
  expect(nativeAgentsOfTool(tool({ input: { title: 'Review parsing', status: 'pending' } }))).toEqual([]);
  expect(nativeAgentsOfTool(tool({ name: 'Bash', output: 'spawn_agent completed' }))).toEqual([]);
});

test('background launches, grouped extension calls and interrupted turns never imply completed children', () => {
  expect(nativeAgentsOfTool(tool({ input: { prompt: 'Check', run_in_background: true }, status: 'done' }))[0]?.status).toBe('unknown');
  const grouped = nativeAgentsOfTool(tool({ name: 'subagent', input: { tasks: [{ agent: 'reviewer', task: 'Check' }, { agent: 'writer', task: 'Document' }] }, status: 'error' }));
  expect(grouped.map(agent => [agent.id, agent.status])).toEqual([['call-1:0', 'unknown'], ['call-1:1', 'unknown']]);
  expect(collectNativeAgents([{ part: tool(), at: 1, turnStatus: 'stopped' }])[0]?.status).toBe('unknown');
  expect(collectNativeAgents([{ part: tool(), at: 1, turnStatus: 'done' }])[0]?.status).toBe('unknown');
  expect(collectNativeAgents([{ part: tool({ nativeAgents: [{ id: 'background', status: 'running' }] }), at: 1, turnStatus: 'done' }])[0]?.status).toBe('unknown');
  expect(nativeAgentsOfTool(tool({ status: 'denied' }))[0]?.status).toBe('error');
});

test('Codex launch acknowledgement, missing states, mixed results and follow-ups preserve actual child state', () => {
  const spawned = toolViewOf({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['a', 'b'], prompt: 'Review', model: 'reviewer', agentsStates: { a: { status: 'running' } } })!;
  expect(spawned.nativeAgents?.map(a => a.status)).toEqual(['running', 'unknown']);
  const waited = toolViewOf({ id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', agentsStates: { a: { status: 'errored', message: 'Failed to read' }, b: { status: 'completed', message: 'Checked' }, c: { status: 'interrupted' }, d: { status: 'notFound' } } })!;
  const agents = collectNativeAgents([{ part: tool({ ...spawned }), at: 1 }, { part: tool({ ...waited, toolId: 'wait' }), at: 2 }]);
  expect(agents.map(a => a.status)).toEqual(['error', 'done', 'stopped', 'unknown']);
  expect(agents[0]).toMatchObject({ task: 'Review', model: 'reviewer', startedAt: 1, result: 'Failed to read' });
  expect(agents[1]?.result).toBe('Checked');
  const resumed = toolViewOf({ id: 'resume', type: 'collabAgentToolCall', tool: 'resumeAgent', status: 'completed', receiverThreadIds: ['a'], agentsStates: { a: { status: 'running' } } })!;
  expect(collectNativeAgents([{ part: tool({ ...waited }), at: 2 }, { part: tool({ ...resumed }), at: 3 }])[0]?.status).toBe('running');
});

test('native briefs and final results are bounded before being sent to Team', () => {
  const [agent] = nativeAgentsOfTool(tool({ input: { prompt: 'x'.repeat(5000) }, output: 'y'.repeat(5000), status: 'done' }));
  expect(agent?.task).toHaveLength(4000);
  expect(agent?.result).toHaveLength(4000);
});

test('a provider background-agent list confirms live work without duplicating its launch tool', () => {
  const part = tool({ input: { prompt: 'Review', run_in_background: true }, status: 'done' });
  const background = [{ id: 'task-1', toolId: part.toolId, kind: 'agent' as const, description: 'Review', startedAt: 2 }];
  const agents = collectNativeAgents([{ part, at: 1, turnStatus: 'done' }], background);
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ id: part.toolId, status: 'running' });
  expect(collectNativeAgents([{ part, at: 1, turnStatus: 'done' }], [])[0]?.status).toBe('unknown');
});

test('a grouped background launch stays separate from children whose live state is not reported', () => {
  const part = tool({ name: 'subagent', input: { tasks: [{ agent: 'reviewer', task: 'Check' }, { agent: 'writer', task: 'Document' }], run_in_background: true }, status: 'done' });
  const agents = collectNativeAgents([{ part, at: 1, turnId: 'group', turnStatus: 'done' }], [{ id: 'group-task', toolId: part.toolId, kind: 'agent', description: 'Review group', startedAt: 2 }]);
  expect(agents).toEqual([
    expect.objectContaining({ id: 'group:call-1:0', status: 'unknown', task: 'Check' }),
    expect.objectContaining({ id: 'group:call-1:1', status: 'unknown', task: 'Document' }),
    expect.objectContaining({ id: 'group-task', status: 'running', name: 'Review group' }),
  ]);
});

test('reused tool IDs retain separate child invocations across turns and the background list follows its original launch', () => {
  const first = tool({ input: { prompt: 'First review', run_in_background: true }, status: 'done', output: 'Launched' });
  const second = tool({ input: { prompt: 'Second review' }, status: 'done', output: 'Second result' });
  const entries = [{ part: first, at: 1, turnId: 'first', turnStatus: 'done' as const }, { part: second, at: 3, turnId: 'second', turnStatus: 'done' as const }];
  const agents = collectNativeAgents(entries, [{ id: 'task-1', toolId: first.toolId, kind: 'agent', description: 'First review', startedAt: 2 }]);
  expect(agents).toHaveLength(2);
  expect(agents.map(agent => [agent.task, agent.status, agent.result])).toEqual([['First review', 'running', undefined], ['Second review', 'done', 'Second result']]);
  expect(new Set(agents.map(agent => agent.id)).size).toBe(2);
  const later = collectNativeAgents(entries, [{ id: 'task-2', toolId: second.toolId, kind: 'agent', description: 'Second review', startedAt: 4 }]);
  expect(later.map(agent => [agent.task, agent.status])).toEqual([['First review', 'unknown'], ['Second review', 'running']]);
  const nativeEntries = [
    { part: tool({ nativeAgents: [{ id: 'stable-provider-id', status: 'running' }] }), at: 1, turnId: 'first' },
    { part: tool({ nativeAgents: [{ id: 'stable-provider-id', status: 'done', result: 'Checked' }] }), at: 3, turnId: 'second' },
  ];
  expect(collectNativeAgents(nativeEntries)).toEqual([expect.objectContaining({ id: 'stable-provider-id', status: 'done', result: 'Checked' })]);
});
