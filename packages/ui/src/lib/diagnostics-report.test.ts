import { afterEach, expect, test, vi } from 'vitest';
import { RpcErrorCode, type DiagnosticReportRecord, type RpcMethodName } from '@boite/contracts';
import { RpcFailure, unansweredFailure, type ClientState } from './client';
import { cleanStack, DiagnosticsReporter, REPORT_BATCH, REPORT_INTERVAL_MS, REPORT_QUEUE, startDiagnosticsReport } from './diagnostics-report';

/** A client whose answers the test decides, with the state changes a socket makes. */
class StubClient {
  state: ClientState = 'ready';
  principal = null;
  sent: DiagnosticReportRecord[][] = [];
  calls: string[] = [];
  answer: (method: string) => Promise<unknown> = async () => ({ accepted: 0 });
  #listeners = new Set<(state: ClientState) => void>();
  connect() { return Promise.resolve({} as never); }
  on() { return () => undefined; }
  close() {}
  async call(method: RpcMethodName, params: unknown): Promise<never> {
    this.calls.push(method);
    if (method === 'diagnostics.report') this.sent.push((params as { records: DiagnosticReportRecord[] }).records);
    return await this.answer(method) as never;
  }
  onState(handler: (state: ClientState) => void) { this.#listeners.add(handler); return () => this.#listeners.delete(handler); }
  become(state: ClientState) { this.state = state; for (const listener of this.#listeners) listener(state); }
}

afterEach(() => { vi.useRealTimers(); });

function timers() {
  vi.useFakeTimers();
  return { now: () => Date.now(), setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as never), setInterval: (callback: () => void, ms: number) => setInterval(callback, ms), clearInterval: (handle: unknown) => clearInterval(handle as never) };
}

test('records leave in batches of 50 every 5 s, at most 200 wait, and a repeat counts instead of queuing', async () => {
  const client = new StubClient();
  const reporter = new DiagnosticsReporter(client as never, timers());
  const stop = reporter.start();
  for (let index = 0; index < REPORT_QUEUE + 30; index += 1) reporter.push('error', 'window', 'ui.error', `error number ${index}`);
  for (let index = 0; index < 5; index += 1) reporter.push('error', 'window', 'ui.error', 'error number 229');
  expect(reporter.queued).toHaveLength(REPORT_QUEUE);
  expect(reporter.queued[0]?.message).toBe('error number 30');
  expect(reporter.queued.at(-1)?.data).toEqual({ repeats: 6 });
  expect(client.sent).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
  expect(client.sent).toHaveLength(1);
  expect(client.sent[0]).toHaveLength(REPORT_BATCH);
  await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 3);
  expect(client.sent.map(batch => batch.length)).toEqual([50, 50, 50, 50]);
  expect(reporter.queued).toHaveLength(0);
  stop();
});

test('a failed call is reported by method and code, never its parameters; a timeout says so; the report itself never is', async () => {
  const client = new StubClient();
  const reporter = new DiagnosticsReporter(client as never, timers());
  const stop = reporter.start();
  client.answer = async method => {
    if (method === 'threads.get') throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'journal read failed' });
    if (method === 'turns.start') throw unansweredFailure('turns.start');
    if (method === 'projects.add') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'bad path' });
    if (method === 'threads.list') throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'not connected' });
    throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'report broke' });
  };
  await expect(client.call('threads.get', { threadId: 'private-thread-id', secret: 'never-sent' })).rejects.toThrow();
  await expect(client.call('turns.start', { prompt: 'private prompt' })).rejects.toThrow();
  await expect(client.call('projects.add', { path: 'C:\\private' })).rejects.toThrow();
  await expect(client.call('threads.list', {})).rejects.toThrow();
  await Promise.resolve();
  expect(reporter.queued.map(record => record.event)).toEqual(['ui.rpc.failed', 'ui.rpc.timeout']);
  expect(reporter.queued[0]).toMatchObject({ level: 'error', source: 'rpc', data: { method: 'threads.get', code: RpcErrorCode.Internal } });
  expect(reporter.queued[1]?.message).toMatch(/^turns\.start got no answer from the core after/);
  expect(JSON.stringify(reporter.queued)).not.toMatch(/private|never-sent/);
  await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
  // The batch failed with an internal error: dropped, and that failure is not a new record.
  expect(client.sent).toHaveLength(1);
  expect(reporter.queued).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 4);
  expect(client.sent).toHaveLength(1);
  stop();
  // Stopped: the class's own method is back, and failures go unheard.
  expect(Object.prototype.hasOwnProperty.call(client, 'call')).toBe(false);
});

test('a method the class gets later still runs while the reporter watches calls', async () => {
  // E2E fixtures replace FakeClient.prototype.call after the store attached its client.
  class Later extends StubClient {}
  const client = new Later();
  const stop = new DiagnosticsReporter(client as never, timers()).start();
  const replaced = vi.fn(async () => 'replaced' as never);
  const before = Later.prototype.call;
  Later.prototype.call = replaced;
  try {
    expect(await client.call('threads.list', {})).toBe('replaced');
    expect(replaced).toHaveBeenCalledWith('threads.list', {}, undefined);
  } finally { Later.prototype.call = before; stop(); }
});

test('a reconnection reports the time offline, and a core without the method turns reporting off', async () => {
  const client = new StubClient();
  const reporter = new DiagnosticsReporter(client as never, timers());
  const stop = reporter.start();
  client.become('connecting');
  await vi.advanceTimersByTimeAsync(12_400);
  // Nothing leaves while the socket is away.
  expect(client.sent).toHaveLength(0);
  client.become('ready');
  expect(reporter.queued.map(record => record.event)).toEqual(['ui.disconnected', 'ui.reconnected']);
  expect(reporter.queued[1]).toMatchObject({ durationMs: 12_400, message: 'The connection to the core came back after 12.4 s offline' });
  client.answer = async () => { throw new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method diagnostics.report' }); };
  await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
  expect(client.sent).toHaveLength(1);
  expect(reporter.disabled).toBe(true);
  reporter.push('error', 'window', 'ui.error', 'later');
  await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 2);
  expect(client.sent).toHaveLength(1);
  stop();
});

test('page errors and a frozen interface go to the first machine, with the page address out of the stack', async () => {
  const fake = timers();
  const first = new StubClient();
  const second = new StubClient();
  const stopFirst = startDiagnosticsReport(first as never, fake);
  const stopSecond = startDiagnosticsReport(second as never, fake);
  const error = new TypeError('Cannot read properties of undefined');
  error.stack = `TypeError: Cannot read properties of undefined\n    at render (${location.origin}/assets/index-abc.js?v=3:12:40)`;
  window.dispatchEvent(new ErrorEvent('error', { message: error.message, error }));
  // The main thread held for 3.5 s: the one-second tick arrives 3.5 s late.
  vi.setSystemTime(Date.now() + 4_500);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
  const records = first.sent.flat();
  expect(records.map(record => record.event)).toEqual(['ui.error', 'ui.frozen']);
  expect(records[0]?.message).toBe('The interface hit an error: TypeError: Cannot read properties of undefined');
  expect(String(records[0]?.data?.stack)).toContain('/assets/index-abc.js:12:40');
  expect(String(records[0]?.data?.stack)).not.toContain(location.origin);
  expect(records[1]?.message).toMatch(/^The interface stopped responding for \d+\.\d s$/);
  expect(second.sent).toHaveLength(0);
  stopFirst();
  stopSecond();
  expect(cleanStack('x'.repeat(400), '')?.length).toBe(300);
});
