import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SHAPE_BLOCK_MAX, RpcErrorCode } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { claudeProjectFolder } from '../src/imports/claude.ts';
import { LINE_MAX, readRequestShape, summarizeShape, transcriptShape } from '../src/imports/claude-shape.ts';
import { claudeSessionFixture, FIXTURE_SESSION_ID } from './fixtures/claude-session.ts';
import { echoThread, startTestCore, testProject, type TestCore } from './harness.ts';

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

function shapeRecord(hash: string, system: string[], tools: { name: string; description: string }[]) {
  return line({
    type: 'api-request-shape', sessionId: 's', shapeHash: hash, timestamp: '2026-10-15T08:00:00.000Z', version: '2.1.300',
    shape: { system: system.map(text => ({ type: 'text', text })), tools: tools.map(tool => ({ ...tool, input_schema: { type: 'object', properties: {} } })) },
  });
}

function requestRecord(hash: string, at: string, effort: string) {
  return line({
    type: 'api-request', sessionId: 's', id: at, timestamp: at, version: '2.1.300', querySource: 'sdk', shapeHash: hash,
    params: { model: 'claude-test-1', betas: ['beta-one', 'beta-two'], max_tokens: 64000, thinking: { type: 'enabled', budget_tokens: 2048 }, output_config: { effort } },
  });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-shape-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('the last request is paired with the shape its hash names, across chunk boundaries and past oversized lines', async () => {
  const file = join(dir, 's.jsonl');
  const filler = line({ type: 'user', message: { role: 'user', content: 'x'.repeat(4000) } });
  writeFileSync(file, shapeRecord('old', ['Old prompt'], [{ name: 'Old', description: 'gone' }]));
  appendFileSync(file, shapeRecord('current', ['First block', 'Second block\nwith two lines'], [
    { name: 'Small', description: 'a' }, { name: 'Large', description: 'b'.repeat(500) },
  ]));
  // Two megabytes of conversation between the shape and its request: the read crosses chunks.
  appendFileSync(file, filler.repeat(520));
  appendFileSync(file, requestRecord('old', '2026-10-15T08:01:00.000Z', 'low'));
  appendFileSync(file, requestRecord('current', '2026-10-15T08:02:00.000Z', 'high'));
  // A body that only mentions the record type is decoded and set aside.
  appendFileSync(file, line({ type: 'user', message: { role: 'user', content: 'what is "type":"api-request" here?' } }));
  // A line longer than the bound, holding the marker, is skipped without being kept whole.
  appendFileSync(file, `{"type":"api-request","params":{"model":"never","pad":"${'y'.repeat(LINE_MAX + 10)}"}}\n`);
  // One that spans more chunks than the bound is dropped before its head is reached.
  appendFileSync(file, `{"type":"api-request","params":{"model":"never","pad":"${'w'.repeat(LINE_MAX + (3 << 20))}"}}\n`);
  const records = await readRequestShape(file);
  expect(records.request?.['timestamp']).toBe('2026-10-15T08:02:00.000Z');
  expect(records.shape?.['shapeHash']).toBe('current');
  const shape = summarizeShape(records);
  expect(shape).toMatchObject({
    status: 'ready', version: '2.1.300', model: 'claude-test-1', effort: 'high', thinking: 'enabled 2048',
    betas: ['beta-one', 'beta-two'], maxTokens: 64000, at: Date.parse('2026-10-15T08:02:00.000Z'),
  });
  expect(shape.system.map(block => block.text)).toEqual(['First block', 'Second block\nwith two lines']);
  expect(shape.tools.map(tool => tool.name)).toEqual(['Large', 'Small']);
  expect(shape.tools[0]!.descriptionChars).toBe(500);
  expect(shape.chars.tools).toBe(shape.tools.reduce((sum, tool) => sum + tool.chars, 0));
  expect(shape.estimatedTokens).toBe(Math.ceil((shape.chars.system + shape.chars.tools) / 4));
});

test('a shape written after its request still counts, and a long block is cut and says so', async () => {
  const file = join(dir, 's.jsonl');
  const long = 'z'.repeat(AGENT_SHAPE_BLOCK_MAX + 100);
  writeFileSync(file, requestRecord('h', '2026-10-15T08:00:00.000Z', 'medium') + shapeRecord('h', [long], []));
  const shape = await transcriptShape(file);
  expect(shape?.system[0]).toEqual({ chars: long.length, text: long.slice(0, AGENT_SHAPE_BLOCK_MAX), truncated: true });
  expect(shape?.chars.system).toBe(long.length);
});

test('a transcript from an older CLI is unrecorded, and a missing one is null', async () => {
  const file = join(dir, 's.jsonl');
  writeFileSync(file, line({ type: 'user', message: { role: 'user', content: 'hello' } }) + line({ type: 'assistant', message: { content: [] } }));
  expect((await transcriptShape(file))?.status).toBe('unrecorded');
  expect(await transcriptShape(join(dir, 'absent.jsonl'))).toBeNull();
});

let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

test('threads.agentShape reads the Claude thread transcript, refuses other providers by field and stays the owner\'s', async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  const project = await testProject(harness, client);
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'shape' });
  if (account.isolationDir === null) throw new Error('the account must be isolated');
  const folder = join(account.isolationDir, 'projects', claudeProjectFolder(project.path));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${FIXTURE_SESSION_ID}.jsonl`);
  writeFileSync(file, claudeSessionFixture(project.path));
  const thread = await client.call('imports.run', { projectId: project.id, accountId: account.id, sessionId: FIXTURE_SESSION_ID });

  // The fixture's CLI predates request shapes.
  expect(await client.call('threads.agentShape', { threadId: thread.id })).toMatchObject({ threadId: thread.id, sessionId: FIXTURE_SESSION_ID, status: 'unrecorded', system: [], tools: [] });
  appendFileSync(file, shapeRecord('h', ['You are a test agent.'], [{ name: 'Read', description: 'Reads a file.' }]) + requestRecord('h', '2026-10-15T09:00:00.000Z', 'xhigh'));
  expect(await client.call('threads.agentShape', { threadId: thread.id })).toMatchObject({
    status: 'ready', effort: 'xhigh', system: [{ text: 'You are a test agent.', truncated: false }], tools: [{ name: 'Read', descriptionChars: 13 }],
  });

  rmSync(file);
  expect((await client.call('threads.agentShape', { threadId: thread.id })).status).toBe('no-transcript');

  const echo = await echoThread(harness, client);
  expect(await client.call('threads.agentShape', { threadId: echo.threadId }).catch(error => error)).toMatchObject({
    rpc: { code: RpcErrorCode.Refused, data: { field: 'providerId', expected: 'a provider on the claude-sdk protocol' } },
  });

  const { grant } = await client.call('pairing.grant', {});
  const session = harness.core.sessions.exchange(grant, { name: 'phone', version: 'test' });
  const device = await connect(harness.url, session.token);
  try {
    expect(await device.call('threads.agentShape', { threadId: thread.id }).catch(error => error)).toMatchObject({
      rpc: { code: RpcErrorCode.Refused, message: 'threads.agentShape is for the owner only' },
    });
  } finally { device.close(); }
});
