import { expect, test } from 'bun:test';
import { collectNativeAgents, nativeAgentsOfTool, type MessagePart } from '@boite/contracts';
import { toolViewOf } from '../src/drivers/codex/mapping.ts';

const tool = (patch: Partial<Extract<MessagePart, { type: 'tool' }>> = {}): Extract<MessagePart, { type: 'tool' }> => ({ type: 'tool', toolId: 'call-1', name: 'Task', input: { prompt: 'Review parsing' }, output: null, status: 'running', ...patch });

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
