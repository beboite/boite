import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { CoreLogContext } from '@boite/contracts';
import { CodexRpc } from '../src/drivers/codex/rpc.ts';
import { MspError, MuseRpc } from '../src/drivers/muse/rpc.ts';
import { PiPeer } from '../src/drivers/pi/rpc.ts';
import { STDOUT_LINE_MAX } from '../src/drivers/lines.ts';
import type { SpawnedChild } from '../src/procs.ts';
import { logMessageOf } from '../src/log-errors.ts';

const streams: PassThrough[] = [];
afterEach(() => { for (const stream of streams.splice(0)) stream.destroy(); });

function fixture() {
  const stdout = new PassThrough(), stdin = new PassThrough();
  streams.push(stdout, stdin);
  const sent: Record<string, unknown>[] = [], received: unknown[] = [], faults: string[] = [];
  const logs: { message: string; context?: CoreLogContext }[] = [];
  stdin.on('data', (chunk: Buffer) => sent.push(JSON.parse(chunk.toString())));
  const child = { stdout, stdin } as unknown as SpawnedChild;
  const log = (_level: string, message: string, context?: CoreLogContext) => logs.push({ message, context });
  const fault = (reason: string) => faults.push(reason);
  return { child, stdout, stdin, sent, received, logs, log, fault, faults };
}

function outcome<T>(promise: Promise<T>): Promise<T | Error> {
  return Promise.race([promise.catch(error => error as Error), Bun.sleep(250).then(() => new Error('request remained pending'))]);
}

const protocols = [
  { name: 'codex', make: (f: ReturnType<typeof fixture>) => {
    const peer = new CodexRpc(f.child, { log: f.log, fault: f.fault, notification: (...args) => f.received.push(args), request: async () => 'answer' });
    return { request: () => peer.request('probe', {}), reply: { id: 1, result: 'ok' }, invalid: { method: {}, id: [] } };
  } },
  { name: 'muse', make: (f: ReturnType<typeof fixture>) => {
    const peer = new MuseRpc(f.child, { log: f.log, fault: f.fault, notification: (...args) => f.received.push(args) });
    return { request: () => peer.request('probe', {}), reply: { id: 1, result: 'ok' }, invalid: { method: {}, id: [] } };
  } },
  { name: 'pi', make: (f: ReturnType<typeof fixture>) => {
    const peer = new PiPeer(f.child, { log: f.log, fault: f.fault, event: message => f.received.push(message) });
    return { request: () => peer.command('probe'), reply: { type: 'response', id: 'boite-1', success: true }, invalid: { type: {}, id: [] } };
  } },
];

for (const protocol of protocols) describe(`${protocol.name} stdio boundary`, () => {
  test('malformed JSON values and envelope fields cannot escape or reach handlers', async () => {
    const f = fixture(), peer = protocol.make(f), pending = peer.request();
    const invalidId = protocol.name === 'pi' ? { type: 'future_event', id: {} } : { method: 'future/event', id: {} };
    expect(() => f.stdout.write(`null\nfalse\n42\n"text"\n[]\n${JSON.stringify(peer.invalid)}\n${JSON.stringify(invalidId)}\n`)).not.toThrow();
    expect(f.received).toEqual([]);
    f.stdout.write(`${JSON.stringify(peer.reply)}\n`);
    expect(await outcome(pending)).not.toBeInstanceOf(Error);
    expect(f.logs.length).toBeGreaterThan(0);
    expect(f.logs.every(log => log.context?.event === 'provider.protocolError')).toBe(true);
    expect(f.logs.some(log => log.message.includes('null') || log.message.includes('false'))).toBe(false);
  });

  test('an oversized response rejects outstanding requests and closes the transport', async () => {
    const f = fixture(), peer = protocol.make(f), pending = outcome(peer.request());
    const huge = `{"data":"${'x'.repeat(STDOUT_LINE_MAX)}"}`;
    for (let at = 0; at < huge.length; at += 64 * 1024) f.stdout.write(huge.slice(at, at + 64 * 1024));
    f.stdout.write('\n');
    expect(await pending).toEqual(expect.objectContaining({ message: expect.stringContaining('exceeded') }));
    expect(await outcome(peer.request())).toBeInstanceOf(Error);
    expect(f.logs).toEqual([expect.objectContaining({ context: expect.objectContaining({ event: 'provider.protocolError' }) })]);
    expect(f.faults).toEqual([expect.stringContaining('exceeded')]);
    f.stdout.write(`${JSON.stringify(peer.reply)}\n`);
    f.stdin.emit('error', new Error('late pipe error'));
    expect(f.received).toEqual([]);
    expect(f.faults).toHaveLength(1);
  });

  test('a failed write rejects immediately even before child exit', async () => {
    const f = fixture(), peer = protocol.make(f);
    f.stdin.write = () => { throw new Error('private pipe failure'); };
    expect(await outcome(peer.request())).toEqual(expect.objectContaining({ message: expect.stringContaining('write failed') }));
    expect(f.logs.some(log => log.message.includes('private pipe failure'))).toBe(false);
    expect(f.faults).toEqual([expect.stringContaining('write failed')]);
  });
});

test('Codex keeps missing jsonrpc responses and numeric or string incoming request ids', async () => {
  const f = fixture();
  const rpc = new CodexRpc(f.child, { log: f.log, notification: (...args) => f.received.push(args), request: async () => 'answer' });
  const pending = rpc.request('probe', {});
  f.stdout.write('{"id":1,"result":"ok"}\n{"method":"unknown/notification"}\n{"id":"server-1","method":"approval"}\n{"id":2,"method":"approval"}\n');
  expect(await pending).toBe('ok');
  await Bun.sleep(0);
  expect(f.received).toEqual([['unknown/notification', undefined]]);
  expect(f.sent.slice(1)).toEqual([{ jsonrpc: '2.0', id: 'server-1', result: 'answer' }, { jsonrpc: '2.0', id: 2, result: 'answer' }]);
});

test('Muse keeps UUIDv7 commands, MSP error data and request refusal', async () => {
  const f = fixture(), rpc = new MuseRpc(f.child, { log: f.log, notification: (...args) => f.received.push(args) });
  const pending = outcome(rpc.command('turn/start', {}));
  expect((f.sent[0]?.params as Record<string, unknown>)['commandId']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  f.stdout.write('{"id":1,"error":{"code":409,"message":"refused","data":{"kind":"busy","reason":"active"}}}\n{"method":"future/event","params":{"value":1}}\n{"id":"approval-1","method":"approval/request"}\n');
  expect(await pending).toBeInstanceOf(MspError);
  expect(await pending).toMatchObject({ method: 'turn/start', code: 409, kind: 'busy', reason: 'active' });
  expect(f.received).toEqual([['future/event', { value: 1 }]]);
  expect(f.sent[1]).toMatchObject({ id: 'approval-1', error: { code: -32601 } });
});

test('pi keeps string responses, extension events and Unicode separators with CRLF framing', async () => {
  const f = fixture(), peer = new PiPeer(f.child, { log: f.log, event: message => f.received.push(message) });
  const pending = peer.command('get_state');
  f.stdout.write('{"type":"response","id":1,"success":true}\n{"type":"extension_ui_request","id":"dialog-1","method":"future","text":"one\u2028two\u2029three"}\r\n');
  f.stdout.end('{"type":"response","id":"boite-1","success":true}');
  expect(await outcome(pending)).toMatchObject({ id: 'boite-1' });
  expect(f.received).toEqual([{ type: 'extension_ui_request', id: 'dialog-1', method: 'future', text: 'one\u2028two\u2029three' }]);
});

test('request cancellation and timeout release only that request and keep the peer usable', async () => {
  const f = fixture(), peer = new PiPeer(f.child, { log: f.log, event: message => f.received.push(message) });
  const controller = new AbortController();
  const cancelled = outcome(peer.command('get_state', {}, { signal: controller.signal }));
  controller.abort();
  expect(await cancelled).toMatchObject({ message: 'pi agent: request cancelled' });
  expect(await outcome(peer.command('get_state', {}, { timeoutMs: 1 }))).toMatchObject({ message: 'pi agent: request timed out' });
  const healthy = peer.command('get_state');
  f.stdout.write('{"type":"response","id":"boite-1","success":true}\n{"type":"response","id":"boite-3","success":true}\n');
  expect(await healthy).toMatchObject({ id: 'boite-3' });
  const count = f.sent.length;
  expect(await outcome(peer.command('get_state', {}, { signal: controller.signal }))).toMatchObject({ message: 'pi agent: request cancelled' });
  expect(f.sent).toHaveLength(count);
});

test('pipe errors and handler exceptions fail pending requests without exposing raw errors', async () => {
  const f = fixture(), peer = new PiPeer(f.child, { log: f.log, fault: f.fault, event: () => { throw new Error('private handler error'); } });
  const pending = outcome(peer.command('probe'));
  expect(() => f.stdout.write('{"type":"future_event"}\n')).not.toThrow();
  expect(await pending).toMatchObject({ message: 'pi agent: message handler failed' });
  expect(f.logs[0]?.message).toBe('pi agent: message handler failed');
  expect(f.faults).toEqual(['pi agent: message handler failed']);
  const pipe = fixture(), rpc = new CodexRpc(pipe.child, { log: pipe.log, fault: pipe.fault, notification: () => undefined, request: async () => null });
  const interrupted = outcome(rpc.request('probe', {}));
  pipe.stdin.emit('error', new Error('private pipe error'));
  expect(await interrupted).toMatchObject({ message: 'codex agent: stdin write failed' });
  expect(pipe.logs[0]?.message).toBe('codex agent: stdin write failed');
  expect(pipe.faults).toEqual(['codex agent: stdin write failed']);
});

test('exit failures preserve user messages and carry a separate diagnostic', async () => {
  const f = fixture(), peer = new PiPeer(f.child, { log: f.log, fault: f.fault, event: () => undefined });
  const pending = outcome(peer.command('probe'));
  peer.fail('private stderr for the user', 'the pi agent exited with code 1');
  const error = await pending;
  expect(error).toMatchObject({ message: 'private stderr for the user' });
  expect(logMessageOf(error)).toBe('the pi agent exited with code 1');
  f.stdin.emit('error', new Error('late teardown error'));
  expect(f.faults).toEqual([]);
});
