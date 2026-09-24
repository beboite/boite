import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, ATTACHMENT_MAX_BYTES } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
let client: CoreClient;
let agent: CoreClient;
let threadId: string;
beforeEach(async () => {
  harness = await startTestCore(); client = await harness.connect();
  ({ threadId } = await echoThread(harness, client));
  agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
  await client.call('turns.start', { threadId, prompt: 'Prepare a deliverable' });
  await waitFor(() => harness.core.threads.require(threadId).status === 'idle');
});
afterEach(async () => { agent?.close(); await harness?.stop(); });

test('agent CLI publishes immutable PDF bytes and subscribed clients receive the card', async () => {
  await client.call('threads.subscribe', { threadId });
  const path = join(harness.dataDir, 'report with spaces.pdf');
  const data = Buffer.from('%PDF-1.4\nreport\0bytes');
  writeFileSync(path, data);
  let output = '', error = '';
  const code = await runCli(['attach', path, '--json'], {
    cwd: harness.dataDir, env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
    out: text => output += text, err: text => error += text,
  });
  expect(error).toBe(''); expect(code).toBe(0);
  const sent = JSON.parse(output);
  expect(sent.role).toBe('assistant');
  expect(sent.parts[0]).toEqual({ type: 'file', name: 'report with spaces.pdf', mimeType: 'application/pdf', data: data.toString('base64') });
  rmSync(path);
  const history = await client.call('threads.get', { threadId });
  expect(history.messages.find(m => m.id === sent.id)?.parts).toEqual(sent.parts);
});

test('refuses unrelated threads, outside paths, missing files, directories and oversized data', async () => {
  const other = await echoThread(harness, client, 'another thread');
  await expect(agent.call('artifacts.publish', { threadId: other.threadId, path: 'report.pdf' })).rejects.toThrow('is for thread');
  for (const [path, reason] of [['../outside.pdf', 'leaves'], ['missing.pdf', 'does not exist'], ['.', 'not a file']]) {
    await expect(agent.call('artifacts.publish', { threadId, path: path! })).rejects.toThrow(reason!);
  }
  writeFileSync(join(harness.dataDir, 'huge.bin'), Buffer.alloc(ATTACHMENT_MAX_BYTES + 1));
  await expect(agent.call('artifacts.publish', { threadId, path: 'huge.bin' })).rejects.toThrow('5 MB');
});

test('publishes an empty file and refuses a thread without a turn or an archived thread', async () => {
  writeFileSync(join(harness.dataDir, 'empty.txt'), '');
  const sent = await agent.call('artifacts.publish', { threadId, path: 'empty.txt' });
  expect(sent.parts[0]).toMatchObject({ type: 'file', data: '' });
  const fresh = await echoThread(harness, client, 'fresh');
  await expect(client.call('artifacts.publish', { threadId: fresh.threadId, path: 'empty.txt' })).rejects.toThrow('with a turn');
  await client.call('threads.archive', { threadId, archived: true });
  await expect(client.call('artifacts.publish', { threadId, path: 'empty.txt' })).rejects.toThrow('active thread');
});

test('PDF links are binary tickets even when the document contains no NUL bytes', async () => {
  writeFileSync(join(harness.dataDir, 'ascii.pdf'), '%PDF-1.4\n%%EOF');
  const file = await client.call('files.read', { threadId, path: 'ascii.pdf' });
  expect(file).toMatchObject({ kind: 'binary', mime: 'application/pdf' });
});
