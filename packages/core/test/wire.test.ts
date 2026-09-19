import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageId, RpcEvents } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { isLoopbackHost, ServerConnection, staticResponse } from '../src/server.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore({});
});

afterEach(async () => {
  await harness.stop();
});

interface Sent {
  frame: { method?: string; id?: number; params?: { text?: string } };
  compressed: boolean | undefined;
}

function attached(remote: boolean): { connection: ServerConnection; sent: Sent[] } {
  const sent: Sent[] = [];
  const connection = new ServerConnection(harness.core, remote);
  connection.attach({
    send: (frame: string, compress?: boolean) => { sent.push({ frame: JSON.parse(frame), compressed: compress }); return frame.length; },
    close: () => undefined,
  } as unknown as Parameters<ServerConnection['attach']>[0]);
  return { connection, sent };
}

const delta = (text: string, messageId = 'msg_a'): RpcEvents['message.delta'] =>
  ({ threadId: 'thr_a', messageId, partIndex: 0, text }) as RpcEvents['message.delta'];

describe('what a remote client is sent', () => {
  test('only a loopback Host is local', () => {
    for (const host of ['127.0.0.1:4321', 'localhost:4321', 'LOCALHOST', '[::1]:4321', '127.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['192.0.2.7:4321', 'boite.example', 'phone.example:443', '127.0.0.1.example:80', '', null]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test('a local connection gets every delta at once and uncompressed', () => {
    const { connection, sent } = attached(false);
    connection.sendEvent('message.delta', delta('one'));
    connection.sendEvent('message.delta', delta(' two'));
    expect(sent.map((entry) => entry.frame.params?.text)).toEqual(['one', ' two']);
    expect(sent.every((entry) => entry.compressed === false)).toBe(true);
  });

  test('a remote connection holds deltas for a window, joins them per part and compresses the frame', async () => {
    const { connection, sent } = attached(true);
    connection.sendEvent('message.delta', delta('one'));
    connection.sendEvent('message.delta', delta(' two'));
    connection.sendEvent('message.delta', delta('other', 'msg_b'));
    expect(sent).toEqual([]);
    await Bun.sleep(120);
    expect(sent.map((entry) => entry.frame.params?.text)).toEqual(['one two', 'other']);
    expect(sent.every((entry) => entry.compressed === true)).toBe(true);
    connection.close(1000, 'done');
  });

  test('held deltas leave before any other event and before a response, so the order on the wire is the order of the turn', () => {
    const { connection, sent } = attached(true);
    connection.sendEvent('message.delta', delta('tail'));
    connection.sendEvent('turn.finished', { threadId: 'thr_a' } as unknown as RpcEvents['turn.finished']);
    connection.sendEvent('message.delta', delta('late'));
    connection.sendResponse({ jsonrpc: '2.0', id: 7, result: null });
    expect(sent.map((entry) => entry.frame.method ?? `response ${entry.frame.id}`)).toEqual([
      'message.delta', 'turn.finished', 'message.delta', 'response 7',
    ]);
    connection.close(1000, 'done');
  });

  test('closing drops what was held', async () => {
    const { connection, sent } = attached(true);
    connection.sendEvent('message.delta', delta('never'));
    connection.close(1000, 'gone');
    await Bun.sleep(120);
    expect(sent).toEqual([]);
  });
});

describe('static files', () => {
  test('the compressed sibling is served when the browser reads it, with the type of the original', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boite-static-'));
    try {
      const file = join(directory, 'index-ab.js');
      const body = 'export const answer = 42;\n'.repeat(80);
      writeFileSync(file, body);
      writeFileSync(`${file}.gz`, gzipSync(body));

      const gz = staticResponse(file, '/assets/index-ab.js', 'gzip, deflate, br');
      expect(gz.headers.get('content-encoding')).toBe('gzip');
      expect(gz.headers.get('content-type')).toContain('javascript');
      expect(gz.headers.get('vary')).toBe('accept-encoding');
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(body);

      // No `.br` beside it, and a client that reads nothing compressed.
      const plain = staticResponse(file, '/assets/index-ab.js', null);
      expect(plain.headers.get('content-encoding')).toBeNull();
      expect(plain.headers.get('vary')).toBe('accept-encoding');
      expect(await plain.text()).toBe(body);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('threads.get after', () => {
  async function seeded(): Promise<{ client: Awaited<ReturnType<typeof connect>>; threadId: string; ids: MessageId[] }> {
    const client = await connect(harness.url, harness.token, { client: { name: 'test', version: '0' } });
    const project = await client.call('projects.add', { path: harness.dataDir, name: 'wire' });
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    if (!account) throw new Error('no echo account');
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'resume' });
    for (const prompt of ['first', 'second', 'third']) {
      const done = client.next('turn.finished', (event) => event.threadId === thread.id, 20_000);
      await client.call('turns.start', { threadId: thread.id, prompt });
      await done;
    }
    const full = await client.call('threads.get', { threadId: thread.id });
    return { client, threadId: thread.id, ids: full.messages.map((message) => message.id) };
  }

  test('the answer starts at the named message and says so', async () => {
    const { client, threadId, ids } = await seeded();
    try {
      const anchor = ids[ids.length - 2] as MessageId;
      const tail = await client.call('threads.get', { threadId, after: anchor });
      expect(tail.messagesFrom).toBe(anchor);
      expect(tail.messages.map((message) => message.id)).toEqual(ids.slice(-2));
      expect(tail.turns.length).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  test('a message the journal does not hold gets the whole page, unmarked', async () => {
    const { client, threadId, ids } = await seeded();
    try {
      const whole = await client.call('threads.get', { threadId, after: 'msg_never_written' as MessageId });
      expect(whole.messagesFrom).toBeUndefined();
      expect(whole.messages.map((message) => message.id)).toEqual(ids);
    } finally {
      client.close();
    }
  });
});
